import { parse } from 'node-html-parser';
import type { FetchedPage } from './contact-email';

/**
 * Finds the number a business actually answers, on the page the audit already
 * downloaded.
 *
 * Why this exists: filling the CRM's blank addresses on 15 September reached
 * fourteen of forty-nine prospects. The other thirty-five publish no email at
 * all — they run a contact form instead, which is a deliberate choice and not
 * something an address finder can get past. Every one of them publishes a
 * phone number, prominently, because that is how a dental practice or a law
 * firm expects to be contacted.
 *
 * So the unreachable third of the list was never unreachable. It was only
 * unreachable by email.
 *
 * Only `tel:` links are read. A bare run of digits in the page text is as
 * likely to be a licence number, an address, a price or a year, and this list
 * is dialled by a person — a wrong number wastes a call and reaches a stranger
 * who did not ask to be rung. A business that has bothered to make its number
 * tappable has told us which number it is.
 */

export interface ContactPhone {
  /** E.164 where it can be known, e.g. +17035551234. */
  phone: string;
  /** How many separate tel: links carried it. Header and footer both is good. */
  seen: number;
}

/**
 * The digits, in E.164, or null.
 *
 * A ten-digit number gets +1 because every prospect in this CRM is in Northern
 * Virginia. That assumption is written down rather than hidden: point this at
 * another country's list and it is wrong, and the fix is to pass the country
 * in rather than to guess harder.
 */
export function tidyPhone(raw: string): string | null {
  // tel:+1-703-555-0100,123 — an extension is dialled after the call connects
  // and is not part of the number.
  const head = decodeURIComponent(String(raw ?? ''))
    .replace(/^tel:/i, '')
    .split(/[,;pw]/i)[0] ?? '';

  const plus = head.trim().startsWith('+');
  const digits = head.replace(/\D/g, '');

  if (plus) {
    // 7 is the shortest national number in use anywhere; 15 is the E.164 cap.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/**
 * The number the page puts forward, or null.
 *
 * Where a page carries several, the one appearing in the most tel: links wins
 * — a main line is typically in the header and the footer, while a fax or a
 * direct dial appears once. Ties go to the first, which is the one nearest the
 * top of the page.
 */
export function bestContactPhone(page: FetchedPage): ContactPhone | null {
  const doc = parse(page.html, { lowerCaseTagName: true, comment: false });

  const counts = new Map<string, number>();
  const order: string[] = [];

  for (const a of doc.querySelectorAll('a[href^="tel:"], a[href^="TEL:"]')) {
    const phone = tidyPhone(a.getAttribute('href') ?? '');
    if (!phone) continue;
    if (!counts.has(phone)) order.push(phone);
    counts.set(phone, (counts.get(phone) ?? 0) + 1);
  }

  let best: ContactPhone | null = null;
  for (const phone of order) {
    const seen = counts.get(phone) ?? 0;
    if (!best || seen > best.seen) best = { phone, seen };
  }
  return best;
}
