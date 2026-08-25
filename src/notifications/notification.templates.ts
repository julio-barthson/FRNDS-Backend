// Plain HTML, matching `mail/templates.ts` — email clients ignore most modern
// CSS, and one shared layout for every notification beats a template per type.

const BRAND = 'FRNDSHQ';
const ACCENT = '#0A84FF';

/**
 * The body of every notification email.
 *
 * The title and body are the same strings the in-app centre shows, so the two
 * cannot drift and an artist reading the email and then opening the app sees
 * one message rather than two versions of it.
 */
export function notificationEmail(
  name: string,
  title: string,
  body: string,
): string {
  const supportEmail = process.env.SUPPORT_EMAIL_ADDRESS ?? '';

  return `
  <div style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 24px;font-size:18px;font-weight:700;letter-spacing:0.04em;color:#0b0b0f;">${BRAND}</p>
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#0b0b0f;">${title}</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151;white-space:pre-line;">${
        name ? `Hi ${name},<br/><br/>` : ''
      }${body}</p>
      <p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:#6b7280;">
        Open the FRNDSHQ app to see the full details.
      </p>
      <p style="margin:32px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">
        You are receiving this because of activity on your ${BRAND} account. You can
        turn these emails off in the app under notification settings.
        ${supportEmail ? `Questions? Reach us at <a href="mailto:${supportEmail}" style="color:${ACCENT};">${supportEmail}</a>.` : ''}
      </p>
    </div>
  </div>`;
}
