import { appendFile } from 'node:fs/promises';

import { loadLedger, probeBucketWrite, remedyFor, wranglerCause } from '../lib/r2-ledger';
import { resolvePaymentLinkId, stripeClient } from '../lib/orders';
import { looksPasted } from '../lib/credentials';
import { DEFAULT_SENDER, sendEmail } from '../lib/resend';

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
  const lines = message.trim().split('\n');

  // Errors here are deliberately long and instructional. The first three lines
  // carry the diagnosis and the rest is the remedy, which belongs in the docs.
  //
  // But loadLedger appends the ACTUAL error from wrangler at the very end,
  // under "Underlying error:", and that tail is the whole difference between
  // "the bucket is missing" and "this token cannot see the bucket" — two
  // problems with nothing in common except the sentence in front of them.
  // Truncating to three lines threw away the only part that says which.
  const cause = lines.findIndex((line) => /^underlying error:/i.test(line.trim()));
  const head = lines.slice(0, 3);
  if (cause === -1) return head.join('\n');
  return [...head, ...lines.slice(cause)].join('\n');
}

/** 1. Stripe. Mode matters as much as presence: keys are per-account. */
async function checkStripe(): Promise<string | null> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    record('Stripe key', false, 'STRIPE_SECRET_KEY is not set. No payment can be seen.');
    return null;
  }
  const pasted = looksPasted(key);
  if (pasted) {
    record('Stripe key', false, `STRIPE_SECRET_KEY ${pasted}.`);
    return null;
  }
  if (!key.startsWith('sk_')) {
    record('Stripe key', false, 'STRIPE_SECRET_KEY does not start with sk_, so it is not a Stripe secret key.');
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
  // Format first, and before the Stripe key is involved. A payment link check
  // that only ever says "cannot resolve without a working Stripe key" hides a
  // setting that is visibly wrong behind an unrelated failure.
  const given = id || url!;
  const pasted = looksPasted(given);
  if (pasted) {
    const name = id ? 'STRIPE_PAYMENT_LINK_ID' : 'STRIPE_PAYMENT_LINK';
    record('Payment link', false, `${name} ${pasted}.`);
    return;
  }
  if (!given.startsWith('plink_') && !/^https?:\/\//.test(given)) {
    record(
      'Payment link',
      false,
      `Expected a plink_ id or a https:// checkout URL. Got neither, so orders cannot be scoped.`,
    );
    return;
  }

  if (!stripeKey) {
    record('Payment link', false, 'Format is fine; cannot confirm it without a working Stripe key.');
    return;
  }

  try {
    const resolved = await resolvePaymentLinkId(stripeClient(stripeKey), given);
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
  // Same check as the other three credentials. Three of the four settings on
  // this path turned out to hold the instructions for finding them rather
  // than the value; leaving one unchecked is leaving one that fails silently.
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (token) {
    const pasted = looksPasted(token);
    if (pasted) {
      record('R2 ledger readable', false, `CLOUDFLARE_API_TOKEN ${pasted}.`);
      return;
    }
  }

  // The account id is a 32-character hex string and nothing else. Checked here
  // because wrangler's answer — `Invalid account ID "***"` — is masked in a
  // public log, so the one run that reported it could say the value was wrong
  // and not what was wrong with it. Naming the shape costs nothing and does
  // not print the value.
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (account && !/^[0-9a-f]{32}$/i.test(account)) {
    const pasted = looksPasted(account);
    record(
      'R2 ledger readable',
      false,
      pasted
        ? `CLOUDFLARE_ACCOUNT_ID ${pasted}.`
        : `CLOUDFLARE_ACCOUNT_ID is ${account.length} characters; an account id is 32 hex characters.\n` +
            `It is in the dashboard URL: dash.cloudflare.com/<account id>/...`,
    );
    return;
  }

  try {
    const ledger = await loadLedger();
    record('R2 ledger readable', true, `${Object.keys(ledger).length} delivered order(s) on record.`);
  } catch (error) {
    record('R2 ledger readable', false, reason(error));
    return;
  }

  try {
    await probeBucketWrite();
    record('R2 ledger writable', true, 'Wrote and deleted a probe object.');
  } catch (error) {
    const stderrText = String((error as { stderr?: string }).stderr ?? error);
    const remedy = remedyFor(stderrText);
    record(
      'R2 ledger writable',
      false,
      'Could not write to the bucket. A delivery would email the report and then fail\n' +
        'to record it, so the next run would send it again.\n' +
        (remedy ? `${remedy}\n` : '') +
        `Underlying error: ${wranglerCause(stderrText)}`,
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
  // Shape first, and BEFORE the no-address branch below. It used to come
  // after, so a run without --to reported this key as fine while holding the
  // pasted instructions — which is the whole failure this file exists to
  // catch, rebuilt inside the thing catching it. The check that only works
  // when you ask it the expensive way is not a check.
  const pasted = looksPasted(key);
  if (pasted) {
    record('Resend key', false, `RESEND_API_KEY ${pasted}.`);
    return;
  }
  if (!key.startsWith('re_')) {
    record('Resend key', false, 'RESEND_API_KEY does not start with re_, so it is not a Resend key.');
    return;
  }

  if (!to) {
    record(
      'Resend key',
      true,
      'The right shape, but NOT proven. A valid key still bounces from an\n' +
        'unverified sender domain. Re-run with --to <address> to send one real email.',
    );
    return;
  }

  // Matches buildReportEmail: an unset Actions variable arrives as '', which
  // is not a sender. Reading it any other way here would test a path that a
  // real delivery never takes.
  const from = process.env.RESEND_FROM?.trim() || DEFAULT_SENDER;
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

/**
 * A one-line verdict, written where something other than a human reading a
 * log can find it.
 *
 * The dashboard summary said "Self-test FAILED" and nothing else, which is
 * the same shape of unhelpful as the green runs this whole sequence has been
 * unpicking: true, and not enough to act on. Naming the checks means the
 * answer to "can somebody pay me?" is on the console rather than four clicks
 * into a workflow log.
 */
async function writeVerdict(line: string): Promise<void> {
  const target = process.env.GITHUB_OUTPUT;
  if (target) await appendFile(target, `verdict=${line}\n`, 'utf8');
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) await appendFile(summary, `${line}\n`, 'utf8');
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
    const proven = to ? 'including a real email sent' : 'email checked but not sent';
    log(`All ${results.length} checks passed.`);
    if (!to) log('Note: email was checked but not sent. Run with --to <address> to prove it.');
    await writeVerdict(`A paid audit would be delivered — all ${results.length} checks passed, ${proven}.`);
    return;
  }

  const names = failed.map((r) => r.name).join(', ');
  log(`${failed.length} of ${results.length} checks FAILED: ${names}`);
  log('A paid audit would not be delivered.');
  await writeVerdict(`A paid audit would NOT be delivered. Failing: ${names}.`);
  process.exitCode = 1;
}

await main();
