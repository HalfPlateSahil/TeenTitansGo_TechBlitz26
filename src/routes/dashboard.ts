import { Router } from "express";

import { logger } from "../lib/logger.js";
import { LeadService } from "../services/lead-service.js";
import type { LeadRepository } from "../repositories/lead-repository.js";
import type { LeadRecord, LeadStatus } from "../types/lead.js";

/**
 * Dashboard API routes — powers the mobile CRM dashboard.
 */
export function createDashboardRouter(leadService: LeadService, repository: LeadRepository): Router {
  const router = Router();

  // ——— GET /api/leads ———
  // List leads with optional filters: ?status=approved&source=instagram&minScore=50&sort=newest
  router.get("/api/leads", async (request, response, next) => {
    try {
      const status = request.query.status as string | undefined;
      const source = request.query.source as string | undefined;
      const minScore = request.query.minScore ? Number(request.query.minScore) : undefined;
      const maxScore = request.query.maxScore ? Number(request.query.maxScore) : undefined;
      const sort = (request.query.sort as string) ?? "newest";
      const limit = request.query.limit ? Math.min(Number(request.query.limit), 200) : 100;

      let leads = await repository.findAll();

      // Apply filters
      if (status) {
        const statuses = status.split(",") as LeadStatus[];
        leads = leads.filter((l) => statuses.includes(l.status));
      }
      if (source) {
        leads = leads.filter((l) => l.source === source);
      }
      if (minScore !== undefined) {
        leads = leads.filter((l) => (l.qualityScore ?? 0) >= minScore);
      }
      if (maxScore !== undefined) {
        leads = leads.filter((l) => (l.qualityScore ?? 0) <= maxScore);
      }

      // Sort
      if (sort === "newest") {
        leads.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } else if (sort === "oldest") {
        leads.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      } else if (sort === "score_desc") {
        leads.sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
      } else if (sort === "score_asc") {
        leads.sort((a, b) => (a.qualityScore ?? 0) - (b.qualityScore ?? 0));
      }

      // Limit
      leads = leads.slice(0, limit);

      response.json({ ok: true, count: leads.length, leads });
    } catch (error) {
      next(error);
    }
  });

  // ——— GET /api/leads/:id ———
  // Single lead with event timeline
  router.get("/api/leads/:id", async (request, response, next) => {
    try {
      const lead = await repository.findById(request.params.id);
      if (!lead) {
        response.status(404).json({ ok: false, error: "Lead not found" });
        return;
      }

      const events = await repository.findEventsByLeadId(lead.id);

      response.json({ ok: true, lead, events });
    } catch (error) {
      next(error);
    }
  });

  // ——— POST /api/leads/:id/approve ———
  // Responds immediately with updated lead; email drafting + sending happens in background.
  router.post("/api/leads/:id/approve", async (request, response, next) => {
    try {
      const lead = await repository.findById(request.params.id);
      if (!lead) {
        response.status(404).json({ ok: false, error: "Lead not found" });
        return;
      }

      // Update status immediately
      const approved = await repository.update(lead.id, { status: "approved" });
      await repository.addEvent({
        leadId: approved.id,
        eventType: "lead_approved",
        actor: "owner",
        payload: { via: "dashboard" }
      });

      // Respond to client immediately
      response.json({ ok: true, action: "approved", lead: approved });

      // Fire-and-forget: email drafting + sending + follow-up scheduling in background
      leadService.handleOwnerWhatsappCommand("1", undefined, lead.id).catch((err: unknown) => {
        logger.error({ err, leadId: lead.id }, "Background email processing failed after dashboard approval");
      });
    } catch (error) {
      next(error);
    }
  });

  // ——— POST /api/leads/:id/reject ———
  router.post("/api/leads/:id/reject", async (request, response, next) => {
    try {
      const lead = await repository.findById(request.params.id);
      if (!lead) {
        response.status(404).json({ ok: false, error: "Lead not found" });
        return;
      }

      const rejected = await repository.update(lead.id, { status: "rejected" });
      await repository.addEvent({
        leadId: rejected.id,
        eventType: "lead_rejected",
        actor: "owner",
        payload: { via: "dashboard" }
      });

      response.json({ ok: true, action: "rejected", lead: rejected });
    } catch (error) {
      next(error);
    }
  });

  // ——— GET /api/stats ———
  // Aggregate statistics for the dashboard
  router.get("/api/stats", async (_request, response, next) => {
    try {
      const leads = await repository.findAll();

      const statusCounts: Record<string, number> = {};
      let totalScore = 0;
      let scoredCount = 0;
      const sourceCounts: Record<string, number> = {};

      for (const lead of leads) {
        // Status counts
        statusCounts[lead.status] = (statusCounts[lead.status] ?? 0) + 1;

        // Score aggregation
        if (lead.qualityScore !== null) {
          totalScore += lead.qualityScore;
          scoredCount++;
        }

        // Source counts
        sourceCounts[lead.source] = (sourceCounts[lead.source] ?? 0) + 1;
      }

      response.json({
        ok: true,
        stats: {
          total: leads.length,
          byStatus: statusCounts,
          bySource: sourceCounts,
          avgScore: scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0,
          recentLeads: leads
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 5)
            .map((l) => ({
              id: l.id,
              name: l.name,
              status: l.status,
              qualityScore: l.qualityScore,
              source: l.source,
              createdAt: l.createdAt
            }))
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
