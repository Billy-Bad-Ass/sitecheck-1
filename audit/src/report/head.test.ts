import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { canonicalUrl, PAGES, robotsTxt, sitemapXml, socialTags } from './head';

const page = PAGES.find((p) => p.file === 'index.html')!;
const legal = PAGES.find((p) => p.file === 'legal.html')!;
const thanks = PAGES.find((p) => p.file === 'thanks.html')!;

test('with no origin, nothing is emitted at all', () => {
  // The failure this prevents is tags that exist, look configured, and point
  // at nothing — which is worse than their absence, because it looks done.
  for (const origin of [undefined, '', '   ']) {
    assert.equal(socialTags(origin, page), '');
  }
});

test('a non-https origin is refused', () => {
  // The canonical URL and the preview image are how other systems address this
  // site. Publishing them as http invites every one of those fetches to be
  // intercepted, and mixed content blocks the image anyway.
  assert.equal(socialTags('http://example.com', page), '');
});

test('the home page is the directory, not index.html', () => {
  // Two URLs for one page splits whatever ranking it earns, and the canonical
  // tag exists precisely to say which one is real.
  assert.equal(canonicalUrl('https://example.com', 'index.html'), 'https://example.com/');
  assert.equal(canonicalUrl('https://example.com/', 'index.html'), 'https://example.com/');
  assert.equal(canonicalUrl('https://example.com', 'legal.html'), 'https://example.com/legal.html');
});

test('a trailing slash on the origin never doubles up', () => {
  const tags = socialTags('https://example.com/', legal);
  assert.doesNotMatch(tags, /example\.com\/\//);
});

test('the preview image is absolute', () => {
  // Every platform that renders a link preview fetches this from its own
  // servers, where a relative path means nothing.
  const tags = socialTags('https://example.com', page);
  assert.match(tags, /content="https:\/\/example\.com\/assets\/social-card\.png"/);
});

test('the large-image card is requested explicitly', () => {
  // Without it the 1200x630 image renders as a small square thumbnail, which
  // is the entire reason for generating one.
  assert.match(socialTags('https://example.com', page), /twitter:card" content="summary_large_image"/);
});

test('the receipt page is marked noindex and kept out of the sitemap', () => {
  // Nobody should arrive at a thank-you page from a search result: it makes
  // the conversion numbers lie and it confuses the person who lands there.
  assert.match(socialTags('https://example.com', thanks), /noindex/);
  assert.doesNotMatch(sitemapXml('https://example.com'), /thanks/);
  assert.match(robotsTxt('https://example.com'), /Disallow: \/thanks\.html/);
});

test('indexable pages are not marked noindex', () => {
  assert.doesNotMatch(socialTags('https://example.com', page), /noindex/);
  assert.doesNotMatch(socialTags('https://example.com', legal), /noindex/);
});

test('the sitemap lists every indexable page and nothing else', () => {
  // Derived from PAGES rather than written out: a hardcoded list turns adding
  // a page into a failing test, which teaches whoever added it to edit the
  // expectation — and the next page that should NOT be indexed gets waved
  // through the same way.
  const xml = sitemapXml('https://example.com');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const expected = PAGES.filter((p) => p.indexable).map((p) =>
    p.file === 'index.html' ? 'https://example.com/' : `https://example.com/${p.file}`
  );
  assert.deepEqual(locs, expected);
  assert.ok(locs.includes('https://example.com/'), 'the home page is missing');
  assert.ok(!locs.some((l) => l.includes('thanks')), 'a noindex page reached the sitemap');
});

test('robots points at the sitemap', () => {
  assert.match(robotsTxt('https://example.com/'), /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
});

test('quotes in page text cannot break out of an attribute', () => {
  const tags = socialTags('https://example.com', {
    file: 'index.html',
    title: 'A "quoted" title',
    description: 'Ends with <script>',
    indexable: true,
  });
  assert.doesNotMatch(tags, /content="A "quoted"/);
  assert.match(tags, /&quot;quoted&quot;/);
  assert.match(tags, /&lt;script&gt;/);
});

test('every template page has an entry', () => {
  // A page with no entry silently gets no canonical and no preview card, and
  // the build would not complain.
  for (const file of ['index.html', 'legal.html', 'thanks.html']) {
    assert.ok(
      PAGES.some((p) => p.file === file),
      `no PAGES entry for ${file}`,
    );
  }
});
