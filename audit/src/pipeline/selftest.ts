import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bucketName, loadLedger } from '../lib/r2-ledger';
import { resolvePaymentLinkId, stripeClient } from '../lib/orders';
import { sendEmail } from '../lib/resend';

/**
 * Prove the delivery path works, before a paying customer is the test case.
 *
 *   npm run selftest                     check everything except sending
 *   npm run selftest -- --to me@x.com    and send one real email
 *
 * This product takes live money through a Payment Link and has no webhook:
 * polling is the entire delivery path. Every scheduled run for months reported
 * success while holding no Stripe key, because "the job did not throw" and
 * "somebody got their report" were never the same question. This asks the
 * second one.
 *
 * Four things stand between a payment and a delivered report, and each fails
 * silently in its own way:
 *
 *   1. The Stripe key      — absent, or a test key that cannot see live sales
 *   2. The payment link    — unset, so the order query refuses to run at all
 *   3. The R2 ledger       — unreadable means stop, unwritable means re-deliver
 *   4. Resend              — a valid key still bounces from an unverified domain
 *
 * Nothing here is mocked and nothing is inferred. Each check does the real
 * thing and says what came back. Exits non-zero if any of them fail, so it is
 * usable as a gate and not only as something to read.
 */

const log = (message: string) => process.stdout.write(`${message}\n`);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail.replace(/\n/g, '\n      ')}\n`);
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Errors here are deliberately long and instructional. The first three lines
  // carry the diagnosis; the rest is the remedy, which belongs in the docs and
  // not in a summary line.
  return message.trim().split('\n').slice(0, 3).join('\n');
}

/** 1. Stripe. Mode matters as much as presence: keys are per-account. */
async function checkStripe(): Promise<string | null> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    record('Stripe key', false, 'STRIPE_SECRET_KEY is not set. No payment can be seen.');
    return null;
  }
  const mode = key.startsWith('sk_live') ? 'LIVE' : 'test';
  try {
    const stripe = stripeClient(key);
    // A cheap authenticated call. Listing one session proves the key is real
    // and accepted, without reading anybody's order.
    await stripe.checkout.sessions.list({ limit: 1 });
    record('Stripe key', true, `Accepted, in ${mode} mode.`);
    if (mode === 'test') {
      log('      NOTE: a test key cannot see real payments. Live sales are invisible to it.\n');
    }
    return key;
  } catch (error) {
    record('Stripe key', false, `Stripe rejected it (${mode} mode): ${reason(error)}`);
    return null;
  }
}

/** 2. The payment link that scopes the order query to the audit product. */
async function checkPaymentLink(stripeKey: string | null): Promise<void> {
  const id = process.env.STRIPE_PAYMENT_LINK_ID?.trim();
  const url = process.env.STRIPE_PAYMENT_LINK?.trim();

  if (!id && !url) {
    record(
      'Payment link',
      false,
      'Neither STRIPE_PAYMENT_LINK_ID nor STRIPE_PAYMENT_LINK is set.\n' +
        'Orders cannot be listed: an unscoped query would sweep in the guides sales.',
    );
    return;
  }
  if (!stripeKey) {
    record('Payment link', false, 'Cannot resolve it without a working Stripe key.');
    return;
  }

  try {
    const resolved = await resolvePaymentLinkId(stripeClient(stripeKey), id || url!);
    record('Payment link', true, `Orders scope to ${resolved}.`);
  } catch (error) {
    record('Payment link', false, reason(error));
  }
}

/**
 * 3. R2, read AND write.
 *
 * Read alone is not enough, and the difference is not academic: an API token
 * with read but no write passes a read check, then fails at the last step of a
 * real delivery — after the customer's report has been built and emailed, and
 * before the ledger records it. The next run re-delivers.
 */
async function checkLedger(): Promise<void> {
  try {
    const ledger = await loadLedger();
    record('R2 ledger readable', true, `${Object.keys(ledger).length} delivered order(s) on record.`);
  } catch (error) {
    record('R2 ledger readable', false, reason(error));
    return;
  }

  const key = `selftest/probe-${Date.now()}.txt`;
  try {
    const dir = await mkdtemp(join(tmpdir(), 'selftest-'));
    const file = join(dir, 'probe.txt');
    await writeFile(file, 'Delivery path self-test. Safe to delete.\n', 'utf8');
    const run = (args: string[]) =>
      execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    run(['r2', 'object', 'put', `${bucketName()}/${key}`, '--file', file, '--content-type', 'text/plain', '--remote']);
    // Written under selftest/ and removed immediately, so a failed cleanup
    // leaves something obviously disposable rather than anything near the
    // delivered reports.
    run(['r2', 'object', 'delete', `${bucketName()}/${key}`, '--remote']);
    record('R2 ledger writable', true, 'Wrote and deleted a probe object.');
  } catch (error) {
    const stderrText = String((error as { stderr?: string }).stderr ?? error);
    record(
      'R2 ledger writable',
      false,
      'Could not write to the bucket. A delivery would email the report and then fail\n' +
        `to record it, so the next run would send it again. ${stderrText.trim().split('\n').slice(-2).join(' ')}`,
    );
  }
}

/** 4. Resend. Only an accepted send proves the sender domain is verified. */
async function checkResend(to: string | null): Promise<void> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) {
    record('Resend key', false, 'RESEND_API_KEY is not set. Reports would be built and never sent.');
    return;
  }
  if (!to) {
    record(
      'Resend key',
      true,
      'Present, but NOT proven. A key can be valid and still bounce from an\n' +
        'unverified sender domain. Re-run with --to <address> to send one real email.',
    );
    return;
  }

  const from = process.env.RESEND_FROM ?? 'BBA Network <audit@bbanetwork.org>';
  try {
    const { id } = await sendEmail({
      from,
      to,
      subject: 'Delivery path self-test',
      html:
        '<p>This is the audit delivery path testing itself.</p>' +
        '<p>If this arrived, a paying customer&rsquo;s report will arrive the same way.</p>',
      attachments: [],
    });
    record('Resend send', true, `Accepted from ${from}, message ${id}. Check it actually arrives.`);
  } catch (error) {
    record('Resend send', false, `Sending from ${from} failed: ${reason(error)}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--to');
  const to = i === -1 ? null : (argv[i + 1] ?? null);

  log('Checking the path between a payment and a delivered report.\n');

  const stripeKey = await checkStripe();
  await checkPaymentLink(stripeKey);
  await checkLedger();
  await checkResend(to);

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    log(`All ${results.length} checks passed.`);
    if (!to) log('Note: email was checked but not sent. Run with --to <address> to prove it.');
    return;
  }

  log(`${failed.length} of ${results.length} checks FAILED: ${failed.map((r) => r.name).join(', ')}`);
  log('A paid audit would not be delivered.');
  process.exitCode = 1;
}

await main();
