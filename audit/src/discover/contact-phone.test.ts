import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestContactPhone, tidyPhone } from './contact-phone';

const page = (html: string) => ({ finalUrl: 'https://example.com/', html });

test('reads a tel: link however it is punctuated', () => {
  assert.equal(tidyPhone('tel:+1-703-555-0100'), '+17035550100');
  assert.equal(tidyPhone('tel:(703) 555-0100'), '+17035550100');
  assert.equal(tidyPhone('17035550100'), '+17035550100');
});

/**
 * An extension is dialled after the call connects. Keeping it produces a
 * number that is not a number, and the person ringing it hears an error tone
 * rather than the practice.
 */
test('drops an extension', () => {
  assert.equal(tidyPhone('tel:+17035550100,123'), '+17035550100');
  assert.equal(tidyPhone('tel:+17035550100;ext=9'), '+17035550100');
});

test('refuses anything that is not a dialable number', () => {
  assert.equal(tidyPhone('tel:12345'), null);
  assert.equal(tidyPhone('tel:'), null);
  assert.equal(tidyPhone('tel:+1'), null);
});

test('keeps a non-US number as written rather than assuming +1', () => {
  assert.equal(tidyPhone('tel:+442079460958'), '+442079460958');
});

/**
 * The case that decided the counting.
 *
 * A practice site puts its main line in the header and again in the footer,
 * and a fax or a direct dial once in the middle. Taking the first tel: link
 * on the page is right most of the time and silently wrong exactly when a
 * site leads with something other than the number a human answers.
 */
test('the number in the most links wins, not the first one', () => {
  const p = bestContactPhone(page(`
    <a href="tel:+17035550111">Fax</a>
    <a href="tel:+17035550100">Call us</a>
    <footer><a href="tel:+17035550100">703 555 0100</a></footer>
  `));
  assert.equal(p?.phone, '+17035550100');
  assert.equal(p?.seen, 2);
});

test('a single number is still the answer', () => {
  assert.equal(bestContactPhone(page('<a href="tel:7035550100">Call</a>'))?.phone, '+17035550100');
});

test('no tel: link means no number, not a guess from the text', () => {
  assert.equal(bestContactPhone(page('<p>Call us on 703 555 0100 today</p>')), null);
});
