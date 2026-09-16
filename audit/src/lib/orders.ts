import Stripe from 'stripe';

/**
 * Turning a Stripe payment into an order this tool can fulfil.
 *
 * The architecture is deliberately serverless: a Payment Link collects the
 * customer's website address as a custom field, and fulfilment polls Stripe
 * for completed sessions. No webhook endpoint means nothing to host, nothing
 * to keep online, and no signing secret to leak — which matters when the whole
 * operation has to run for nothing.
 *
 * The trade is that fulfilment is a command you run rather than something that
 * happens the instant they pay. For a service with a human turnaround anyway,
 * that costs nothing real.
 */

export interface Order {
  sessionId: string;
  /** The website the customer asked us to audit. */
  siteUrl: string | null;
  email: string | null;
  amountPaid: number | null;
  currency: string | null;
  paidAt: string;
  /** Anything else they typed, keyed by custom field key. */
  fields: Record<string, string>;
}

/** The custom field key the Payment Link must use for the website address. */
export const SITE_FIELD_KEYS = ['website', 'websiteaddress', 'siteurl', 'url', 'site'];

export function stripeClient(apiKey = process.env.STRIPE_SECRET_KEY): Stripe {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Use your test key (sk_test_...) until you have taken a real payment.',
    );
  }
  return new Stripe(apiKey.trim());
}

/**
 * Read the value out of a Checkout custom field.
 *
 * Written defensively on purpose: the field carries its value under a
 * different property per field type, and an unrecognised type must yield null
 * rather than "[object Object]" landing in a customer-facing report.
 */
export function customFieldValue(field: Stripe.Checkout.Session.CustomField): string | null {
  switch (field.type) {
    case 'text':
      return field.text?.value ?? null;
    case 'numeric':
      return field.numeric?.value ?? null;
    case 'dropdown':
      return field.dropdown?.value ?? null;
    default:
      return null;
  }
}

/** Pull the site to audit out of a session, tolerating how the field was named. */
export function siteUrlFrom(session: Stripe.Checkout.Session): string | null {
  const fields = session.custom_fields ?? [];

  for (const field of fields) {
    const key = field.key.toLowerCase().replace(/[^a-z]/g, '');
    if (SITE_FIELD_KEYS.includes(key)) {
      const value = customFieldValue(field);
      if (value && value.trim() !== '') return value.trim();
    }
  }

  // Fall back to any field whose value looks like a web address, so a
  // mislabelled field does not silently cost us a paying customer's order.
  for (const field of fields) {
    const value = customFieldValue(field)?.trim();
    if (value && /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(value)) return value;
  }

  return null;
}

export function toOrder(session: Stripe.Checkout.Session): Order {
  const fields: Record<string, string> = {};
  for (const field of session.custom_fields ?? []) {
    const value = customFieldValue(field);
    if (value !== null) fields[field.key] = value;
  }

  return {
    sessionId: session.id,
    siteUrl: siteUrlFrom(session),
    email: session.customer_details?.email ?? session.customer_email ?? null,
    amountPaid: session.amount_total,
    currency: session.currency,
    paidAt: new Date((session.created ?? 0) * 1000).toISOString(),
    fields,
  };
}

/** Raised when a query would sweep in products this business does not sell. */
export class UnscopedOrderQuery extends Error {
  constructor() {
    super(
      `Refusing to list orders without a payment link to scope them to.\n\n` +
        `A Stripe account can carry more than one business, and this one does:\n` +
        `the printable-guides storefront sells through the same account. An\n` +
        `unscoped query returns those sales too, and the next step after this\n` +
        `one emails every buyer a website audit they did not order.\n\n` +
        `Set STRIPE_PAYMENT_LINK_ID to the audit product's link (plink_...),\n` +
        `or pass allowEveryProduct: true if you genuinely mean every sale.\n`,
    );
    this.name = 'UnscopedOrderQuery';
  }
}

/**
 * Every paid, completed Checkout Session for the audit product.
 *
 * Filters on payment_status rather than status: a session can be "complete"
 * while payment is still pending for slower methods like bank debits, and
 * delivering work before the money clears is how you end up doing it free.
 *
 * Scoping to one payment link is required rather than optional. It was
 * optional, and that was only safe while the Stripe account sold exactly one
 * thing — an assumption nothing enforced and nothing announced when it stopped
 * being true.
 */
