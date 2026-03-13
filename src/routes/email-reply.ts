import { Router } from "express";

import { LeadService } from "../services/lead-service.js";

/**
 * Webhook receiver for inbound email replies.
 *
 * Services like Resend, SendGrid, or Mailgun can forward inbound emails
 * to this endpoint. When a lead replies, follow-ups are automatically stopped.
 *
 * Expected payload shape is flexible — it tries to extract the sender email
 * from common formats used by popular email forwarding services.
 */
export function createEmailReplyRouter(leadService: LeadService): Router {
    const router = Router();

    router.post("/api/webhooks/email-reply", async (request, response, next) => {
        try {
            const payload = request.body as Record<string, unknown>;

            // Try to extract the sender email from common payload formats:
            // Resend:    { from: "user@example.com", ... }
            // SendGrid:  { from: "user@example.com", envelope: { from: "..." } }
            // Mailgun:   { sender: "user@example.com", ... }
            // Generic:   { email: "user@example.com", ... }
            const senderEmail =
                extractEmail(payload.from) ||
                extractEmail(payload.sender) ||
                extractEmail(payload.email) ||
                extractEmail((payload.envelope as Record<string, unknown>)?.from);

            if (!senderEmail) {
                response.status(400).json({
                    ok: false,
                    error: "Could not extract sender email from payload. Expected 'from', 'sender', or 'email' field."
                });
                return;
            }

            const result = await leadService.handleEmailReply(senderEmail);

            response.status(result.handled ? 200 : 202).json({
                ok: true,
                ...result
            });
        } catch (error) {
            next(error);
        }
    });

    return router;
}

function extractEmail(value: unknown): string | null {
    if (typeof value === "string" && value.includes("@")) {
        // Handle "Name <email@example.com>" format
        const match = value.match(/<([^>]+)>/);
        return match ? match[1] : value.trim();
    }
    return null;
}
