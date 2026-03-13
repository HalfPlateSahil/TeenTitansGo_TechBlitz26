import { createRequire } from "node:module";
import qrcodeTerminal from "qrcode-terminal";

// whatsapp-web.js is a CommonJS module; named imports are not available
// under Node's native ESM loader, so we use createRequire to load it.
const _require = createRequire(import.meta.url);
const { Client, LocalAuth } = _require("whatsapp-web.js") as typeof import("whatsapp-web.js");

import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { LeadRecord } from "../types/lead.js";
import type { InboundWhatsappMessage, WhatsappGateway, WhatsappOutreachGateway } from "../types/pipeline.js";

function normalizeWhatsappAddress(value: string): string {
  return value.replace(/\D/g, "");
}

function buildOwnerJid(): string {
  return `${normalizeWhatsappAddress(env.ownerWhatsappNumber)}@c.us`;
}

export function formatApprovalMessage(lead: LeadRecord): string {
  return [
    `New Lead: ${lead.name}`,
    `Score: ${lead.qualityScore ?? "n/a"}/100`,
    `Summary: ${lead.aiSummary ?? lead.inquiryText}`,
    `Source: ${lead.source}`,
    "Reply '1' to approve or '2' to reject."
  ].join("\n");
}

export class WhatsAppWebGateway implements WhatsappGateway {
  private readonly client = new Client({
    authStrategy: new LocalAuth({ dataPath: env.whatsappSessionPath }),
    puppeteer: {
      headless: env.whatsappHeadless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    }
  });

  private ready = false;
  private started = false;

  async start(handler: (message: InboundWhatsappMessage) => Promise<void>): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    this.client.on("qr", (qr) => {
      qrcodeTerminal.generate(qr, { small: true });
      logger.info("Scan the WhatsApp QR code above to authenticate the owner session");
    });

    this.client.on("ready", () => {
      this.ready = true;
      logger.info("WhatsApp Web client is ready");
    });

    this.client.on("auth_failure", (message) => {
      this.ready = false;
      logger.error({ message }, "WhatsApp authentication failed");
    });

    this.client.on("disconnected", (reason) => {
      this.ready = false;
      logger.warn({ reason }, "WhatsApp client disconnected");
    });

    this.client.on("message", async (message) => {
      const from = normalizeWhatsappAddress(message.from);
      const owner = normalizeWhatsappAddress(env.ownerWhatsappNumber);

      if (from !== owner) {
        return;
      }

      await handler({
        from: message.from,
        body: message.body
      });
    });

    await this.client.initialize();
  }

  async sendApprovalRequest(lead: LeadRecord): Promise<void> {
    if (!this.ready) {
      throw new Error("WhatsApp client is not ready. Authenticate the session before processing leads.");
    }

    await this.client.sendMessage(buildOwnerJid(), formatApprovalMessage(lead));
  }

  async sendLeadResponse(lead: LeadRecord, message: string): Promise<void> {
    if (!this.ready) {
      throw new Error("WhatsApp client is not ready. Authenticate the session before sending messages.");
    }

    const phone = lead.normalizedPhone ?? lead.phone;
    if (!phone) {
      throw new Error(`Lead ${lead.id} does not have a phone number for WhatsApp messaging.`);
    }

    const jid = `${normalizeWhatsappAddress(phone)}@c.us`;
    await this.client.sendMessage(jid, message);
  }
}

export class LoggingWhatsappGateway implements WhatsappGateway {
  async sendApprovalRequest(lead: LeadRecord): Promise<void> {
    logger.warn({ leadId: lead.id, message: formatApprovalMessage(lead) }, "WhatsApp is not configured; approval request logged instead of sent");
  }

  async sendLeadResponse(lead: LeadRecord, message: string): Promise<void> {
    logger.warn(
      { leadId: lead.id, phone: lead.normalizedPhone ?? lead.phone, message },
      "WhatsApp is not configured; lead response logged instead of sent"
    );
  }

  async start(): Promise<void> {
    logger.info("WhatsApp gateway is running in logging mode");
  }
}

/**
 * Dedicated WhatsApp Web client for sending outreach messages to LEADS.
 * Runs its own Puppeteer session, independent of the owner notification gateway.
 */
export class WhatsAppOutreachService implements WhatsappOutreachGateway {
  private readonly client = new Client({
    authStrategy: new LocalAuth({ dataPath: env.whatsappSessionPath }),
    puppeteer: {
      headless: env.whatsappHeadless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    }
  });

  private ready = false;
  private started = false;

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    this.client.on("qr", (qr) => {
      qrcodeTerminal.generate(qr, { small: true });
      logger.info("Scan the WhatsApp QR code above to authenticate the lead outreach session");
    });

    this.client.on("ready", () => {
      this.ready = true;
      logger.info("WhatsApp outreach client is ready — lead messaging enabled");
    });

    this.client.on("auth_failure", (message) => {
      this.ready = false;
      logger.error({ message }, "WhatsApp outreach authentication failed");
    });

    this.client.on("disconnected", (reason) => {
      this.ready = false;
      logger.warn({ reason }, "WhatsApp outreach client disconnected");
    });

    await this.client.initialize();
  }

  async sendMessage(lead: LeadRecord, message: string): Promise<void> {
    if (!this.ready) {
      throw new Error("WhatsApp outreach client is not ready. Scan the QR code first.");
    }

    const phone = lead.normalizedPhone ?? lead.phone;
    if (!phone) {
      throw new Error(`Lead ${lead.id} does not have a phone number for WhatsApp messaging.`);
    }

    const jid = `${normalizeWhatsappAddress(phone)}@c.us`;
    await this.client.sendMessage(jid, message);

    logger.info(
      { leadId: lead.id, to: jid },
      "WhatsApp outreach message sent to lead"
    );
  }
}

export class LoggingWhatsappOutreachGateway implements WhatsappOutreachGateway {
  async sendMessage(lead: LeadRecord, message: string): Promise<void> {
    logger.warn(
      { leadId: lead.id, phone: lead.normalizedPhone ?? lead.phone, messageSummary: message.slice(0, 80) },
      "WhatsApp outreach is not configured; message logged instead of sent"
    );
  }

  async start(): Promise<void> {
    logger.info("WhatsApp outreach is running in logging mode");
  }
}