export async function fetchPaidOrders(
  stripe: Stripe,
  options: { paymentLinkId?: string; limit?: number; allowEveryProduct?: boolean } = {},
): Promise<Order[]> {
  const linkId = options.paymentLinkId?.trim() || process.env.STRIPE_PAYMENT_LINK_ID?.trim();
  if (!linkId && !options.allowEveryProduct) throw new UnscopedOrderQuery();

  const orders: Order[] = [];
  const params: Stripe.Checkout.SessionListParams = {
    limit: 100,
    expand: ['data.customer_details'],
  };
  if (linkId) params.payment_link = linkId;

  const max = options.limit ?? 200;

  for await (const session of stripe.checkout.sessions.list(params)) {
    if (session.payment_status !== 'paid') continue;
    orders.push(toOrder(session));
    if (orders.length >= max) break;
  }

  return orders;
}

/** Raised when the checkout URL on file matches no payment link, or several. */
export class UnresolvablePaymentLink extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvablePaymentLink';
  }
}

/**
 * Normalise a Stripe checkout URL so two spellings of the same link match.
 *
 * Trailing slashes, a `?prefilled_email=` a marketing page appended, and a
 * capitalised host are all the same link to Stripe and all different strings
 * here. The path is left case-sensitive on purpose: the link id inside it is,
 * and lowercasing it would make two genuinely different links collide.
 */
export function normaliseCheckoutUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/**
 * Find the `plink_...` id for a checkout URL.
 *
 * Exists because the id and the URL are two names for one thing, and only one
 * of them was ever written down. STRIPE_PAYMENT_LINK — the URL — is already a
 * secret here: it is what builds the buy button on the live sales page. The id
 * is what scopes the order query. Asking for it a second time, in a different
 * format, out of a dashboard, is a step that can be got wrong and a launch that
 * waits on somebody finding a settings screen on a phone.
 *
 * Deliberately strict. Zero matches throws and more than one throws, because
 * the caller's next move is emailing customers: guessing which link is the
 * audit is how a guide buyer receives a website audit. An unscoped fallback is
 * never the answer, which is why this returns a string or raises.
 */
export async function resolvePaymentLinkId(stripe: Stripe, checkoutUrl: string): Promise<string> {
  // Already an id. Callers pass whichever of the two they were given rather
  // than deciding, so accepting both is the whole point.
  const asId = checkoutUrl.trim();
  if (asId.startsWith('plink_')) return asId;

  const wanted = normaliseCheckoutUrl(asId);
  if (!wanted) {
    throw new UnresolvablePaymentLink(
      `STRIPE_PAYMENT_LINK is not a URL or a plink_ id: ${JSON.stringify(asId)}.\n` +
        `Expected the checkout link from Stripe, e.g. https://buy.stripe.com/xxxx.`,
    );
  }

  const matches: string[] = [];
  let seen = 0;
  for await (const link of stripe.paymentLinks.list({ limit: 100 })) {
    seen += 1;
    if (normaliseCheckoutUrl(link.url ?? '') === wanted) matches.push(link.id);
  }

  if (matches.length === 1) return matches[0]!;

  if (matches.length === 0) {
    throw new UnresolvablePaymentLink(
      `No payment link in this Stripe account has the URL on file.\n\n` +
        `Looked for: ${wanted}\n` +
        `Searched ${seen} payment link(s).\n\n` +
        `Two things do this. The key is a test key and the link is live (or the\n` +
        `other way round) — they are separate accounts and cannot see each\n` +
        `other. Or the link was deleted and rebuilt, in which case the sales\n` +
        `page is pointing at a dead button and that is the real problem.\n\n` +
        `Set STRIPE_PAYMENT_LINK_ID directly to skip this lookup.`,
    );
  }

  throw new UnresolvablePaymentLink(
    `${matches.length} payment links share the URL on file, so which one sells\n` +
      `the audit is a guess: ${matches.join(', ')}.\n\n` +
      `Refusing to guess — the next step after this one emails customers.\n` +
      `Set STRIPE_PAYMENT_LINK_ID to the right one.`,
  );
}
