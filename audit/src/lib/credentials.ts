/**
 * Telling a credential from the instructions for finding one.
 *
 * Every setting on the audit delivery path has now been set, at least once, to
 * the sentence describing where to get its value rather than to the value. It
 * is an easy paste to make from a phone, and every error it causes names
 * something else: a character index, a connection failure, an account id that
 * is "invalid" without saying why.
 *
 * Checked by shape only. Nothing here reads, logs or returns a secret's value.
 */

/**
 * Catch a setting whose value is the instructions for finding the value.
 *
 * Not hypothetical: STRIPE_PAYMENT_LINK_ID was once set to "The audit's
 * payment link id, starts plink_. Stripe -> Payment links -> open the audit
 * one -> it's in the URL." It is an easy paste to make from a phone, and every
 * error it causes is about something else — a credential with a curly quote in
 * it surfaces as "Cannot convert argument to a ByteString", which names a
 * character index and not the setting it came from.
 *
 * Checked by shape only. Nothing here reads or prints a secret's value.
 */
export function looksPasted(value: string): string | null {
  // Smart quotes, em and en dashes, arrows — the giveaway that this came from
  // prose rather than from a dashboard's copy button. No credential contains
  // one, so finding one is conclusive rather than suggestive.
  const prose = value.match(/[\u2010-\u2015\u2018\u2019\u201C\u201D\u2192\u2013\u2014]/);
  if (prose) {
    return `contains "${prose[0]}", which no key or id does — this looks like pasted prose, not a value`;
  }
  if (/\s/.test(value.trim())) return 'contains spaces, so it is a sentence rather than a value';
  return null;
}


/** What each credential must look like, before anything is dialled. */
const SHAPES: Array<{ name: string; prefix?: string; pattern?: RegExp; expected: string }> = [
  { name: 'STRIPE_SECRET_KEY', prefix: 'sk_', expected: 'a Stripe secret key, starting sk_' },
  { name: 'RESEND_API_KEY', prefix: 're_', expected: 'a Resend key, starting re_' },
  {
    name: 'CLOUDFLARE_ACCOUNT_ID',
    pattern: /^[0-9a-f]{32}$/i,
    expected: '32 hex characters — it is in the dashboard URL, dash.cloudflare.com/<account id>/...',
  },
];

/**
 * Every credential that is set but cannot possibly work, with the reason.
 *
 * Only reports on values that ARE set: absent is a different problem with a
 * different remedy, and the callers already say so in their own words. An
 * empty list does not mean the credentials are right — it means nothing is
 * visibly wrong without spending a network call to find out.
 */
export function malformedCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  for (const shape of SHAPES) {
    const raw = env[shape.name];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (!value) continue;

    // Padding is invisible everywhere it matters. The secret is masked in
    // logs, the box it was pasted into does not read back, and every check we
    // write trims before testing — so a correct value with a newline on the
    // end looks right to us and wrong to whatever receives it. Reported
    // rather than silently tolerated, because the same value is also passed
    // to tools this repository does not control.
    if (raw !== value) {
      problems.push(
        `${shape.name} has a line break or spaces around it — the value is otherwise the right shape, ` +
          `so it was probably pasted with a stray newline`,
      );
      continue;
    }

    const pasted = looksPasted(value);
    if (pasted) {
      problems.push(`${shape.name} ${pasted}`);
      continue;
    }
    if (shape.prefix && !value.startsWith(shape.prefix)) {
      problems.push(`${shape.name} is not ${shape.expected}`);
      continue;
    }
    if (shape.pattern && !shape.pattern.test(value)) {
      problems.push(`${shape.name} is ${value.length} characters; it should be ${shape.expected}`);
    }
  }
  return problems;
}
