import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Ledger } from '../pipeline/fulfil-core';

/**
 * The fulfilment ledger, held in R2 rather than on the filesystem.
 *
 * The ledger is the only record of which paid orders have been delivered, and
 * fulfilment now runs on a schedule in GitHub Actions — where the filesystem
 * is thrown away after every run. A ledger in `out/fulfilled.json` on a
 * runner would forget every delivery the moment the run ended, and the next
 * run would audit and email every customer again. It is also private customer
 * data (emails, sites bought), which must never live in a public repository.
 *
 * Delivered reports are archived to the same bucket, under `delivered/`, for
 * the same reason: they are the customer's paid-for property and this repo is
 * public.
 *
 * Shells out to wrangler rather than using the S3 API so it reuses whatever
 * Cloudflare auth is present (`wrangler login` locally, CLOUDFLARE_API_TOKEN
 * in Actions) — the same trade network-store-2's upload script made.
 */

export const LEDGER_KEY = 'ledger.json';

export function bucketName(): string {
  return process.env.FULFILMENT_BUCKET?.trim() || 'bba-audit-fulfilment';
}

/**
 * Credentials with the whitespace taken off.
 *
 * A GitHub secret keeps whatever was pasted into it, and a value copied out of
 * a dashboard very often arrives with a trailing newline. Nothing shows it:
 * the value is masked in logs, `.trim()` in our own checks hides it from us
 * too, and the only symptom is Cloudflare rejecting an account id that is
 * correct — the error even comes back with its quote unclosed, because the
 * newline is inside it.
 *
 * Whitespace around a credential is never meaningful, so this strips it rather
 * than making somebody find an invisible character in a box they cannot read
 * back. Only these two are touched: everything else in the environment is
 * passed through untouched.
 */
function wranglerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    const value = env[name];
    if (typeof value === 'string') env[name] = value.trim();
  }
  return env;
}

function wrangler(args: string[], input?: string): string {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    input,
    env: wranglerEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Distinguishes "the object is not there yet" from every other failure.
 *
 * The distinction is load-bearing: a first run against a fresh bucket must
 * see an empty ledger and proceed, but a run that cannot reach R2 at all must
 * stop — treating an unreadable ledger as empty would re-deliver (and
 * re-email) every order ever paid.
 */
export function isMissingObject(stderrText: string): boolean {
  // Two classes of failure also say "not found" or "does not exist", and both
  // used to land here — which is the re-delivery the paragraph above forbids,
  // reached by the one route nothing was watching:
  //
  //   a missing or mistyped BUCKET   — "The specified bucket does not exist"
  //   a broken TOOLCHAIN             — "wrangler: not found" from the shell
  //
  // Neither means the ledger is absent. Both mean we cannot see it, and a
  // typo in a bucket name would have re-audited and re-emailed every customer
  // who ever paid. Disqualified before anything else is considered.
  if (/bucket/i.test(stderrText)) return false;

  // The error has to positively say THIS OBJECT is absent. A bare "not found"
  // is not enough — it is the most common substring in the whole error
  // surface, shell and HTTP alike, and the default when this is wrong has to
  // be to stop. Nothing a broken toolchain prints carries one of these.
  return /nosuchkey|specified key does not exist|\b404\b/i.test(stderrText);
}

/**
 * The part of wrangler's output that says what actually went wrong.
 *
 * Its last three lines are always a blank line and "Logs were written to
 * /root/.config/.wrangler/logs/...", so taking the tail reliably returned the
 * one part of the message carrying no information — and the difference
 * between "that bucket does not exist" and "this token cannot see it" was
 * dropped every time, in the error whose whole job is to say which.
 *
 * ANSI colour codes are stripped because wrangler emits them even when not on
 * a terminal, and they make the result unreadable wherever it is printed.
 */
export function wranglerCause(stderrText: string): string {
  const lines = stderrText
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !/^🪵/.test(line))
    .filter((line) => !/logs were written to/i.test(line));

  const errors = lines.filter((line) => /error|✘|refus|denied|not found|does not exist/i.test(line));
  const chosen = errors.length > 0 ? errors : lines;
  return chosen.slice(-3).join('\n') || '(wrangler said nothing)';
}

/**
 * Turn Cloudflare's answer into the thing to go and change.
 *
 * Three failures reach this code and they read almost identically — all three
 * arrive as a wall of wrangler output with an HTTP status in it — while having
 * nothing in common as remedies. The generic advice ("set the token, set the
 * account id, create the bucket") lists all three at once, which is how an
 * evening goes on a missing bucket that already existed and an account id that
 * was already right.
 */
