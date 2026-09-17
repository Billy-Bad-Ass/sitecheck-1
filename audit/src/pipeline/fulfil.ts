import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditSite } from '../lib/audit';
import { PageFetcher } from '../lib/fetch-page';
import { malformedCredentials, paddedCredentials } from '../lib/credentials';
import { fetchPaidOrders, resolvePaymentLinkId, stripeClient } from '../lib/orders';
import { archiveReport, loadLedger, saveLedger } from '../lib/r2-ledger';
import { buildReportEmail, redactEmail, sendEmail } from '../lib/resend';
import { fulfilOrders, outstandingActions, type Ledger } from './fulfil-core';

/**
 * Turn paid Stripe orders into delivered reports — and deliver them.
 *
 *   npm run fulfil -- --dry-run        see what is waiting, touch nothing
 *   npm run fulfil                     audit, email and archive every unfulfilled paid order
 *   npm run fulfil -- --session cs_x   re-run one order
 *
 * Runs on a schedule (.github/workflows/fulfil.yml) as well as by hand, which
 * changes what the ledger has to be. It records what has already been
 * delivered, so running repeatedly is safe and cannot re-audit a customer's
 * site or re-send their report — and it lives in R2, not on the filesystem,
 * because an Actions runner's filesystem is thrown away after every run and
 * this repository is public. The ledger is the source of truth for "done",
 * not Stripe: Stripe knows about payment and nothing about whether the report
 * actually got made and sent.
 *
 * "Done" means emailed. An order whose report was built but whose email
 * failed is NOT recorded, so the next run retries it rather than leaving a
 * paying customer with nothing.
 *
 * Stripe is read-only throughout — the key this needs is a restricted read
 * key, and nothing here can refund, re-price or write metadata.
 */

const OUT = join(process.cwd(), 'out');

const log = (message: string) => process.stdout.write(`${message}\n`);

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  return {
    dryRun: argv.includes('--dry-run'),
    sessionId: get('--session'),
    paymentLinkId: get('--payment-link') ?? process.env.STRIPE_PAYMENT_LINK_ID ?? undefined,
    force: argv.includes('--force'),
  };
}

/**
 * Mirror of the R2 ledger for the local dashboard (`npm run dashboard`),
 * which reads out/fulfilled.json alongside the other pipeline outputs. A
 * cache, not a record: out/ is gitignored and R2 holds the truth.
 */
async function mirrorLedgerLocally(ledger: Ledger): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'fulfilled.json'), JSON.stringify(ledger, null, 2), 'utf8');
}

