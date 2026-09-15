import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  bestContactEmail,
  contactPageUrl,
  decodeCloudflareEmail,
  deobfuscate,
  extractContactEmails,
  registrableDomain,
  tidyAddress,
} from './contact-email';

const page = (html: string, finalUrl = 'https://www.allheartdentalcare.com/') => ({
  finalUrl,
  html,
});

/* ------------------------------ the happy path ----------------------------- */

test('a mailto link on the business’s own domain is the address', () => {
  const found = bestContactEmail(
    page('<a href="mailto:info@allheartdentalcare.com">Email us</a>'),
  );
  assert.equal(found?.email, 'info@allheartdentalcare.com');
  assert.equal(found?.source, 'mailto');
});

test('a mailto keeps only the address, not the prefilled subject', () => {
  // Real form: mailto:…?subject=Website%20enquiry&body=… . Passing the whole
  // href to the mail API rejects the batch rather than the one recipient.
  const found = bestContactEmail(
    page('<a href="mailto:info@allheartdentalcare.com?subject=Hello&body=Hi%20there">Mail</a>'),
  );
  assert.equal(found?.email, 'info@allheartdentalcare.com');
});

test('an address printed as plain text is found', () => {
  const found = bestContactEmail(page('<p>Reach us at info@allheartdentalcare.com today</p>'));
  assert.equal(found?.email, 'info@allheartdentalcare.com');
  assert.equal(found?.source, 'text');
});

/* --------------------------- the junk that looks real ---------------------- */

test('a retina asset filename is not an address', () => {
  // logo@2x.png matches any naive pattern and was most of the first output.
  const found = extractContactEmails(
    page('<img src="/img/logo@2x.png"><p>see sprite@3x.webp</p>'),
  );
  assert.deepEqual(found, []);
});

test('minified JavaScript is not scanned for addresses', () => {
  // The audit's own parser keeps script bodies in .text on purpose, which is
  // right for the speed rules and would fill this with garbage.
  const found = extractContactEmails(
    page('<script>var a="tracker@analytics-vendor.com";</script><p>Welcome</p>'),
  );
  assert.deepEqual(found, []);
});

test('a Sentry key is not an address', () => {
  const found = extractContactEmails(
    page('<p>o4507.ingest.sentry.io</p><a href="mailto:o450712@ingest.sentry.io">x</a>'),
  );
  assert.deepEqual(found, []);
});

test('a placeholder from an unfinished template is refused', () => {
  for (const junk of ['you@example.com', 'name@yourdomain.com', 'test@wixpress.com']) {
    assert.deepEqual(
      extractContactEmails(page(`<a href="mailto:${junk}">Email</a>`)),
      [],
      `should refuse ${junk}`,
    );
  }
});

test('noreply@ is refused even on the right domain', () => {
  // The dangerous one: valid, deliverable-looking, and silently discards
  // everything. A list full of them looks like a successful run.
  assert.deepEqual(
    extractContactEmails(
      page('<a href="mailto:noreply@allheartdentalcare.com">Email</a>'),
    ),
    [],
  );
});

/* ----------------------- the expensive wrong recipient --------------------- */

test('the web designer’s address in the credit line is refused', () => {
  // Sending a dentist's audit to the agency that built the site is a wasted
  // send and a tip-off to a competitor that you are prospecting their client.
  const found = extractContactEmails(
    page(
      '<footer><p>Website designed by Bright Pixel — ' +
        '<a href="mailto:hello@brightpixel.studio">hello@brightpixel.studio</a></p></footer>',
    ),
  );
  assert.deepEqual(found, []);
});

test('a credit line does not suppress the business’s own address', () => {
  const found = bestContactEmail(
    page(
      '<a href="mailto:info@allheartdentalcare.com">Contact</a>' +
        '<footer>Site built by Bright Pixel</footer>',
    ),
  );
  assert.equal(found?.email, 'info@allheartdentalcare.com');
});

test('the business’s own domain outranks a third-party address', () => {
  const found = extractContactEmails(
    page(
      '<a href="mailto:accounts@someothervendor.com">Billing</a>' +
        '<a href="mailto:info@allheartdentalcare.com">Contact</a>',
    ),
  );
  assert.equal(found[0]?.email, 'info@allheartdentalcare.com');
});

test('a free-mail address is kept, because small businesses really use them', () => {
  const found = bestContactEmail(
    page('<a href="mailto:allheartdental@gmail.com">Email us</a>'),
  );
  assert.equal(found?.email, 'allheartdental@gmail.com');
  assert.match(found?.why ?? '', /free-mail/);
});

test('careers@ loses to info@ on the same site', () => {
  const found = extractContactEmails(
    page(
      '<a href="mailto:careers@allheartdentalcare.com">Jobs</a>' +
        '<a href="mailto:info@allheartdentalcare.com">Contact</a>',
    ),
  );
  assert.equal(found[0]?.email, 'info@allheartdentalcare.com');
  assert.equal(found[1]?.email, 'careers@allheartdentalcare.com');
});

/* ------------------------------- obfuscation ------------------------------- */

