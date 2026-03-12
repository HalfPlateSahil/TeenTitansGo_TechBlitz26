import cors from "cors";
import express from "express";

import { logger } from "./lib/logger.js";
import { LeadService } from "./services/lead-service.js";
import { healthRouter } from "./routes/health.js";
import { createWebhookRouter } from "./routes/webhooks.js";
import { createWhatsappRouter } from "./routes/whatsapp.js";

export function createApp(leadService: LeadService) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.get("/", (_request, response) => {
    response.status(200).json({
      ok: true,
      service: "Invisible CRM backend",
      routes: {
        health: "/health",
        leadWebhook: "/api/webhooks/leads",
        whatsappMessages: "/api/whatsapp/messages"
      }
    });
  });
  app.use(healthRouter);
  app.use(createWebhookRouter(leadService));
  app.use(createWhatsappRouter(leadService));

  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    logger.error({ err: error }, "Request failed");
    response.status(400).json({
      ok: false,
      error: error.message
    });
  });

  return app;
}
