/**
 * The tags that only mean anything once the site has a fixed address.
 *
 * A canonical URL, a link-preview card and a sitemap all need to state where a
 * page *is*, in absolute terms. Until a domain exists there is no honest
 * answer, so every one of these is generated only when `SITE_ORIGIN` is set
 * and omitted entirely otherwise. The alternative — emitting them with a
 * placeholder or a relative path — produces tags that are present, look
 * configured, and point at nothing.
 */

export interface PageMeta {
  /** Path from the site root, e.g. `index.html`. */
  file: string;
  title: string;
  description: string;
  /** Left out of the sitemap. Nobody should arrive at a receipt from search. */
  indexable: boolean;
}

export const PAGES: PageMeta[] = [
  {
    file: 'index.html',
    title: 'Website Health Check',
    description:
      "Find out what's quietly costing you customers. Plain English, no jargon, delivered within one working day.",
    indexable: true,
  },
  {
    file: 'legal.html',
    title: 'Terms, refunds and privacy',
    description: 'What you are buying, when we refund, and what we do with your details.',
    indexable: true,
  },
  {
    file: 'thanks.html',
    title: 'Thank you',
    description: 'Your order is in.',
    indexable: false,
  },
  // Written by build-web rather than copied from web/, so it never appears in
  // the file loop — it is here so the sitemap and the social tags know about
  // it. Indexable: it is the best answer this site has to "is it any good?",
  // and a stranger who finds it has found the product.
  {
    file: 'example-report.html',
    title: 'An example report, in full',
    description:
      'The whole thing a customer receives — every finding, what it costs them and how to fix it — on a website we invented.',
    indexable: true,
  },
];

function trimOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

/** `index.html` is the directory itself; anything else keeps its filename. */
export function canonicalUrl(origin: string, file: string): string {
  const base = trimOrigin(origin);
  return file === 'index.html' ? `${base}/` : `${base}/${file}`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Canonical, Open Graph and Twitter tags for one page.
 *
 * Returns an empty string with no origin, which is the whole point: the
 * templates carry a single token rather than half-written tags.
 */
export function socialTags(origin: string | undefined, page: PageMeta): string {
  if (!origin || trimOrigin(origin) === '') return '';
  if (!/^https:\/\//i.test(origin.trim())) return '';

  const url = canonicalUrl(origin, page.file);
  const image = `${trimOrigin(origin)}/assets/social-card.png`;
  const lines = [
    `<link rel="canonical" href="${escapeAttr(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escapeAttr(url)}">`,
    `<meta property="og:title" content="${escapeAttr(page.title)}">`,
    `<meta property="og:description" content="${escapeAttr(page.description)}">`,
    `<meta property="og:image" content="${escapeAttr(image)}">`,
    // Without this the card renders as a small thumbnail beside the text, and
    // the whole reason for generating a 1200x630 image is that it does not.
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${escapeAttr(image)}">`,
  ];
  if (!page.indexable) lines.push(`<meta name="robots" content="noindex, nofollow">`);
  return lines.join('\n');
}

export function sitemapXml(origin: string, pages: PageMeta[] = PAGES): string {
  const urls = pages
    .filter((page) => page.indexable)
    .map((page) => `  <url><loc>${escapeAttr(canonicalUrl(origin, page.file))}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * Deliberately permissive, with one exception.
 *
 * `thanks.html` is the page somebody lands on after paying. It says nothing
 * sensitive, but a receipt page in search results is a page that gets visited
 * by people who did not buy anything, and that makes the analytics lie.
 */
export function robotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    ...PAGES.filter((page) => !page.indexable).map((page) => `Disallow: /${page.file}`),
    '',
    `Sitemap: ${trimOrigin(origin)}/sitemap.xml`,
    '',
  ].join('\n');
}
