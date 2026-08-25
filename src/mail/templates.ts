// Plain HTML strings on purpose. Email clients ignore most modern CSS, and a
// templating dependency buys nothing for four transactional messages.

const BRAND = 'FRNDSHQ';
const ACCENT = '#0A84FF';

function layout(heading: string, body: string): string {
  const supportEmail = process.env.SUPPORT_EMAIL_ADDRESS ?? '';
  return `
  <div style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 24px;font-size:18px;font-weight:700;letter-spacing:0.04em;color:#0b0b0f;">${BRAND}</p>
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#0b0b0f;">${heading}</h1>
      ${body}
      <p style="margin:32px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">
        You are receiving this because an account was created with this email address on ${BRAND}.
        ${supportEmail ? `Questions? Reach us at <a href="mailto:${supportEmail}" style="color:${ACCENT};">${supportEmail}</a>.` : ''}
      </p>
    </div>
  </div>`;
}

function otpBlock(otp: string): string {
  return `<p style="margin:0 0 8px;font-size:32px;font-weight:700;letter-spacing:8px;color:${ACCENT};">${otp}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#6b7280;">This code expires in 10 minutes.</p>`;
}

export function verifyEmailTemplate(name: string, otp: string): string {
  return layout(
    `Confirm your email${name ? `, ${name}` : ''}`,
    `<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">Enter this code in the app to finish setting up your account.</p>
     ${otpBlock(otp)}
     <p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">If you didn't create a ${BRAND} account, you can ignore this email.</p>`,
  );
}

export function welcomeTemplate(name: string): string {
  return layout(
    `Welcome to ${BRAND}${name ? `, ${name}` : ''}`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Your account is live. You can now upload your music and manage it from your dashboard.</p>
     <p style="margin:0;font-size:15px;line-height:1.6;color:#374151;">Your music deserves a better platform.</p>`,
  );
}

export function passwordResetTemplate(name: string, otp: string): string {
  return layout(
    `Reset your password${name ? `, ${name}` : ''}`,
    `<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">Use this code to set a new password.</p>
     ${otpBlock(otp)}
     <p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">If you didn't request this, ignore this email — your password stays unchanged.</p>`,
  );
}

export function passwordChangedTemplate(name: string): string {
  return layout(
    `Your password was changed${name ? `, ${name}` : ''}`,
    `<p style="margin:0;font-size:15px;line-height:1.6;color:#374151;">If this wasn't you, reset your password immediately and contact support.</p>`,
  );
}

export function accountDeletedTemplate(name: string): string {
  return layout(
    `Your ${BRAND} account has been deleted${name ? `, ${name}` : ''}`,
    `<p style="margin:0;font-size:15px;line-height:1.6;color:#374151;">Your profile and uploads have been scheduled for removal. If you didn't request this, contact support right away.</p>`,
  );
}
