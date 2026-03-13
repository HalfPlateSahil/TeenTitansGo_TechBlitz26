import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "./lib/logger.js";
import { LeadService } from "./services/lead-service.js";
import type { LeadRepository } from "./repositories/lead-repository.js";
import type { CallLogRepository } from "./repositories/call-log-repository.js";
import type { CallConversationService } from "./services/call-conversation-service.js";
import { healthRouter } from "./routes/health.js";
import { createWebhookRouter } from "./routes/webhooks.js";
import { createWhatsappRouter } from "./routes/whatsapp.js";
import { createEmailReplyRouter } from "./routes/email-reply.js";
import { createInstagramRouter } from "./routes/instagram.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { createCallRouter } from "./routes/calls.js";
import { createLeadFormRouter } from "./routes/lead-form.js";

export function createApp(
  leadService: LeadService,
  repository: LeadRepository,
  callConversationService?: CallConversationService,
  callLogRepository?: CallLogRepository
) {
  const app = express();

  // Serve the lead-capture form from public/
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.resolve(__dirname, "..", "public")));

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  // Parse URL-encoded bodies for Twilio webhook callbacks
  app.use(express.urlencoded({ extended: false }));
  app.get("/api", (_request, response) => {
    response.status(200).json({
      ok: true,
      service: "Invisible CRM backend",
      routes: {
        leadForm: "/",
        leadFormSubmit: "/api/leads/submit",
        health: "/health",
        leadWebhook: "/api/webhooks/leads",
        whatsappMessages: "/api/whatsapp/messages",
        emailReply: "/api/webhooks/email-reply",
        instagram: "/api/webhooks/instagram",
        calls: "/api/calls"
      }
    });
  });
  app.use(healthRouter);
  app.use(createLeadFormRouter(leadService));
  app.use(createWebhookRouter(leadService));
  app.use(createWhatsappRouter(leadService));
  app.use(createEmailReplyRouter(leadService));
  app.use(createInstagramRouter(leadService));
  app.use(createDashboardRouter(leadService, repository));

  if (callConversationService && callLogRepository) {
    app.use(createCallRouter(callConversationService, callLogRepository));
  }

  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    logger.error({ err: error }, "Request failed");
    response.status(400).json({
      ok: false,
      error: error.message
    });
  });

  return app;
}
