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
