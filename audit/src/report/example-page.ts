import { renderReport } from './render';
import { EXAMPLE_AUDIT } from './example';

/**
 * The example report, with the one thing the real report must never carry: a
 * banner saying the business is not real.
 *
 * It goes above everything, in the same red the critical findings use, because
 * the way this document travels is somebody screenshotting the third finding —
 * and from that point on the banner is all that stands between an example and
 * a real practice's audit sitting on a marketing page.
 */
export function exampleReport(): string {
  const banner = `<div class="example-bar">
    <strong>This is an example. example-dental.com is not a real website.</strong>
    <span>It is the report a customer receives, rendered by the same template, on a
    site we invented — so we can show you a whole one without publishing somebody's
    real problems. The findings are the ones we see most often.</span>
  </div>`;
  const style = `<style>
    .example-bar { background:#b3272d; color:#fff; padding:.75rem 1rem; text-align:center;
      font-size:.875rem; line-height:1.45; }
    .example-bar strong { font-weight:700; }
    .example-bar span { display:block; opacity:.92; font-size:.8125rem; margin-top:.15rem; }
  </style>`;

  const html = renderReport(EXAMPLE_AUDIT);
  const withStyle = html.includes('</head>')
    ? html.replace('</head>', `${style}</head>`)
    : `${style}${html}`;
  const out = withStyle.includes('<body>')
    ? withStyle.replace('<body>', `<body>${banner}`)
    : `${banner}${withStyle}`;

  // Belt and braces. If the template ever stops having a <body> or a <head>
  // the fallbacks above still put the banner in, but a silent miss would put
  // an unlabelled audit of an invented business on a public page.
  if (!out.includes('example-bar')) {
    throw new Error('The example report was built without its "not a real website" banner.');
  }
  return out;
}
