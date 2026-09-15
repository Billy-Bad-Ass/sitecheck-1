import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targets, type Candidate } from './crm-find-emails';

const row = (over: Partial<Candidate>): Candidate => ({
  id: 1,
  website: 'https://example.com/',
  email: null,
  ...over,
});

test('skips rows that already have an address', () => {
  const out = targets([
    row({ id: 1, website: 'https://a.com/', email: 'info@a.com' }),
    row({ id: 2, website: 'https://b.com/', email: null }),
    row({ id: 3, website: 'https://c.com/', email: '' }),
  ]);
  assert.deepEqual(out.map((r) => r.id), [2, 3]);
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
