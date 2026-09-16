import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildReportEmail, DEFAULT_SENDER, hostOf, redactEmail } from './resend';
import { isMissingObject, wranglerCause } from './r2-ledger';

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

test('an unset Actions variable is not a sender address', () => {
  // GitHub passes `${{ vars.RESEND_FROM }}` with no variable set as '', and
  // ?? only falls through on undefined — so the default existed and was
  // unreachable from the one place it was needed. A live run built the
  // customer's report and then asked Resend to send it from nobody.
  const before = process.env['RESEND_FROM'];
  process.env['RESEND_FROM'] = '';
  try {
    const email = buildReportEmail({ to: 'a@b.com', siteUrl: 'https://x.com', reportHtml: '<p>hi</p>' });
    assert.equal(email.from, DEFAULT_SENDER);
  } finally {
    if (before === undefined) delete process.env['RESEND_FROM'];
    else process.env['RESEND_FROM'] = before;
  }
});

test('a sender that is only whitespace is not a sender either', () => {
  const before = process.env['RESEND_FROM'];
  process.env['RESEND_FROM'] = '   ';
  try {
    assert.equal(
      buildReportEmail({ to: 'a@b.com', siteUrl: 'https://x.com', reportHtml: '<p>hi</p>' }).from,
      DEFAULT_SENDER,
    );
  } finally {
    if (before === undefined) delete process.env['RESEND_FROM'];
    else process.env['RESEND_FROM'] = before;
  }
});

test('an empty reply-to is left off entirely, not sent as blank', () => {
  const before = process.env['RESEND_REPLY_TO'];
  process.env['RESEND_REPLY_TO'] = '';
  try {
    const email = buildReportEmail({ to: 'a@b.com', siteUrl: 'https://x.com', reportHtml: '<p>hi</p>' });
    assert.equal(email.reply_to, undefined);
  } finally {
    if (before === undefined) delete process.env['RESEND_REPLY_TO'];
    else process.env['RESEND_REPLY_TO'] = before;
  }
});

test('an explicit sender still wins over the default', () => {
  assert.equal(
    buildReportEmail({ to: 'a@b.com', siteUrl: 'https://x.com', reportHtml: '<p>hi</p>', from: 'X <x@y.com>' }).from,
    'X <x@y.com>',
  );
});

test('the underlying cause survives wrangler\'s log-path boilerplate', () => {
  // wrangler's last three lines are always a blank one and "Logs were written
  // to ...", so taking the tail returned the only part of the message
  // carrying no information — inside the error whose entire job is to say
  // whether the bucket is missing or the token cannot see it.
  const stderrText = [
    '\u001b[33m▲ [WARNING] Proxy environment variables detected.\u001b[0m',
    '',
    "\u001b[31m✘ [ERROR]\u001b[0m The specified bucket does not exist.",
    '',
    '🪵  Logs were written to "/root/.config/.wrangler/logs/wrangler-2026-09-16.log"',
  ].join('\n');

  const cause = wranglerCause(stderrText);
  assert.match(cause, /specified bucket does not exist/);
  assert.doesNotMatch(cause, /Logs were written to/, 'the log path says nothing');
  assert.doesNotMatch(cause, /\u001b/, 'colour codes make it unreadable wherever it lands');
});

test('a warning is not mistaken for the cause when a real error is present', () => {
  const stderrText = [
    '▲ [WARNING] Proxy environment variables detected.',
    '✘ [ERROR] Authentication error [code: 10000]',
    '🪵  Logs were written to "/tmp/x.log"',
  ].join('\n');
  assert.match(wranglerCause(stderrText), /Authentication error/);
});

test('output with nothing error-shaped still yields something sayable', () => {
  // Better a line of wrangler's own words than an empty "Underlying error:".
  assert.equal(wranglerCause('\n\n🪵  Logs were written to "/tmp/x.log"\n'), '(wrangler said nothing)');
});
