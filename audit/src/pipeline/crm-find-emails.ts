/**
 * Find contact addresses for the prospects already in the CRM.
 *
 * The gap this fills. `crm-addresses.ts` carries addresses out of a sweep's
 * artifact and into the CRM, which works — but only for businesses that sweep
 * found. The 49 prospects sitting in the CRM today came from sweeps that ran
 * on 24 August and 5 September, and the 24 August one predates the email
 * finder entirely: checked on 15 September, its artifact holds three drafts
 * and not one address. Re-running the sweep does not help either, because a
 * sweep skips every business it has already seen, so the old rows stay blank
 * however many times it runs.
 *
 * So the 49 needed a way in that starts from the CRM rather than from an
 * artifact. That is this: read the rows that have a website and no address,
 * look at those sites the same way `find-emails.ts` does, write back what it
 * finds.
 *
 * Like the loader, it only ever fills a blank — a hand-corrected address is
 * never overwritten and re-running is safe.
 *
 * Nothing here prints an address. This repository is public and its logs are
 * public with it, so an aggregated list of businesses' contact details is
 * exactly what must not end up in one. The count is the finding; a business
 * that came up empty is named with its reason, because "11 found" cannot tell
 * you which sites to look at by hand and a reason per business can.
 */
import { bestContactEmail, contactPageUrl } from '../discover/contact-email';
import { normaliseEmail } from '../discover/overpass';
import { PageFetcher, robotsAllows } from '../lib/fetch-page';
import { makeD1 } from '../lib/d1';
import { siteKey, type CrmRow } from './crm-addresses';

export interface Candidate extends CrmRow {
  name?: string | null;
}

/**
 * The rows worth looking at, one per site.
 *
 * Deduplicated by the same key the loader joins on, because two CRM rows
 * pointing at one host would otherwise fetch that host twice — and the second
 * fetch teaches us nothing while costing somebody else's server a request.
 */
export function targets(rows: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const row of rows) {
    if (!row.website) continue;
    if (row.email) continue;
    const key = siteKey(row.website);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

type Outcome =
  | { kind: 'found'; row: Candidate; email: string; where: 'homepage' | 'contact page' }
  | { kind: 'none'; row: Candidate; reason: string };

async function findFor(row: Candidate, fetcher: PageFetcher): Promise<Outcome> {
  const site = String(row.website);

  let home;
  try {
    home = await fetcher.fetchRaw(site);
  } catch (error) {
    return {
      kind: 'none',
      row,
      reason: `could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  // The same conservative reading the audit takes: a site that refuses the
  // scanner is working fine for humans, and the refusal tells us nothing.
  if (home.status === 401 || home.status === 403 || home.status === 429) {
    return { kind: 'none', row, reason: `the site blocks automated visitors (HTTP ${home.status})` };
  }
  if (home.status >= 400) return { kind: 'none', row, reason: `HTTP ${home.status}` };

  const homepage = { finalUrl: home.finalUrl, html: home.body };
  const fromHome = bestContactEmail(homepage);
  if (fromHome) return { kind: 'found', row, email: fromHome.email, where: 'homepage' };

  const next = contactPageUrl(homepage);
  if (!next) return { kind: 'none', row, reason: 'no address, and no contact page to try' };

  // The second request is the only one this step ever adds, and it still
  // honours the site's own robots.txt. A business that has asked crawlers to
  // stay out of /contact is not one to start a relationship with by ignoring
  // that.
  let origin: string;
  try {
    origin = new URL(next).origin;
  } catch {
    return { kind: 'none', row, reason: 'no address, and no contact page to try' };
  }

  const robots = await fetcher.fetchRobots(origin);
  if (!robotsAllows(robots, new URL(next).pathname)) {
    return { kind: 'none', row, reason: 'robots.txt asks us not to read the contact page' };
  }

  try {
    const contact = await fetcher.fetchRaw(next);
    if (contact.status >= 400) {
      return { kind: 'none', row, reason: `contact page answered HTTP ${contact.status}` };
    }
    const fromContact = bestContactEmail({ finalUrl: contact.finalUrl, html: contact.body });
    return fromContact
      ? { kind: 'found', row, email: fromContact.email, where: 'contact page' }
      : { kind: 'none', row, reason: 'no address on the homepage or the contact page' };
  } catch (error) {
    return {
      kind: 'none',
      row,
      reason: `contact page could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/** Run tasks with a fixed number in flight, preserving input order. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function main(): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const database = process.env.DATABASE_ID;
  const apply = process.env.APPLY === 'true';
  const limit = Number(process.env.LIMIT || '0');

  if (!token || !account || !database) {
    console.error(
      '::error::CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and DATABASE_ID are all required',
    );
    process.exit(1);
  }

  const d1 = makeD1(token, account, database);

  const rows = (await d1(
    `SELECT id, name, website, email FROM clients
      WHERE website IS NOT NULL AND website <> ''
        AND (email IS NULL OR email = '')`,
  )) as Candidate[];

  let todo = targets(rows);
  console.log(`crm: ${rows.length} rows with a site and no address, ${todo.length} to look at`);
  if (limit > 0 && todo.length > limit) {
    todo = todo.slice(0, limit);
    console.log(`limited to ${todo.length} this run`);
  }
  if (todo.length === 0) {
    console.log('nothing to do');
    return;
  }

  const fetcher = new PageFetcher({ log: () => {} });
  const outcomes = await pool(todo, 2, (row) => findFor(row, fetcher));

  const found = outcomes.filter(
    (o): o is Extract<Outcome, { kind: 'found' }> => o.kind === 'found',
  );

  let written = 0;
  if (apply) {
    for (const o of found) {
      // Through the same normaliser the OpenStreetMap tags go through, so an
      // address found on a page and one published in OSM cannot be stored in
      // two different shapes.
      const email = normaliseEmail(o.email);
      if (!email) continue;
      // The blank check is repeated in the WHERE clause rather than trusted
      // from the SELECT: minutes pass between reading and writing, and a hand
      // -entered address arriving in that window must win over a scraped one.
      await d1(
        `UPDATE clients
            SET email = ?1,
                next_action = COALESCE(NULLIF(next_action, ''), 'Send the site check'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ?2 AND (email IS NULL OR email = '')`,
        [email, String(o.row.id)],
      );
      written++;
    }
  }

  // Named without their addresses: which sites need a human is actionable,
  // and the address itself is the part that must not be published.
  for (const o of outcomes) {
    if (o.kind === 'none') console.log(`  - ${siteKey(o.row.website).padEnd(38)} ${o.reason}`);
  }
  for (const o of found) {
    console.log(`  + ${siteKey(o.row.website).padEnd(38)} address found on the ${o.where}`);
  }

  console.log('');
  console.log(apply ? `applied — ${written} written` : 'DRY RUN, nothing written');
  console.log(`  addresses found ${found.length} of ${todo.length}`);
  console.log(`  requests        ${fetcher.stats.fetched} fetched, ${fetcher.stats.cached} cached`);
}

if (process.argv[1]?.endsWith('crm-find-emails.ts')) {
  await main();
}
