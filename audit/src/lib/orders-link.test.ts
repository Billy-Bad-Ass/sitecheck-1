import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { normaliseCheckoutUrl, resolvePaymentLinkId, UnresolvablePaymentLink } from './orders';
import type Stripe from 'stripe';

/**
 * Resolving the payment link id from the checkout URL.
 *
 * The URL is the thing already written down — it is what puts the buy button
 * on the live sales page. The id is what stops the order query sweeping in the
 * printable-guides sales from the same Stripe account. These tests exist
 * because the failure mode when this is wrong is not an error: it is a guide
 * buyer receiving a website audit they never ordered.
 */
function stubLinks(links: Array<{ id: string; url: string }>): Stripe {
  return {
    paymentLinks: {
      list() {
        return {
          async *[Symbol.asyncIterator]() {
            for (const link of links) yield link;
          },
        };
      },
    },
  } as unknown as Stripe;
}

const AUDIT = { id: 'plink_audit', url: 'https://buy.stripe.com/aEU5kN0Xz9Zg1eM7ss' };
const GUIDES = { id: 'plink_guides', url: 'https://buy.stripe.com/5kA3cF7lXbHo7DacMN' };

test('the checkout URL resolves to its own link, not the other product', async () => {
  const stripe = stubLinks([GUIDES, AUDIT]);
  assert.equal(await resolvePaymentLinkId(stripe, AUDIT.url), 'plink_audit');
});

test('a plink_ id passes straight through without a lookup', async () => {
  // Callers pass whichever of the two names they were handed rather than
  // deciding which it is. Accepting both is the point of the function.
  const stripe = stubLinks([]);
  assert.equal(await resolvePaymentLinkId(stripe, '  plink_already  '), 'plink_already');
});

test('a trailing slash, a query string and a shouted host are the same link', async () => {
  const stripe = stubLinks([AUDIT]);
  const spelt = 'HTTPS://BUY.STRIPE.COM/aEU5kN0Xz9Zg1eM7ss/?prefilled_email=a%40b.com';
  assert.equal(await resolvePaymentLinkId(stripe, spelt), 'plink_audit');
});

test('the path keeps its case, so two links cannot collide', () => {
  // Link ids are case-sensitive. Lowercasing the whole URL to be forgiving
  // about the host would merge two genuinely different products.
  assert.notEqual(
    normaliseCheckoutUrl('https://buy.stripe.com/aEU5kN'),
    normaliseCheckoutUrl('https://buy.stripe.com/AEU5KN'),
  );
});

test('no match throws, naming what was searched for', async () => {
  const stripe = stubLinks([GUIDES]);
  await assert.rejects(
    () => resolvePaymentLinkId(stripe, AUDIT.url),
    (error: Error) => {
      assert.ok(error instanceof UnresolvablePaymentLink);
      assert.match(error.message, /aEU5kN0Xz9Zg1eM7ss/, 'should say what it looked for');
      assert.match(error.message, /test key/, 'should name the usual cause');
      return true;
    },
  );
});

test('two links on one URL is refused, never guessed', async () => {
  // The decisive case. Returning either one, or falling back to an unscoped
  // query, both end with somebody emailed a product they did not buy — so the
  // only safe answer is to stop and say which ids were in the running.
  const stripe = stubLinks([AUDIT, { id: 'plink_twin', url: AUDIT.url }]);
  await assert.rejects(
    () => resolvePaymentLinkId(stripe, AUDIT.url),
    (error: Error) => {
      assert.ok(error instanceof UnresolvablePaymentLink);
      assert.match(error.message, /plink_audit/);
      assert.match(error.message, /plink_twin/);
      return true;
    },
  );
});

test('a value that is neither a URL nor an id is rejected before Stripe is called', async () => {
  let called = false;
  const stripe = {
    paymentLinks: {
      list() {
        called = true;
        return { async *[Symbol.asyncIterator]() {} };
      },
    },
  } as unknown as Stripe;
  await assert.rejects(() => resolvePaymentLinkId(stripe, 'the audit one'), UnresolvablePaymentLink);
  assert.equal(called, false, 'should not have queried Stripe');
});

test('an account id that is prose, or the wrong length, is caught by shape', () => {
  // wrangler's own answer is `Invalid account ID "***"` — masked in a public
  // log, so the run that reported it could say the value was wrong and not
  // what was wrong with it. These two shapes cover both real mistakes: the
  // description pasted instead of the value, and a truncated copy.
  const ACCOUNT = /^[0-9a-f]{32}$/i;
  assert.equal(ACCOUNT.test('0123456789abcdef0123456789abcdef'), true);
  assert.equal(ACCOUNT.test('my account id is in the dashboard'), false);
  assert.equal(ACCOUNT.test('abc123'), false);
  // 32 characters but not hex — a real length with the wrong alphabet.
  assert.equal(ACCOUNT.test('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), false);
});
