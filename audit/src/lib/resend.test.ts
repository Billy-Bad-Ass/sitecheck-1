import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildReportEmail, hostOf, redactEmail } from './resend';
import { isMissingObject } from './r2-ledger';

test('the report email attaches the report and addresses the right host', () => {
  const email = buildReportEmail({
    to: 'owner@paying-customer.com',
    siteUrl: 'https://www.paying-customer.com/',
    reportHtml: '<html>report</html>',
    from: 'BBA Network <audit@bbanetwork.org>',
  });

  assert.equal(email.to, 'owner@paying-customer.com');
  assert.match(email.subject, /paying-customer\.com/);
  assert.equal(email.attachments.length, 1);
  assert.match(email.attachments[0]!.filename, /paying-customer\.com\.html$/);
  // Base64, so the HTML survives the JSON body without escaping surprises.
  assert.equal(
    Buffer.from(email.attachments[0]!.content, 'base64').toString('utf8'),
    '<html>report</html>',
  );
});

test('a garbage site URL still yields a usable filename, not a crash', () => {
  assert.equal(hostOf('not a url at all'), 'not a url at all');
  assert.equal(hostOf('www.example.com/path'), 'example.com');
});

test('customer addresses are redacted for public logs', () => {
  // Scheduled-run logs on a public repository are public; an address in one
  // is a leak exactly like committing it.
  assert.equal(redactEmail('owner@paying-customer.com'), 'o***@paying-customer.com');
  assert.equal(redactEmail(null), '(no email)');
  assert.equal(redactEmail('nonsense'), '(malformed address)');
});

test('a missing ledger object is distinguished from an unreachable bucket', () => {
  // Load-bearing: a first run must see an empty ledger and proceed, but a
  // run that cannot reach R2 must stop — an unreadable ledger treated as
  // empty would re-email every order ever paid.
  assert.equal(isMissingObject('Failed to fetch ... - 404: Not Found'), true);
  assert.equal(isMissingObject('The specified key does not exist'), true);
  assert.equal(isMissingObject('NoSuchKey'), true);
  assert.equal(isMissingObject('Authentication error [code: 10000]'), false);
  assert.equal(isMissingObject('fetch failed: getaddrinfo ENOTFOUND'), false);
});

test('a bucket that is not there is not an empty ledger', () => {
  // These four all said "not found" or "does not exist" and all used to be
  // read as "the ledger has not been written yet". None of them means that.
  // A mistyped bucket name or a runner without wrangler on it would have
  // re-audited and re-emailed every customer who ever paid — the precise
  // outcome the function exists to prevent, reached through the wording of
  // the error rather than through its meaning.
  assert.equal(isMissingObject('The specified bucket does not exist'), false);
  assert.equal(
    isMissingObject('A request to the Cloudflare API failed. bucket not found [code: 10006]'),
    false,
  );
  assert.equal(isMissingObject('/bin/sh: 1: wrangler: not found'), false);
  assert.equal(isMissingObject('npm error could not determine executable to run'), false);
});

test('a real 404 still reads as missing, despite saying "Not Found"', () => {
  // The obvious fix for the test above — excluding anything matching
  // ": not found" — breaks this, because "404: Not Found" contains it. The
  // rule has to be that the error positively names the object, not that it
  // avoids a phrase.
  assert.equal(isMissingObject('Failed to fetch https://... - 404: Not Found'), true);
});
