import { parse } from 'node-html-parser';

/**
 * Finds the business's own contact address on the page the audit already
 * downloaded.
 *
 * Why this exists: OpenStreetMap carries `contact:email` for almost nobody. A
 * full 42-combination sweep of Northern Virginia produced eight businesses and
 * not one address, so the whole outreach pipeline — discovery, auditing,
 * scoring, drafting — ran green and delivered nothing anyone could send. The
 * addresses were on the businesses' own websites the entire time, in pages the
 * audit had already fetched and thrown away.
 *
 * The hard part is not finding strings shaped like an address. It is refusing
 * the ones that would embarrass you:
 *
 *   - `logo@2x.png` is not an address, and neither is `@babel/core`.
 *   - `noreply@` bounces into a void, silently, which is worse than no address.
 *   - `hello@somewebdesigner.com` in the footer belongs to the agency that
 *     built the site. Sending them an audit of their own client's website is
 *     the single most expensive mistake this module can make.
 *   - Cloudflare rewrites addresses into `data-cfemail` hex. A scraper that
 *     does not decode it reports "no email" on sites that plainly show one.
 *
 * So every candidate is scored and carries a reason, and the caller can see
 * why one address won. A wrong address that nobody can explain is how a cold
 * outreach list quietly becomes a spam complaint.
 */

/** Where an address was found. Ordered by how much it can be trusted. */
export type EmailSource = 'mailto' | 'cloudflare' | 'jsonld' | 'text';

export interface ContactEmail {
  email: string;
  source: EmailSource;
  /** Higher is a better address to send a cold audit to. Negative is unusable. */
  score: number;
  /** Plain-language reason, shown in the run log so a bad pick is arguable. */
  why: string;
}

/** Just enough of a fetched page to work on, so tests need no network. */
export interface FetchedPage {
  /** URL after redirects — the address's domain is judged against this host. */
  finalUrl: string;
  html: string;
}

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

/**
 * Extensions that show up as a fake TLD.
 *
 * `logo@2x.png`, `sprite@3x.webp` and `avatar@2x.jpg` are retina asset names
 * and they match any naive address pattern. They were the majority of the junk
 * in the first version's output.
 */
const FILE_TLD = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif',
  'css', 'js', 'mjs', 'json', 'xml', 'html', 'htm', 'php', 'map',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'mp4', 'webm', 'mp3', 'wav', 'pdf', 'zip',
]);

/**
 * Local parts that are never worth writing to.
 *
 * `noreply@` is the dangerous one: it is a real, valid, deliverable-looking
 * address that silently discards everything. An outreach run that collects a
 * hundred of them looks like a success and produces no replies at all.
 */
const DEAD_LOCAL = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'nobody',
  'postmaster', 'hostmaster', 'abuse', 'mailer-daemon', 'bounce', 'bounces',
  'unsubscribe', 'notifications', 'notification', 'alerts', 'automated',
]);

/** Reaches a person who can act on a website audit. */
const GOOD_LOCAL = new Set([
  'info', 'contact', 'hello', 'hi', 'enquiries', 'enquiry', 'inquiries',
  'inquiry', 'office', 'reception', 'admin', 'mail', 'team', 'appointments',
  'frontdesk', 'front desk', 'booking', 'bookings', 'general', 'practice',
]);

/**
 * Real addresses that reach the wrong department.
 *
 * These deliver and a human reads them, so they are not rejected outright —
 * but a cold pitch to `careers@` reaches a recruiter with no budget and no
 * interest, and `privacy@` reaches somebody whose job is to be suspicious of
 * unsolicited mail.
 */
const WRONG_DESK = new Set([
  'careers', 'career', 'jobs', 'recruitment', 'hr', 'press', 'media',
  'billing', 'accounts', 'accounting', 'invoices', 'ap', 'ar',
  'privacy', 'legal', 'dpo', 'gdpr', 'compliance', 'security',
  'webmaster', 'sales', 'marketing',
]);

/** Domains that belong to a platform or a tool, never to the business. */
const NOT_THE_BUSINESS = [
  'example.com', 'example.org', 'example.net', 'domain.com', 'email.com',
  'yourdomain.com', 'yoursite.com', 'yourcompany.com', 'company.com',
  'sentry.io', 'ingest.sentry.io', 'wixpress.com', 'wix.com',
  'squarespace.com', 'wordpress.com', 'godaddy.com', 'shopify.com',
  'jsdelivr.net', 'cloudflare.com', 'googlegroups.com', 'sentry.wixpress.com',
];

