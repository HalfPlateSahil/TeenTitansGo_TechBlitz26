import { Router } from "express";

import { LeadService } from "../services/lead-service.js";

interface WhatsappWebhookPayload {
  from?: unknown;
  body?: unknown;
  message?: unknown;
}

export function createWhatsappRouter(leadService: LeadService): Router {
  const router = Router();

  router.post("/api/whatsapp/messages", async (request, response, next) => {
    try {
      const payload = request.body as WhatsappWebhookPayload;
      const body = typeof payload.body === "string" ? payload.body : typeof payload.message === "string" ? payload.message : "";
      const from = typeof payload.from === "string" ? payload.from : undefined;
      const result = await leadService.handleOwnerWhatsappCommand(body, from);

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