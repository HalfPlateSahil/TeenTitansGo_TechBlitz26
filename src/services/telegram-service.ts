import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { LeadRecord } from "../types/lead.js";
import type { InboundWhatsappMessage, WhatsappGateway } from "../types/pipeline.js";

const TELEGRAM_API = "https://api.telegram.org";

function apiUrl(method: string): string {
    return `${TELEGRAM_API}/bot${env.telegramBotToken}/${method}`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function formatLeadMessage(lead: LeadRecord): string {
    const scoreEmoji = (lead.qualityScore ?? 0) >= 70 ? "🟢" : (lead.qualityScore ?? 0) >= 40 ? "🟡" : "🔴";

    return [
        `🚨 <b>New Lead Received</b>`,
        ``,
        `<b>Name:</b> ${escapeHtml(lead.name)}`,
        `${scoreEmoji} <b>Score:</b> ${lead.qualityScore ?? "n/a"}/100`,
        `<b>Source:</b> ${escapeHtml(lead.source)}`,
        `<b>Email:</b> ${escapeHtml(lead.email ?? "n/a")}`,
        lead.phone ? `<b>Phone:</b> ${escapeHtml(lead.phone)}` : null,
        lead.companyDomain ? `<b>Company:</b> ${escapeHtml(lead.companyDomain)}` : null,
        ``,
        `<b>Summary:</b> ${escapeHtml(lead.aiSummary ?? lead.inquiryText)}`,
        ``,
        `<b>Inquiry:</b> <i>${escapeHtml(lead.inquiryText)}</i>`
    ].filter(Boolean).join("\n");
}

async function telegramRequest<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(apiUrl(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Telegram ${method} failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { ok: boolean; result: T };
    return data.result;
}

interface TelegramUpdate {
    update_id: number;
    callback_query?: {
        id: string;
        from: { id: number };
        data?: string;
        message?: {
            message_id: number;
            chat: { id: number };
            text?: string;
        };
    };
}

export class TelegramGateway implements WhatsappGateway {
    private polling = false;
    private lastUpdateId = 0;

    async sendApprovalRequest(lead: LeadRecord): Promise<void> {
        if (!env.telegramBotToken || !env.telegramOwnerChatId) {
            throw new Error("Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID.");
        }

        await telegramRequest("sendMessage", {
            chat_id: env.telegramOwnerChatId,
            text: formatLeadMessage(lead),
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Approve", callback_data: `approve:${lead.id}` },
                        { text: "❌ Reject", callback_data: `reject:${lead.id}` }
                    ]
                ]
            }
        });

        logger.info({ leadId: lead.id }, "Telegram approval request sent");
    }

    async sendLeadResponse(lead: LeadRecord, message: string): Promise<void> {
        // Telegram gateway is used for owner notifications only.
        // WhatsApp responses to leads are handled by the WhatsApp gateway.
        logger.info(
            { leadId: lead.id, phone: lead.normalizedPhone ?? lead.phone },
            "Telegram gateway does not send WhatsApp responses to leads (no-op)"
        );
    }

    async start(handler: (message: InboundWhatsappMessage) => Promise<void>): Promise<void> {
        if (this.polling) {
            return;
        }

        if (!env.telegramBotToken || !env.telegramOwnerChatId) {
            logger.warn("Telegram is not configured; skipping bot polling");
            return;
        }

        this.polling = true;
        logger.info("Telegram bot polling started — waiting for button presses");

        this.poll(handler).catch((error: unknown) => {
            logger.error({ err: error }, "Telegram polling loop crashed");
            this.polling = false;
        });
    }

    private async poll(handler: (message: InboundWhatsappMessage) => Promise<void>): Promise<void> {
        while (this.polling) {
            try {
                const updates = await telegramRequest<TelegramUpdate[]>("getUpdates", {
                    offset: this.lastUpdateId + 1,
                    timeout: 30,
                    allowed_updates: ["callback_query"]
                });

                for (const update of updates) {
                    this.lastUpdateId = update.update_id;

                    const callback = update.callback_query;
                    if (!callback?.data) {
                        continue;
                    }

                    // Only accept callbacks from the owner
                    if (String(callback.from.id) !== env.telegramOwnerChatId) {
                        logger.warn({ fromId: callback.from.id }, "Ignoring callback from non-owner");
                        continue;
                    }

                    const [action, leadId] = callback.data.split(":");
                    if (!action || !leadId) {
                        continue;
                    }

                    logger.info({ action, leadId }, "Telegram callback received");

                    // Answer the callback to remove the loading spinner
                    await telegramRequest("answerCallbackQuery", {
                        callback_query_id: callback.id,
                        text: action === "approve" ? "✅ Lead approved!" : "❌ Lead rejected."
                    });

                    // Map button press to the existing command handler.
                    // Pass `undefined` as `from` so the owner check is bypassed
                    // (we already validated the sender above).
                    const commandBody = action === "approve" ? "1" : "2";
                    await handler({ from: "", body: commandBody, targetLeadId: leadId });

                    // Remove the buttons from the original message and add result
                    if (callback.message) {
                        const resultLabel = action === "approve" ? "✅ APPROVED" : "❌ REJECTED";
                        const updatedText = (callback.message.text ?? "") + `\n\n<b>${resultLabel}</b>`;

                        await telegramRequest("editMessageText", {
                            chat_id: callback.message.chat.id,
                            message_id: callback.message.message_id,
                            text: updatedText,
                            parse_mode: "HTML",
                            reply_markup: { inline_keyboard: [] }
                        }).catch((editError: unknown) => {
                            logger.warn({ err: editError }, "Failed to edit Telegram message after action");
                        });
                    }
                }
            } catch (error: unknown) {
                logger.warn({ err: error }, "Telegram polling error, retrying in 5s…");
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }
}

export class LoggingTelegramGateway implements WhatsappGateway {
    async sendApprovalRequest(lead: LeadRecord): Promise<void> {
        logger.warn(
            { leadId: lead.id, message: formatLeadMessage(lead) },
            "Telegram is not configured; approval request logged instead of sent"
        );
    }

    async sendLeadResponse(lead: LeadRecord, _message: string): Promise<void> {
        logger.warn(
            { leadId: lead.id },
            "Notification gateway logging mode; lead WhatsApp response skipped"
        );
    }

    async start(): Promise<void> {
        logger.info("Notification gateway is running in logging mode (no Telegram/WhatsApp configured)");
    }
}