/** Free mail. A small business genuinely using one is normal, not suspicious. */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'gmx.com',
]);

/**
 * Wording that marks the credit line at the bottom of a site.
 *
 * The address next to it is the web designer's, not the client's. This is the
 * check that stops an audit of a dentist's website landing in the inbox of the
 * agency that built it — which is both a wasted send and a tip-off to a
 * competitor that you are prospecting their client.
 */
const CREDIT_LINE =
  /\b(designed|developed|built|created|powered|maintained|hosted|managed)\s+(by|with)\b|\bweb\s*(site|design|master)\s+by\b|\ba\s+\w+\s+website\b/i;

/** Suffixes that are two labels long, so `example.co.uk` is the real domain. */
const TWO_LABEL_SUFFIX = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'net.nz', 'org.nz',
  'co.za', 'com.br', 'com.mx', 'co.in', 'co.jp', 'com.sg', 'com.hk',
]);

/**
 * The part of a hostname that identifies who owns it.
 *
 * Deliberately a short list rather than the full public suffix list: pulling in
 * a PSL dependency and keeping it current is real cost, and getting this
 * slightly wrong only costs a few points of score, never a wrong send. Where
 * it cannot tell, it keeps more of the host, which errs toward "different
 * owner" — the cautious direction.
 */
export function registrableDomain(host: string): string {
  const clean = host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const labels = clean.split('.');
  if (labels.length <= 2) return clean;

  const lastTwo = labels.slice(-2).join('.');
  return TWO_LABEL_SUFFIX.has(lastTwo)
    ? labels.slice(-3).join('.')
    : lastTwo;
}

/**
 * Turns the ways a site hides an address from scrapers back into an address.
 *
 * Small-business sites do this constantly and inconsistently — `info [at]
 * example [dot] com`, `info(at)example.com`, `info AT example DOT com`. A
 * human reads all of them without noticing; a plain regex reads none of them.
 */
