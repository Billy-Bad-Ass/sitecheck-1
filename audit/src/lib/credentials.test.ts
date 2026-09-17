import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { looksPasted, malformedCredentials } from './credentials';

/**
 * Every setting on the audit delivery path has been set, at least once, to the
 * sentence describing where to find its value. These tests are the record of
 * what each of those pastes actually looked like.
 */

test('the real pastes are all caught', () => {
  const REAL = [
    "The audit's payment link id, starts plink_. Stripe → Payment links → open the audit one → it's in the URL.",
    'Your Resend key — from the API Keys page',
    'paste it from the dashboard',
  ];
  for (const value of REAL) assert.ok(looksPasted(value), `should reject: ${value}`);
});

test('the real credentials are not caught', () => {
  const REAL = ['sk_live_51AbCdEf', 're_AbCd1234', '0123456789abcdef0123456789abcdef', 'plink_1U7dsWR7EyLACZsr'];
  for (const value of REAL) assert.equal(looksPasted(value), null, `should accept: ${value}`);
});

test('only settings that ARE set are reported on', () => {
  // Absent is a different problem with a different remedy, and the callers
  // already say so in their own words. Reporting it twice, differently, is
  // how a person ends up chasing the wrong one.
  assert.deepEqual(malformedCredentials({}), []);
});

test('each malformed setting is named once, with its own reason', () => {
  const problems = malformedCredentials({
    STRIPE_SECRET_KEY: 'sk_live_fine',
    RESEND_API_KEY: 'Your Resend key — API Keys page',
    CLOUDFLARE_ACCOUNT_ID: 'abc123',
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /^RESEND_API_KEY contains/);
  assert.match(problems[1]!, /^CLOUDFLARE_ACCOUNT_ID is 6 characters/);
});

test('a wrong prefix is caught even when the value looks like a credential', () => {
  // A Stripe publishable key is the same shape as a secret one and has no
  // prose in it, so nothing but the prefix distinguishes them — and a
  // publishable key cannot list orders.
  const problems = malformedCredentials({ STRIPE_SECRET_KEY: 'pk_live_51AbCdEf' });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /starting sk_/);
});

test('an account id of the right length but the wrong alphabet is caught', () => {
  // 32 characters, no spaces, no prose. A length check alone waves it through.
  const problems = malformedCredentials({ CLOUDFLARE_ACCOUNT_ID: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' });
  assert.equal(problems.length, 1);
});

test('nothing reported ever contains a credential that was well-formed', () => {
  // The function exists to be printed in a public Actions log.
  const secret = 'sk_live_51NeverPrintMe';
  const problems = malformedCredentials({ STRIPE_SECRET_KEY: secret, RESEND_API_KEY: 'nope — prose' });
  for (const problem of problems) assert.doesNotMatch(problem, /NeverPrintMe/);
});

test('a correct value with a stray newline is named, not waved through', () => {
  // The one that cost an evening. Cloudflare rejected an account id that was
  // correct, because the secret kept the newline from whatever it was copied
  // out of. Masked in logs, unreadable in the settings box, and invisible to
  // every check we write — because they all trim before testing.
  const problems = malformedCredentials({ CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef\n' });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /line break or spaces around it/);
  assert.match(problems[0]!, /otherwise the right shape/, 'must not read as "your value is wrong"');
});

test('padding is reported for keys too, not just the account id', () => {
  assert.equal(malformedCredentials({ STRIPE_SECRET_KEY: ' sk_live_51AbCd ' }).length, 1);
  assert.equal(malformedCredentials({ RESEND_API_KEY: 're_AbCd1234\n' }).length, 1);
});

test('the clean values still pass', () => {
  assert.deepEqual(
    malformedCredentials({
      STRIPE_SECRET_KEY: 'sk_live_51AbCd',
      RESEND_API_KEY: 're_AbCd1234',
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    }),
    [],
  );
});

test('padding is reported once, not twice with a shape complaint', () => {
  // A padded value that is ALSO the wrong shape should say one thing. Two
  // messages about one setting sends somebody fixing the wrong half.
  const problems = malformedCredentials({ CLOUDFLARE_ACCOUNT_ID: ' abc123 ' });
  assert.equal(problems.length, 1);
});

test('an empty-after-trim value is treated as unset, not as padded', () => {
  // GitHub passes an unset variable as ''. Reporting that as "has spaces
  // around it" would be a confident answer to a question nobody asked.
  assert.deepEqual(malformedCredentials({ RESEND_API_KEY: '   ' }), []);
});

test('nothing outside r2-ledger.ts invokes wrangler directly', async () => {
  // The read went through the helper that trims the credentials; the write
  // probe called execFileSync itself and did not. Same bucket, same token,
  // same account id — one worked, the other reported "Invalid account ID",
  // and the conclusion drawn from that was that the token lacked write
  // permission. It did not.
  //
  // One file knows how to invoke wrangler. A second way to run the same tool
  // is a second set of rules to keep in step, and these two were out of step
  // from the day they were written.
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      if (path.endsWith(join('lib', 'r2-ledger.ts'))) continue;
      const source = await readFile(path, 'utf8');
      if (/['"`]wrangler['"`]/.test(source)) offenders.push(path);
    }
  };
  await walk(join(process.cwd(), 'src'));

  assert.deepEqual(offenders, [], `these invoke wrangler outside r2-ledger.ts: ${offenders.join(', ')}`);
});
