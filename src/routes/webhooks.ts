import { Router } from "express";

import { LeadService } from "../services/lead-service.js";
import type { LeadWebhookPayload } from "../types/webhook.js";

export function createWebhookRouter(leadService: LeadService): Router {
  const router = Router();

  router.post("/api/webhooks/leads", async (request, response, next) => {
    try {
      const payload = request.body as LeadWebhookPayload;
      const sourceHeader = request.header("x-lead-source") ?? undefined;
      const result = await leadService.ingest(payload, sourceHeader);

      response.status(result.duplicate ? 200 : 201).json({
        ok: true,
        duplicate: result.duplicate,
        archived: result.archived,
        notified: result.notified,
        lead: result.lead,
        duplicateMatch: result.duplicateMatch
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