export function deobfuscate(text: string): string {
  return text
    .replace(/&#0*64;|&#x0*40;|&commat;/gi, '@')
    .replace(/&#0*46;|&#x0*2e;|&period;/gi, '.')
    .replace(/\s*[[({<]\s*(?:at|@)\s*[\])}>]\s*/gi, '@')
    .replace(/\s+(?:at)\s+/gi, '@')
    .replace(/\s*[[({<]\s*(?:dot|punkt|period)\s*[\])}>]\s*/gi, '.')
    .replace(/\s+(?:dot)\s+/gi, '.');
}

/**
 * Undoes Cloudflare's email obfuscation.
 *
 * Cloudflare replaces every address on a proxied page with
 * `<a class="__cf_email__" data-cfemail="…">[email&#160;protected]</a>`. The
 * payload is hex; the first byte is the XOR key for the rest. Without this,
 * Cloudflare-proxied sites — a large share of any small-business list — all
 * report as having no address while showing one to every human visitor.
 */
export function decodeCloudflareEmail(payload: string): string | null {
  const hex = payload.trim().toLowerCase();
  if (!/^[0-9a-f]{4,}$/.test(hex) || hex.length % 2 !== 0) return null;

  const key = Number.parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out.includes('@') ? out : null;
}

/** Strips the decoration a scraped address arrives wrapped in. */
export function tidyAddress(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^mailto:/i, '')
    .split(/[?#]/)[0]!            // mailto:info@x.com?subject=… — drop the params
    .replace(/^[<("'\[]+/, '')
    .replace(/[>)"'\].,;:!]+$/, '')
    .trim()
    .toLowerCase();

  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(cleaned)) return null;

  // A dot cannot open or close the local part, and cannot double up. Found in
  // production: a Northern Virginia law firm's page yielded
  // `sgarlatlaw.@gmail.com`, which passed the pattern above, went into the CRM
  // as reachable, and would have bounced at Gmail the moment anyone used it.
  // Rejecting loses a probably-real address; keeping it loses the send AND
  // tells us nothing went wrong. This module already takes that trade — no
  // address is a fine answer, a plausible wrong one is not.
  const local = cleaned.split('@')[0] ?? '';
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;

  return cleaned;
}

/** Anything that is shaped like an address but is not one someone reads. */
function rejectReason(email: string): string | null {
  const [local = '', domain = ''] = email.split('@');
  const tld = domain.split('.').pop() ?? '';

  if (FILE_TLD.has(tld)) return 'an image or asset filename, not an address';
  if (/^\d+x$/.test(local)) return 'a retina asset name such as logo@2x.png';
  if (DEAD_LOCAL.has(local)) return `${local}@ is never read by a person`;
  if (NOT_THE_BUSINESS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return `${domain} belongs to a platform or a tool, not the business`;
  }
  if (/^o\d+$/.test(local) || domain.includes('ingest.sentry')) {
    return 'a Sentry error-reporting key, not an address';
  }
  if (local.length > 64 || email.length > 254) return 'too long to be a real address';
  return null;
}

interface Candidate {
  email: string;
  source: EmailSource;
  /** Text around where it was found, used to spot a designer's credit line. */
  context: string;
}

/**
 * Every address on the page, with where it came from.
 *
 * Scripts and styles are excluded from the text scan on purpose. The page is
 * re-parsed here rather than reusing the audit's parsed document, because that
 * one deliberately keeps script bodies in its text — which is right for the
 * speed rules and catastrophic here, since minified JavaScript is wall-to-wall
 * strings that match an address pattern.
 */
function collect(page: FetchedPage): Candidate[] {
  const doc = parse(page.html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: false, style: false, noscript: true, pre: true },
  });

  const found: Candidate[] = [];

  for (const a of doc.querySelectorAll('a[href^="mailto:"], a[href^="MAILTO:"]')) {
    const email = tidyAddress(decodeURIComponent(a.getAttribute('href') ?? ''));
    if (email) found.push({ email, source: 'mailto', context: contextAround(a) });
  }

  for (const el of doc.querySelectorAll('[data-cfemail]')) {
    const decoded = decodeCloudflareEmail(el.getAttribute('data-cfemail') ?? '');
    const email = decoded ? tidyAddress(decoded) : null;
    if (email) found.push({ email, source: 'cloudflare', context: contextAround(el) });
  }

  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    for (const match of script.rawText.matchAll(ADDRESS)) {
      const email = tidyAddress(match[0]);
      if (email) found.push({ email, source: 'jsonld', context: '' });
    }
  }

  const visible = deobfuscate(visibleText(doc));
  for (const match of visible.matchAll(ADDRESS)) {
    const email = tidyAddress(match[0]);
    if (!email) continue;
    const at = match.index ?? 0;
    found.push({
      email,
      source: 'text',
      context: visible.slice(Math.max(0, at - 120), at + email.length + 40),
    });
  }

  return found;
}

/**
 * The page's words, with a break wherever the markup had one.
 *
 * Reading `doc.text` instead invents addresses. `<td>Email</td><td>info@x.com</td>`
 * flattens to `Emailinfo@x.com`, which is a perfectly valid-looking address at
 * a real domain — so it survives every other check here and gets sent to. Two
 * adjacent tags are two separate runs of text and have to be kept apart.
 */
function visibleText(root: unknown): string {
  const parts: string[] = [];

  const walk = (node: unknown): void => {
    const n = node as {
      nodeType?: number;
      rawTagName?: string;
      text?: string;
      childNodes?: unknown[];
    };

    if (n.nodeType === 3) {
      parts.push(n.text ?? '');
      return;
    }
    if (n.nodeType !== 1) return;

    const tag = (n.rawTagName ?? '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return;

    for (const child of n.childNodes ?? []) walk(child);
  };

  walk(root);
  return parts.join('\n');
}

/** The visible words wrapped around an element, for judging what it belongs to. */
function contextAround(el: { parentNode?: unknown; text: string }): string {
  const parent = el.parentNode as { text?: string } | undefined;
  const grandparent = (parent as { parentNode?: { text?: string } } | undefined)?.parentNode;
  return `${grandparent?.text ?? parent?.text ?? el.text ?? ''}`.slice(0, 400);
}

/**
 * Every usable address on the page, best first.
 *
 * Returns an empty array rather than a guess when nothing survives. "No
 * address found" is a fine answer; a plausible wrong one is not, because
 * nothing downstream can tell the difference.
 */
export function extractContactEmails(page: FetchedPage): ContactEmail[] {
  let siteDomain = '';
  try {
    siteDomain = registrableDomain(new URL(page.finalUrl).hostname);
  } catch {
    siteDomain = '';
  }

  const best = new Map<string, ContactEmail>();

  for (const candidate of collect(page)) {
    const rejected = rejectReason(candidate.email);
    if (rejected) continue;

    const scored = judge(candidate, siteDomain);
    if (scored.score < 0) continue;

    const existing = best.get(scored.email);
    if (!existing || scored.score > existing.score) best.set(scored.email, scored);
  }

  return [...best.values()].sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));
}

const SOURCE_POINTS: Record<EmailSource, number> = {
  mailto: 30,
  cloudflare: 30,
  jsonld: 20,
  text: 10,
};

function judge(candidate: Candidate, siteDomain: string): ContactEmail {
  const { email, source, context } = candidate;
  const [local = '', domain = ''] = email.split('@');
  const emailDomain = registrableDomain(domain);
  const reasons: string[] = [];
  let score = SOURCE_POINTS[source];

  const sameSite = siteDomain !== '' && emailDomain === siteDomain;

  if (sameSite) {
    score += 40;
    reasons.push('on the business’s own domain');
  } else if (FREE_MAIL.has(emailDomain)) {
    score += 10;
    reasons.push('a free-mail address, which small businesses genuinely use');
  } else {
    // The expensive mistake this module exists to avoid.
    score -= 25;
    reasons.push(`on ${emailDomain}, which is not this business’s domain`);
  }

  if (!sameSite && CREDIT_LINE.test(context)) {
    return {
      email,
      source,
      score: -1,
      why: 'sits next to a "website by" credit — this is the web designer, not the business',
    };
  }

  if (GOOD_LOCAL.has(local)) {
    score += 20;
    reasons.push(`${local}@ reaches whoever handles enquiries`);
  } else if (WRONG_DESK.has(local)) {
    score -= 15;
    reasons.push(`${local}@ reaches the wrong desk for this`);
  } else {
    score += 5;
    reasons.push('looks like a named person');
  }

  return { email, source, score, why: reasons.join('; ') };
}

/** The single best address, or null when nothing on the page is worth using. */
export function bestContactEmail(page: FetchedPage): ContactEmail | null {
  return extractContactEmails(page)[0] ?? null;
}

/**
 * Paths whose page almost always carries the address the homepage omits.
 *
 * `impressum` is on the list because German and Austrian sites are legally
 * required to publish a contact address there, which makes it the single most
 * reliable page on any site that has one.
 */
const CONTACT_PATH =
  /\/(contact|contact-us|contactus|kontakt|impressum|get-in-touch|reach-us|about|about-us|team|find-us|locations?)\/?$/i;

const CONTACT_TEXT = /\b(contact|get in touch|reach us|kontakt|impressum|email us)\b/i;

/**
 * One same-origin page worth fetching when the homepage had no address.
 *
 * One, not all of them. This engine points at strangers' servers and already
 * limits itself to a single request per site; turning that into a crawl to
 * save a few minutes of a human's time is not a trade worth making, and it is
 * how a polite tool becomes a blocked one.
 */
export function contactPageUrl(page: FetchedPage): string | null {
  const doc = parse(page.html, { lowerCaseTagName: true, comment: false });

  let origin: string;
  try {
    origin = new URL(page.finalUrl).origin;
  } catch {
    return null;
  }

  const ranked: { url: string; rank: number }[] = [];

  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;

    let url: URL;
    try {
      url = new URL(href, page.finalUrl);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;

    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || url.href === page.finalUrl) continue;

    const byPath = CONTACT_PATH.test(path);
    const byText = CONTACT_TEXT.test(a.text.trim());
    if (!byPath && !byText) continue;

    // A page called "contact" beats one merely linked as "contact", and
    // "contact" beats "about" — an about page carries an address far less
    // often, so it is a last resort rather than a peer.
    const isAbout = /\/(about|about-us|team)\/?$/i.test(path);
    ranked.push({ url: url.href, rank: byPath && !isAbout ? 3 : byPath ? 1 : 2 });
  }

  ranked.sort((a, b) => b.rank - a.rank);
  return ranked[0]?.url ?? null;
}
