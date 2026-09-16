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

function wrangler(args: string[], input?: string): string {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    input,
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

export async function loadLedger(): Promise<Ledger> {
  try {
    const raw = wrangler(['r2', 'object', 'get', `${bucketName()}/${LEDGER_KEY}`, '--pipe', '--remote']);
    return JSON.parse(raw) as Ledger;
  } catch (error) {
    const stderrText = String((error as { stderr?: string }).stderr ?? error);
    if (isMissingObject(stderrText)) return {};
    throw new Error(
      `Could not read the fulfilment ledger from r2://${bucketName()}/${LEDGER_KEY}.\n` +
        `Refusing to continue: an unreadable ledger treated as empty would re-deliver every order.\n` +
        `Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (or wrangler login), and make sure the bucket exists:\n` +
        `  npx wrangler r2 bucket create ${bucketName()}\n` +
        `Underlying error: ${stderrText.trim().split('\n').slice(-3).join('\n')}`,
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