test('Cloudflare’s hex obfuscation is decoded', () => {
  // Without this, every Cloudflare-proxied site reports "no email" while
  // showing one to every human visitor.
  const encode = (email: string, key = 0x2a) =>
    key.toString(16).padStart(2, '0') +
    [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');

  assert.equal(
    decodeCloudflareEmail(encode('info@allheartdentalcare.com')),
    'info@allheartdentalcare.com',
  );

  const found = bestContactEmail(
    page(
      `<a class="__cf_email__" data-cfemail="${encode('info@allheartdentalcare.com')}">` +
        '[email&#160;protected]</a>',
    ),
  );
  assert.equal(found?.email, 'info@allheartdentalcare.com');
  assert.equal(found?.source, 'cloudflare');
});

test('nonsense in data-cfemail is refused rather than decoded into rubbish', () => {
  assert.equal(decodeCloudflareEmail('zzzz'), null);
  assert.equal(decodeCloudflareEmail('2a2b'), null); // decodes, but has no @
  assert.equal(decodeCloudflareEmail(''), null);
});

test('the "at" and "dot" spellings are read as an address', () => {
  assert.equal(
    deobfuscate('info [at] allheartdentalcare [dot] com'),
    'info@allheartdentalcare.com',
  );
  assert.equal(
    deobfuscate('info (at) allheartdentalcare.com'),
    'info@allheartdentalcare.com',
  );

  const found = bestContactEmail(
    page('<p>Write to info [at] allheartdentalcare [dot] com</p>'),
  );
  assert.equal(found?.email, 'info@allheartdentalcare.com');
});

test('an address hidden behind HTML entities is found', () => {
  const found = bestContactEmail(
    page('<p>info&#64;allheartdentalcare&#46;com</p>'),
  );
  assert.equal(found?.email, 'info@allheartdentalcare.com');
});

/* --------------------------------- tidying --------------------------------- */

test('surrounding punctuation is stripped', () => {
  assert.equal(tidyAddress('(info@example.co.uk)'), 'info@example.co.uk');
  assert.equal(tidyAddress('<INFO@Example.com>'), 'info@example.com');
  assert.equal(tidyAddress('info@example.com.'), 'info@example.com');
  assert.equal(tidyAddress('not an address'), null);
});

test('the same address found twice is reported once', () => {
  const found = extractContactEmails(
    page(
      '<a href="mailto:info@allheartdentalcare.com">Email</a>' +
        '<p>info@allheartdentalcare.com</p>',
    ),
  );
  assert.equal(found.length, 1);
  // Kept at the confidence of the better source, not the weaker one.
  assert.equal(found[0]?.source, 'mailto');
});

test('two adjacent tags do not fuse into an invented address', () => {
  // The bug this test was written for: reading the flattened text of
  // <td>Email</td><td>info@…</td> yields "Emailinfo@allheartdentalcare.com",
  // which is valid-looking, on the right domain, and passes every other check
  // here — so it would have been sent to.
  const found = extractContactEmails(
    page(
      '<table><tr><td>Email</td><td>info@allheartdentalcare.com</td></tr></table>',
    ),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.email, 'info@allheartdentalcare.com');
});

/* ----------------------------- domain ownership ---------------------------- */

test('a two-part suffix is not mistaken for the domain', () => {
  assert.equal(registrableDomain('www.smiles.co.uk'), 'smiles.co.uk');
  assert.equal(registrableDomain('booking.smiles.co.uk'), 'smiles.co.uk');
  assert.equal(registrableDomain('www.allheartdentalcare.com'), 'allheartdentalcare.com');
  assert.equal(registrableDomain('allheartdentalcare.com'), 'allheartdentalcare.com');
});

test('an address on a subdomain still counts as the business’s own', () => {
  const found = bestContactEmail(
    page(
      '<a href="mailto:info@smiles.co.uk">Email</a>',
      'https://www.booking.smiles.co.uk/',
    ),
  );
  assert.match(found?.why ?? '', /own domain/);
});

/* ------------------------------ the contact page --------------------------- */

test('a contact page is picked when the homepage has no address', () => {
  assert.equal(
    contactPageUrl(
      page('<a href="/about/">About</a><a href="/contact/">Contact us</a>'),
    ),
    'https://www.allheartdentalcare.com/contact/',
  );
});

test('a contact page beats an about page', () => {
  assert.equal(
    contactPageUrl(page('<a href="/about-us/">About us</a><a href="/kontakt/">Kontakt</a>')),
    'https://www.allheartdentalcare.com/kontakt/',
  );
});

test('another company’s site is never followed', () => {
  // One request per site is the whole politeness budget; wandering off-origin
  // would spend it on somebody who was never a prospect.
  assert.equal(
    contactPageUrl(page('<a href="https://facebook.com/contact">Contact</a>')),
    null,
  );
});

test('a page with nothing contact-shaped returns null rather than a guess', () => {
  assert.equal(contactPageUrl(page('<a href="/services/">Our services</a>')), null);
});

/**
 * Found in production on 15 September 2026.
 *
 * sgarlatlaw.com yielded `sgarlatlaw.@gmail.com`. It satisfied the address
 * pattern, was written into the CRM as a reachable prospect, and would have
 * bounced at Gmail the first time anyone sent to it — the exact failure this
 * module exists to prevent, since a bounce looks identical to being ignored.
 */
test('refuses a local part that opens, closes or doubles a dot', () => {
  assert.equal(tidyAddress('sgarlatlaw.@gmail.com'), null);
  assert.equal(tidyAddress('.info@example.com'), null);
  assert.equal(tidyAddress('in..fo@example.com'), null);
});

test('still keeps the dots a real address uses', () => {
  assert.equal(tidyAddress('first.last@example.com'), 'first.last@example.com');
});