/** One line for the dashboard, via the step's output. Same as the self-test. */
async function writeVerdict(line: string): Promise<void> {
  const target = process.env.GITHUB_OUTPUT;
  if (target) await appendFile(target, `verdict=${line}\n`, 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Unconfigured is an expected state before launch, not a failure: without a
  // Stripe key there are no orders to strand. Exit clean so the scheduled run
  // stays green until there is real money to be wrong about.
  if (!process.env.STRIPE_SECRET_KEY?.trim()) {
    log('STRIPE_SECRET_KEY is not set — no orders can exist yet. Nothing to do.');
    log('Set it (restricted READ scopes only) as a repo secret to arm fulfilment.');
    return;
  }

  // Stop on a credential that cannot work, before dialling anything.
  //
  // Without this the run died further in, at whichever call happened to use
  // the bad value first, and the dashboard got "Fulfilment run did not
  // complete — paid audits may be undelivered" every twenty minutes. True,
  // unactionable, and wrong in its implication: there are no paid audits to
  // be undelivered, because nothing can even read the ledger. Seventy rows a
  // day of that teaches whoever reads the dashboard to skip red rows, which
  // is what a real failure will need them not to do.
  // Said once, and never a reason to stop: every consumer here trims first.
  for (const note of paddedCredentials()) log(`  NOTE: ${note}`);

  const malformed = malformedCredentials();
  if (malformed.length > 0) {
    for (const problem of malformed) log(`  ${problem}`);
    // The reason has to reach the dashboard, not just this log. A red row
    // that does not say why is what made the previous seventy a day useless.
    await writeVerdict(`Cannot run: ${malformed.join('; ')}.`);
    throw new Error(
      `Refusing to run: ${malformed.length} setting(s) hold something that cannot be a credential. ` +
        `Nothing was queried and nothing was sent. Fix the value(s) above, then this runs itself.`,
    );
  }

  const stripe = stripeClient();
  const mode = process.env.STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'test';
  log(`Stripe mode: ${mode}\n`);

  // A half-configured run must stop before it audits anything: with a Stripe
  // key set, money can already be arriving, and a run that cannot read the
  // ledger or send email would either re-deliver everything or build reports
  // that never leave the machine.
  let ledger: Ledger;
  try {
    ledger = await loadLedger();
  } catch (error) {
    if (args.dryRun) {
      log(`WARNING: ${String(error instanceof Error ? error.message : error)}`);
      log('--dry-run: continuing with an EMPTY ledger; already-delivered orders will show as waiting.\n');
      ledger = {};
    } else {
      throw error;
    }
  }

  if (!args.dryRun && !process.env.RESEND_API_KEY?.trim()) {
    throw new Error(
      'RESEND_API_KEY is not set. Refusing to fulfil: a report that is built but never ' +
        'emailed marks nothing done and helps nobody. Set the repo secret, or use --dry-run.',
    );
  }

  // The id and the checkout URL are two names for one payment link, and only
  // the URL was ever written down here — it is the secret that builds the buy
  // button on the sales page. Rather than stall on someone copying the other
  // name out of a dashboard, ask Stripe which link that URL is.
  let paymentLinkId = args.paymentLinkId;
  if (!paymentLinkId?.trim()) {
    const checkoutUrl = process.env.STRIPE_PAYMENT_LINK?.trim();
    if (checkoutUrl) {
      paymentLinkId = await resolvePaymentLinkId(stripe, checkoutUrl);
      log(`Payment link resolved from the checkout URL on file: ${paymentLinkId}`);
    }
  }

  log('Fetching paid orders...');
  let orders = await fetchPaidOrders(stripe, { paymentLinkId });

  if (args.sessionId) orders = orders.filter((o) => o.sessionId === args.sessionId);

  const pending = args.force ? orders : orders.filter((o) => !ledger[o.sessionId]);
  const alreadyDone = orders.length - pending.length;

  log(`  ${orders.length} paid order(s), ${alreadyDone} already delivered, ${pending.length} to do\n`);

  if (pending.length === 0) {
    log('Nothing to fulfil.');
    reportUnEmailed(ledger);
    return;
  }

  // Orders with no usable address cannot be audited automatically. They are
  // reported loudly rather than skipped quietly — someone has paid, and a
  // silent skip turns that into a refund request a week later.
  const unusable = pending.filter((o) => !o.siteUrl);
  const workable = pending.filter((o) => o.siteUrl);

  if (unusable.length > 0) {
    log(`  ${unusable.length} paid order(s) have NO website address — contact these people:`);
    for (const order of unusable) {
      // Addresses are redacted because scheduled-run logs on a public
      // repository are public. The session id is enough to find the order.
      log(`    ${order.sessionId}  ${redactEmail(order.email)}  fields: ${JSON.stringify(order.fields)}`);
    }
    log('');
  }

  if (args.dryRun) {
    log('--dry-run: nothing fetched or written. Would audit:');
    for (const order of workable) log(`  ${order.siteUrl}  for ${redactEmail(order.email)}`);
    return;
  }

  const fetcher = new PageFetcher({ log });

  const result = await fulfilOrders(workable, ledger, {
    outDir: OUT,
    // A paying customer asked us to look at their own site, so robots.txt is
    // not a reason to refuse — unlike cold outreach, we are invited.
    audit: (url) => auditSite(url, { fetcher, respectRobots: false, log }),
    log,
  });

  // Deliver what was built. Archive first, then email, then persist — in that
  // order deliberately: a re-archived report overwrites itself harmlessly,
  // but a re-sent email lands in a customer's inbox twice, so the send is the
  // last thing allowed to fail before the order is recorded as done. The
  // ledger is persisted after every order, not at the end, so an interruption
  // cannot lose the record of an email that genuinely went out.
  const emailFailures: string[] = [];
  for (const entry of result.delivered) {
    try {
      entry.archivedTo = await archiveReport(
        entry.reportFile.replace(/^delivered\//, ''),
        join(OUT, entry.reportFile),
      );

      if (entry.email) {
        const html = await readFile(join(OUT, entry.reportFile), 'utf8');
        const sent = await sendEmail(buildReportEmail({ to: entry.email, siteUrl: entry.siteUrl, reportHtml: html }));
        entry.emailedAt = new Date().toISOString();
        entry.emailId = sent.id;
        log(`  emailed ${redactEmail(entry.email)} — ${entry.reportFile}`);
      } else {
        // Paid, delivered, but no address to send to. Recorded as done so the
        // site is not re-audited every ten minutes, and surfaced on every run
        // by reportUnEmailed below until a human sends it.
        entry.emailedAt = null;
        log(`  NO EMAIL on order ${entry.sessionId} — report archived, a human must deliver it`);
      }

      ledger[entry.sessionId] = entry;
      await saveLedger(ledger);
    } catch (error) {
      // Not recorded as done: the next scheduled run will retry the whole
      // order, which is the safe direction — retrying costs a duplicate
      // audit; recording a failed send costs a customer their report.
      delete ledger[entry.sessionId];
      emailFailures.push(
        `RETRYING next run: ${entry.siteUrl} for ${redactEmail(entry.email)} — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await mirrorLedgerLocally(ledger);

  const deliveredCount = result.delivered.filter((e) => ledger[e.sessionId]).length;
  log('');
  log(`Delivered ${deliveredCount} report(s).`);

  // Everything a person still owes someone who has paid, in one place. A run
  // that only logs successes leaves the failures to be remembered.
  const actions = outstandingActions(result).filter((a) => !a.startsWith('EMAIL the report'));
  const stillToDo = [...emailFailures, ...actions];
  if (stillToDo.length > 0) {
    log('');
    log('Still to do:');
    for (const action of stillToDo) log(`  ${action}`);
  }
  reportUnEmailed(ledger);

  if (emailFailures.length > 0) process.exitCode = 1;
}

/**
 * Debts the ledger already knows about, restated on every run. An order
 * recorded with emailedAt null is done in the ledger's eyes but a customer is
 * still waiting — that must not be sayable only by the run that noticed it.
 */
function reportUnEmailed(ledger: Ledger): void {
  const owed = Object.values(ledger).filter((e) => e.emailedAt === null);
  if (owed.length === 0) return;
  log('');
  log(`${owed.length} archived report(s) have never been emailed — deliver by hand:`);
  for (const e of owed) {
    log(`  ${e.sessionId}  ${e.siteUrl}  ${e.archivedTo ?? e.reportFile}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\nfulfil failed: ${String(error)}\n`);
  process.exitCode = 1;
});
