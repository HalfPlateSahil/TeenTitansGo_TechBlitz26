import { Router } from "express";

import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { LeadService } from "../services/lead-service.js";

/**
 * Instagram DM webhook receiver.
 *
 * Setup on the Meta side:
 * 1. Create a Meta Developer App at https://developers.facebook.com
 * 2. Add the Instagram Graph API product
 * 3. Configure a Webhook subscription for "messages" events
 * 4. Set the Callback URL to: https://your-domain.com/api/webhooks/instagram
 * 5. Set the Verify Token to match INSTAGRAM_VERIFY_TOKEN in your .env
 * 6. Subscribe to the page/account that receives DMs
 */
export function createInstagramRouter(leadService: LeadService): Router {
    const router = Router();

    // Meta Webhook Verification (GET)
    // Meta sends a GET request to verify ownership of the endpoint.
    router.get("/api/webhooks/instagram", (request, response) => {
        const mode = request.query["hub.mode"] as string | undefined;
        const token = request.query["hub.verify_token"] as string | undefined;
        const challenge = request.query["hub.challenge"] as string | undefined;

        if (mode === "subscribe" && token === env.instagramVerifyToken) {
            logger.info("Instagram webhook verification succeeded");
            response.status(200).send(challenge);
            return;
        }

        logger.warn({ mode, token: token ? "[redacted]" : undefined }, "Instagram webhook verification failed");
        response.status(403).send("Forbidden");
    });

    // Instagram DM Events (POST)
    // When someone sends a DM to the Instagram account, Meta sends a POST here.
    router.post("/api/webhooks/instagram", async (request, response, next) => {
        try {
            const body = request.body as InstagramWebhookPayload;

            // Always return 200 quickly to acknowledge receipt (Meta retries on failure)
            response.status(200).json({ ok: true });

            // Process entries asynchronously
            if (!body.entry) {
                return;
            }

            for (const entry of body.entry) {
                const messaging = entry.messaging ?? [];
                for (const event of messaging) {
                    if (!event.message?.text) {
                        continue;
                    }

                    const senderId = event.sender?.id;
                    const messageText = event.message.text;
                    const senderName = senderId ?? "Instagram User";

                    // Try to extract email and company domain from the message text itself
                    const emailMatch = messageText.match(/[\w.-]+@[\w.-]+\.[\w]{2,}/);
                    const extractedEmail = emailMatch ? emailMatch[0] : null;
                    const companyDomain = extractedEmail
                        ? extractedEmail.split("@")[1]
                        : null;

                    logger.info(
                        { senderId, extractedEmail, messagePreview: messageText.substring(0, 100) },
                        "Instagram DM received"
                    );

                    try {
                        await leadService.ingest({
                            name: senderName,
                            email: extractedEmail,
                            phone: null,
                            source: "instagram",
                            inquiryText: messageText,
                            companyDomain
                        });
                    } catch (ingestError: unknown) {
                        logger.error(
                            { err: ingestError, senderId },
                            "Failed to ingest Instagram DM as lead"
                        );
                    }
                }
            }
        } catch (error) {
            logger.error({ err: error }, "Error processing Instagram webhook");
            // Don't call next — we already sent 200
        }
    });

    return router;
}

// ---- Instagram Webhook Type Definitions ----

interface InstagramWebhookPayload {
    object?: string;
    entry?: InstagramEntry[];
}

interface InstagramEntry {
    id?: string;
    time?: number;
    messaging?: InstagramMessagingEvent[];
}

interface InstagramMessagingEvent {
    sender?: { id: string };
    recipient?: { id: string };
    timestamp?: number;
    message?: {
        mid?: string;
        text?: string;
        attachments?: Array<{ type: string; payload: { url: string } }>;
    };
}
