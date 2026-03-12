import nodemailer from "nodemailer";

import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { createId } from "../utils/ids.js";
import type { LeadRecord } from "../types/lead.js";
import type { DraftedEmail, EmailGateway } from "../types/pipeline.js";

function buildFromAddress(): string {
  const email = env.outreachFromEmail ?? env.gmailSmtpUser ?? "sales-agent@example.com";
  return env.outreachFromName ? `${env.outreachFromName} <${email}>` : email;
}

export class SmtpEmailGateway implements EmailGateway {
  private readonly transporter = nodemailer.createTransport({
    host: env.gmailSmtpHost,
    port: env.gmailSmtpPort,
    secure: env.gmailSmtpPort === 465,
    auth:
      env.gmailSmtpUser && env.gmailSmtpPass
        ? {
            user: env.gmailSmtpUser,
            pass: env.gmailSmtpPass
          }
        : undefined
  });

  async sendEmail(
    lead: LeadRecord,
    draft: DraftedEmail,
    _kind: "initial" | "follow_up_1" | "follow_up_2"
  ): Promise<{ messageId: string }> {
    if (!lead.email) {
      throw new Error(`Lead ${lead.id} does not have an email address.`);
    }

    const info = await this.transporter.sendMail({
      from: buildFromAddress(),
      to: lead.email,
      subject: draft.subject,
      text: draft.text,
      html: draft.html ?? undefined
    });

    return { messageId: info.messageId };
  }
}

export class LoggingEmailGateway implements EmailGateway {
  async sendEmail(
    lead: LeadRecord,
    draft: DraftedEmail,
    kind: "initial" | "follow_up_1" | "follow_up_2"
  ): Promise<{ messageId: string }> {
    const messageId = `dry-run-${createId()}`;

    logger.warn(
      {
        leadId: lead.id,
        kind,
        to: lead.email,
        subject: draft.subject,
        messageId
      },
      "SMTP is not configured; email was logged instead of sent"
    );

    return { messageId };
  }
}