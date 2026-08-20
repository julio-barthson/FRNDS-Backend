import { Injectable, Logger } from '@nestjs/common';
import Mailjet, { type SendEmailV3_1 } from 'node-mailjet';

export interface SendMailArgs {
  toEmail: string;
  toName?: string;
  subject: string;
  html: string;
}

export interface SendMailResult {
  delivered: boolean;
}

/**
 * Transactional email through Mailjet's Send API v3.1.
 *
 * With no API keys configured the service logs the message instead of sending
 * it, so local development (and the first deploy, before a sender domain is
 * verified) works without silently swallowing OTPs.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  /** Null when the keys are absent — see {@link sendMail}'s early return. */
  private readonly client: Mailjet | null;

  constructor() {
    const apiKey = process.env.MAILJET_API_PUBLIC_KEY;
    const apiSecret = process.env.MAILJET_API_PRIVATE_KEY;

    // A sender address is as load-bearing as the keys: Mailjet rejects the
    // whole payload without a verified `From`.
    if (!apiKey || !apiSecret || !process.env.SENDER_EMAIL_ADDRESS) {
      this.client = null;
      this.logger.warn(
        'Mailjet is not configured — messages will be logged instead of sent.',
      );
      return;
    }

    this.client = new Mailjet({ apiKey, apiSecret });
  }

  async sendMail({
    toEmail,
    toName,
    subject,
    html,
  }: SendMailArgs): Promise<SendMailResult> {
    if (!this.client) {
      this.logger.warn(
        `Mail not configured — would have sent "${subject}" to ${toEmail}`,
      );
      // Surface OTPs in the terminal so signup can be tested without email.
      const otp = /[^0-9]([0-9]{6})[^0-9]/.exec(html)?.[1];
      if (otp) this.logger.warn(`  code: ${otp}`);
      return { delivered: false };
    }

    const body: SendEmailV3_1.Body = {
      Messages: [
        {
          From: {
            Email: process.env.SENDER_EMAIL_ADDRESS!,
            Name: process.env.SENDER_NAME ?? 'FRNDSHQ',
          },
          To: [{ Email: toEmail, Name: toName || toEmail }],
          Subject: subject,
          HTMLPart: html,
        },
      ],
    };

    try {
      const response = await this.client
        .post('send', { version: 'v3.1' })
        .request<SendEmailV3_1.Response>(body);

      // A 200 does not mean delivery: v3.1 reports per-recipient outcomes in
      // the body, so a rejected address arrives here as a success HTTP status
      // with an `error` message inside.
      const failures = (response.body.Messages ?? []).filter(
        (message) => message.Status !== 'success',
      );

      if (failures.length > 0) {
        for (const failure of failures) {
          const detail = failure.Errors?.map((e) => e.ErrorMessage).join('; ');
          this.logger.error(
            `Mailjet rejected "${subject}" to ${toEmail}: ${detail ?? failure.Status}`,
          );
        }
        return { delivered: false };
      }

      return { delivered: true };
    } catch (error) {
      // Never let a mail outage break the request that triggered it. Callers
      // that must know (e.g. "resend code") can check the returned flag.
      this.logger.error(
        `Mail send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { delivered: false };
    }
  }
}
