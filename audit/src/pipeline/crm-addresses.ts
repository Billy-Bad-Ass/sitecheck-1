/**
 * Put the sweep's contact addresses into the CRM.
 *
 * The sweep already finds businesses, audits them, and fills in an address for
 * each. All of that works. The addresses then sat in a run artifact nobody
 * downloaded, so 44 prospects reached the CRM with no way to write to them and
 * not one of them was ever contacted.
 *
 * The gap was the last hop. The artifact download redirects to an Azure blob
 * host that agent sandboxes cannot reach, so it needed a person at a terminal
 * — the bottleneck this pipeline exists to remove. Inside Actions the download
 * is native, so this runs there. See .github/workflows/crm-addresses.yml.
 *
 * It only ever fills a blank, so re-running is safe and a hand-corrected
 * address is never overwritten.
 *
 * Nothing here prints an address. This repository is public and its logs are
 * public with it. The count is the finding; the list is not. Same line the
 * sweep already takes in "Say how many, without saying what".
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { makeD1 } from '../lib/d1';

export interface CsvRow {
  name?: string;
  website?: string;
  email?: string;
  phone?: string;
  [key: string]: string | undefined;
}

/**
 * RFC 4180 enough for this file: quoted fields, and doubled quotes inside
 * them. A practice called "Britton, Brian DDS" is a real row in this data, and
 * a naive split on commas files its phone number under `email`.
 */
export function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const kept = rows.filter((r) => r.some((v) => v !== ''));
  const header = kept.shift() ?? [];
  return kept.map(
    (r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])) as CsvRow,
  );
}

/**
 * The join key between the artifact and the CRM.
 *
 * Both sides store a website, and neither agrees on the details. A trailing
 * slash, a `www.`, or a capital letter that one side kept and the other
 * dropped would match nothing at all — and the run would report a cheerful
 * zero rather than an error, which is the failure mode this whole project
 * keeps having.
 */
