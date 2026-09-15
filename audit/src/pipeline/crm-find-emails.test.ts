import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targets, type Candidate } from './crm-find-emails';

const row = (over: Partial<Candidate>): Candidate => ({
  id: 1,
  website: 'https://example.com/',
  email: null,
  phone: null,
  status: 'prospect',
  ...over,
});

test('skips only the rows that have both an address and a number', () => {
  const out = targets([
    row({ id: 1, website: 'https://a.com/', email: 'info@a.com', phone: '+17035550100' }),
    row({ id: 2, website: 'https://b.com/', email: null, phone: null }),
    row({ id: 3, website: 'https://c.com/', email: '', phone: '' }),
  ]);
  assert.deepEqual(out.map((r) => r.id), [2, 3]);
});

/**
 * Thirty-five of the forty-nine prospects publish no email at all — they run a
 * contact form instead. Every one of them publishes a phone number. Treating a
 * row as finished the moment it has an address would leave the ones that can
 * only be phoned looking exactly like the ones that cannot be reached at all.
 */
test('a row with an address but no number is still worth looking at', () => {
  const out = targets([
    row({ id: 1, website: 'https://a.com/', email: 'info@a.com', phone: null }),
    row({ id: 2, website: 'https://b.com/', email: null, phone: '+17035550100' }),
  ]);
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
});

test('skips rows with no website to look at', () => {
  const out = targets([
    row({ id: 1, website: null }),
    row({ id: 2, website: '' }),
    row({ id: 3, website: 'https://c.com/' }),
  ]);
  assert.deepEqual(out.map((r) => r.id), [3]);
});

/**
 * The case that decided the shape of this function.
 *
 * The CRM stores whatever URL the sweep recorded, so the same practice can
 * appear twice — once as the bare domain and once as a deep link into a
 * locations page, which is exactly how livewellanimal.com is stored today.
 * Without this, one business's server gets two requests for one answer, and
 * the second write races the first over the same blank column.
 */
test('one request per site, however the URL was stored', () => {
  const out = targets([
    row({ id: 1, website: 'https://www.livewellanimal.com/our-locations/falls-church-va/' }),
    row({ id: 2, website: 'http://livewellanimal.com' }),
    row({ id: 3, website: 'https://LiveWellAnimal.com/' }),
  ]);
  assert.deepEqual(out.map((r) => r.id), [1]);
});

test('keeps genuinely different sites', () => {
  const out = targets([
    row({ id: 1, website: 'https://a.com/' }),
    row({ id: 2, website: 'https://b.com/' }),
  ]);
  assert.equal(out.length, 2);
});

/**
 * Somebody who replied "stop" is marked do-not-contact, and this step must not
 * so much as fetch their homepage again. The query excludes them too; this
 * pins the rule in code, because a rule living only in one SQL string is one
 * refactor away from being gone and the cost of losing it is contacting a
 * person who asked us not to.
 */
test('never looks at a business that asked us to stop', () => {
  const out = targets([
    row({ id: 1, website: 'https://a.com/', status: 'do-not-contact' }),
    row({ id: 2, website: 'https://b.com/', status: 'prospect' }),
  ]);
  assert.deepEqual(out.map((r) => r.id), [2]);
});
