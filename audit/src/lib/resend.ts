/**
 * Sends a delivered report to the customer through Resend.
 *
 * Fulfilment used to end with "EMAIL the report to ..." in a log — the report
 * existed but never left the machine, and the promise on the sales page is
 * delivery within a working day. This is the sending half.
 *
 * The report goes as an HTML attachment rather than a link: there is nothing
 * to host, nothing that can expire, and the customer keeps their copy without
 * this system needing to stay online — the same reasoning that made
 * fulfilment poll Stripe instead of hosting a webhook.
 */

export interface ReportEmail {
  from: string;
  to: string;
  reply_to?: string;
  subject: string;
  html: string;
  attachments: Array<{ filename: string; content: string }>;
}

export interface ReportEmailInput {
  to: string;
  siteUrl: string;
  reportHtml: string;
  from?: string;
  replyTo?: string;
}

/** The sender to use when nothing has overridden it. */
export const DEFAULT_SENDER = 'BBA Network <audit@bbanetwork.org>';

/**
 * A setting that is present but empty is not a setting.
 *
 * `??` only falls through on undefined, and GitHub Actions passes an unset
 * repository variable as the empty string — so `RESEND_FROM: ${{ vars.X }}`
 * with no X set produced `from: ''` and a report that Resend rejected. The
 * default existed and was unreachable from the one place it was needed.
 */
function setting(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Pure builder, split from the send so the payload can be tested offline. */
export function buildReportEmail(input: ReportEmailInput): ReportEmail {
  const host = hostOf(input.siteUrl);
  const email: ReportEmail = {
    from: setting(input.from, process.env.RESEND_FROM) ?? DEFAULT_SENDER,
    to: input.to,
    subject: `Your website health check for ${host}`,
    html: [
      `<p>Hello,</p>`,
      `<p>Thanks for ordering a website health check. Your report for ` +
        `<strong>${host}</strong> is attached — open it in any browser.</p>`,
      `<p>It lists what we found, why each item matters, and exactly what to ` +
        `change, starting with the things costing you the most.</p>`,
      `<p>Questions about anything in it? Just reply to this email.</p>`,
      `<p>— BBA Network</p>`,
    ].join('\n'),
    attachments: [
      {
        filename: `website-health-check-${host}.html`,
        content: Buffer.from(input.reportHtml, 'utf8').toString('base64'),
      },
    ],
  };
  const replyTo = setting(input.replyTo, process.env.RESEND_REPLY_TO);
  if (replyTo) email.reply_to = replyTo;
  return email;
}

export function hostOf(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname.replace(/^www\./, '');
  } catch {
    return siteUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? siteUrl;
  }
}

/** Sends one email. Throws with Resend's own message on anything but 2xx. */
export async function sendEmail(
  email: ReportEmail,
  apiKey = process.env.RESEND_API_KEY,
): Promise<{ id: string }> {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('RESEND_API_KEY is not set.');
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(email),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) {
    throw new Error(`Resend refused the email (${response.status}): ${body.message ?? 'no detail'}`);
  }
  if (!body.id) throw new Error('Resend returned no message id — treating as not sent.');
  return { id: body.id };
}

/**
 * An email address, safe for a public Actions log. This repository is public,
 * so scheduled-run logs are public too — and a customer's address in one is a
 * leak, exactly like committing it.
 */
export function redactEmail(email: string | null): string {
  if (!email) return '(no email)';
  const [user, domain] = email.split('@');
  if (!user || !domain) return '(malformed address)';
  return `${user.slice(0, 1)}***@${domain}`;
}