export function siteKey(url: string | null | undefined): string {
  return String(url ?? '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .split('/')[0] ?? '';
}

export interface CrmRow {
  id: number | string;
  website: string | null;
  email: string | null;
}

export interface Plan {
  fill: { id: string; email: string; phone: string }[];
  alreadyHad: number;
  noMatch: number;
}

/** Decide what to write. Pure, so the matching is tested without a network. */
export function planUpdates(rows: CsvRow[], clients: CrmRow[]): Plan {
  const byKey = new Map(clients.map((c) => [siteKey(c.website), c]));
  const plan: Plan = { fill: [], alreadyHad: 0, noMatch: 0 };
  for (const r of rows) {
    if (!r.email) continue;
    const client = byKey.get(siteKey(r.website));
    if (!client) {
      plan.noMatch++;
      continue;
    }
    if (client.email) {
      plan.alreadyHad++;
      continue;
    }
    plan.fill.push({ id: String(client.id), email: r.email, phone: r.phone ?? '' });
  }
  return plan;
}

/**
 * Where the artifact was unpacked.
 *
 * Not a relative path, because this runs from `audit/` while the download
 * lands at the repository root, and a relative guess resolves to a directory
 * that does not exist — which reads exactly like an empty artifact.
 */
const SWEEP = process.env.SWEEP_DIR || 'sweep';

/** Both layouts the artifact has used. */
const CSV_CANDIDATES = [join(SWEEP, 'audit/out/prospects.csv'), join(SWEEP, 'prospects.csv')];

/**
 * The drafts directory, which is where the addresses actually are.
 *
 * The sweep workflow's artifact list promises `audit/out/prospects.csv` and
 * the 24 Aug artifact does not contain it — the same broken promise
 * sweep-records.test.ts was written about. What it does contain is one draft
 * per business under `emails/`, each beginning:
 *
 *     To:      someone@example.com
 *
 * or `To:      (find their email)` when the finder came up empty. The file is
 * named after the host, which is the join key we need anyway.
 *
 * So the drafts are read as a fallback. A run whose CSV does exist still
 * prefers the CSV, because it carries phone numbers too.
 */
const DRAFT_DIRS = [join(SWEEP, 'emails'), join(SWEEP, 'audit/out/emails')];

const NO_ADDRESS = /^\(.*\)$/;

export interface DraftTally {
  rows: CsvRow[];
  drafts: number;
  placeholder: number;
  noToLine: number;
}

/**
 * Read the drafts, and count what was rejected and why.
 *
 * "0 businesses" on its own cannot tell you whether the drafts hold no
 * addresses or the reader is broken, and those need opposite fixes. The tally
 * separates them without printing a single address.
 */
export function tallyDrafts(
  dir: string,
  names: string[],
  read: (f: string) => string,
): DraftTally {
  const t: DraftTally = { rows: [], drafts: 0, placeholder: 0, noToLine: 0 };
  for (const name of names) {
    if (!name.endsWith('.txt')) continue;
    t.drafts++;
    const host = basename(name, '.txt');
    const first = read(join(dir, name)).split('\n', 1)[0] ?? '';
    const to = first.startsWith('To:') ? first.slice(3).trim() : '';
    if (!to) {
      t.noToLine++;
      continue;
    }
    if (NO_ADDRESS.test(to) || !to.includes('@')) {
      t.placeholder++;
      continue;
    }
    t.rows.push({ name: host, website: host, email: to, phone: '' });
  }
  return t;
}

export function fromDrafts(dir: string, names: string[], read: (f: string) => string): CsvRow[] {
  return tallyDrafts(dir, names, read).rows;
}

async function main(): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const database = process.env.DATABASE_ID;
  const apply = process.env.APPLY === 'true';

  if (!token || !account || !database) {
    console.error(
      '::error::CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and DATABASE_ID are all required',
    );
    process.exit(1);
  }

  const csv = CSV_CANDIDATES.find((p) => existsSync(p));
  const draftDir = DRAFT_DIRS.find((d) => existsSync(d));

  let rows: CsvRow[];
  if (csv) {
    rows = parseCsv(readFileSync(csv, 'utf8'));
    console.log(`source: ${csv}`);
  } else if (draftDir) {
    const t = tallyDrafts(draftDir, readdirSync(draftDir), (f) => readFileSync(f, 'utf8'));
    rows = t.rows;
    console.log(`source: ${draftDir} (no prospects.csv in this artifact)`);
    console.log(
      `drafts: ${t.drafts} read, ${t.rows.length} with a real address, ` +
        `${t.placeholder} still saying "find their email", ${t.noToLine} with no To: line`,
    );
    if (t.drafts > 0 && t.rows.length === 0) {
      console.log(
        '::warning::this artifact carries no addresses at all. The finder never filled them in, ' +
          'so there is nothing here to rescue before it expires — run the sweep again with ' +
          '"npm run emails" working.',
      );
    }
  } else {
    console.error(
      `::error::nothing to read — no ${CSV_CANDIDATES.join(' or ')}, and no ${DRAFT_DIRS.join(' or ')}`,
    );
    process.exit(1);
  }

  const d1 = makeD1(token, account, database);

  const withAddress = rows.filter((r) => r.email).length;
  console.log(`artifact: ${rows.length} businesses, ${withAddress} with an address`);

  const clients = await d1<CrmRow>(
    `SELECT id, website, email FROM clients WHERE website IS NOT NULL AND website <> ''`,
  );
  const reachable = clients.filter((c) => c.email).length;
  console.log(`crm: ${clients.length} rows, ${reachable} already reachable`);

  const plan = planUpdates(rows, clients);

  if (apply) {
    for (const u of plan.fill) {
      await d1(
        `UPDATE clients
            SET email = ?1,
                phone = COALESCE(NULLIF(?2, ''), phone),
                next_action = 'Send the Rent Receipt',
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ?3`,
        [u.email, u.phone, u.id],
      );
    }
  }

  console.log(apply ? 'applied' : 'DRY RUN, nothing written');
  console.log(`  filled in       ${plan.fill.length}`);
  console.log(`  already had one ${plan.alreadyHad}`);
  console.log(`  no CRM row      ${plan.noMatch}`);

  if (plan.fill.length === 0 && withAddress > 0) {
    console.log('::warning::the artifact had addresses but none matched an empty CRM row');
  }
}

if (process.argv[1]?.endsWith('crm-addresses.ts')) {
  await main();
}
