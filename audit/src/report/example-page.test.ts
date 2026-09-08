import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { exampleReport } from './example-page';
import { EXAMPLE_AUDIT } from './example';
import { PAGES } from './head';

test('the example report says it is an example, above everything else', () => {
  // The way this document travels is somebody screenshotting a finding out of
  // the middle of it. From that moment the banner is the only thing between an
  // example and a real business's audit on a marketing page — so it has to be
  // present, and it has to be first.
  const html = exampleReport();
  assert.match(html, /is not a real website/);
  const banner = html.indexOf('example-bar');
  const body = html.indexOf('example-dental.com', banner + 1);
  assert.ok(banner >= 0, 'no banner at all');
  assert.ok(banner < body, 'the banner is not above the report');
});

test('the example report is the whole report, not a taster', () => {
  // The point of publishing it is answering "is it any good?", and a report
  // with the dull findings trimmed off answers a different question.
  const html = exampleReport();
  for (const finding of EXAMPLE_AUDIT.findings) {
    assert.ok(html.includes(finding.title), `${finding.ruleId} is missing from the example`);
  }
});

test('the example report is a page the site knows about', () => {
  // Without an entry it gets no canonical and no place in the sitemap, and the
  // build would not complain.
  assert.ok(
    PAGES.some((p) => p.file === 'example-report.html'),
    'example-report.html has no entry in PAGES'
  );
});