export function remedyFor(stderrText: string): string | null {
  const cause = wranglerCause(stderrText);

  // A 403 with code 10000 on an /r2/ path means the account id and the token
  // were both accepted and the token simply is not allowed to touch R2. It is
  // one permission on one token, and nothing about the bucket or the id.
  if (/\b403\b|authentication error|code.{0,3}10000/i.test(cause)) {
    return (
      'The account and token were both accepted; the token is not permitted to use R2.\n' +
      'Add "Workers R2 Storage: Edit" to the token in Cloudflare > Manage Account >\n' +
      'Account API Tokens, or issue a new token with it. Nothing about the bucket or\n' +
      'the account id needs changing.'
    );
  }

  if (/invalid account id/i.test(cause)) {
    return (
      'Cloudflare does not recognise CLOUDFLARE_ACCOUNT_ID. It is 32 hex characters and\n' +
      'appears in the dashboard URL. A value that looks right can still fail this way if\n' +
      'it was pasted with a line break on the end.'
    );
  }

  if (/bucket/i.test(cause) && /not (found|exist)|does not exist|404/i.test(cause)) {
    return `The bucket does not exist. Create it: npx wrangler r2 bucket create ${bucketName()}`;
  }

  return null;
}

export async function loadLedger(): Promise<Ledger> {
  try {
    const raw = wrangler(['r2', 'object', 'get', `${bucketName()}/${LEDGER_KEY}`, '--pipe', '--remote']);
    return JSON.parse(raw) as Ledger;
  } catch (error) {
    const stderrText = String((error as { stderr?: string }).stderr ?? error);
    if (isMissingObject(stderrText)) return {};
    const remedy =
      remedyFor(stderrText) ??
      `Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (or wrangler login), and make sure the bucket exists:\n` +
        `  npx wrangler r2 bucket create ${bucketName()}`;
    throw new Error(
      `Could not read the fulfilment ledger from r2://${bucketName()}/${LEDGER_KEY}.\n` +
        `Refusing to continue: an unreadable ledger treated as empty would re-deliver every order.\n` +
        `${remedy}\n` +
        `Underlying error: ${wranglerCause(stderrText)}`,
    );
  }
}

export async function saveLedger(ledger: Ledger): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  const file = join(dir, LEDGER_KEY);
  await writeFile(file, JSON.stringify(ledger, null, 2), 'utf8');
  wrangler([
    'r2', 'object', 'put', `${bucketName()}/${LEDGER_KEY}`,
    '--file', file,
    '--content-type', 'application/json',
    '--remote',
  ]);
}

/**
 * Prove the bucket is writable, and leave nothing behind.
 *
 * Lives here rather than in the caller because this is the only file that
 * knows how to invoke wrangler — which includes knowing that the credentials
 * have to be trimmed first. The self-test had its own copy calling
 * execFileSync directly, so the read went through the trimming and the write
 * did not: same bucket, same token, same account id, one working and one
 * reporting "Invalid account ID". A second way to run the same tool is a
 * second set of rules to keep in step, and these two were already out of step
 * the day they were written.
 *
 * Write permission is checked separately from read for a reason. A token that
 * can read and not write passes a read check, then fails at the last step of a
 * real delivery — after the customer's report has been emailed and before the
 * ledger records it — so the next run sends it again.
 */
export async function probeBucketWrite(): Promise<void> {
  const key = `selftest/probe-${Date.now()}.txt`;
  const dir = await mkdtemp(join(tmpdir(), 'selftest-'));
  const file = join(dir, 'probe.txt');
  await writeFile(file, 'Delivery path self-test. Safe to delete.\n', 'utf8');

  wrangler(['r2', 'object', 'put', `${bucketName()}/${key}`, '--file', file, '--content-type', 'text/plain', '--remote']);
  // Written under selftest/ and removed immediately, so a failed cleanup
  // leaves something obviously disposable rather than anything near the
  // delivered reports.
  wrangler(['r2', 'object', 'delete', `${bucketName()}/${key}`, '--remote']);
}

/** Archives a delivered report under delivered/, never into the repository. */
export async function archiveReport(fileName: string, localPath: string): Promise<string> {
  const key = `delivered/${fileName}`;
  wrangler([
    'r2', 'object', 'put', `${bucketName()}/${key}`,
    '--file', localPath,
    '--content-type', 'text/html',
    '--remote',
  ]);
  return key;
}
