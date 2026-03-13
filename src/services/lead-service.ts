import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { LeadRepository } from "../repositories/lead-repository.js";
import type { LeadCommandResult, LeadIngestionResult, LeadRecord, NormalizedLeadInput } from "../types/lead.js";
import type { CallGateway, EmailGateway, FollowUpJobData, FollowUpScheduler, LeadAiClient, WhatsappGateway } from "../types/pipeline.js";
import type { LeadWebhookPayload } from "../types/webhook.js";
import { scoreDuplicateLead } from "../utils/fuzzy.js";
import { createId } from "../utils/ids.js";
import {
  normalizeEmail,
  normalizeLeadPayload,
  normalizeName,
  normalizePhone
} from "../utils/normalization.js";

function buildLeadRecord(payload: NormalizedLeadInput, duplicateOfLeadId: string | null, duplicateConfidence: number | null): LeadRecord {
  const timestamp = new Date().toISOString();

  return {
    id: createId(),
    name: payload.name,
    normalizedName: normalizeName(payload.name),
    email: payload.email,
    normalizedEmail: normalizeEmail(payload.email),
    phone: payload.phone,
    normalizedPhone: normalizePhone(payload.phone),
    source: payload.source,
    inquiryText: payload.inquiryText,
    companyDomain: payload.companyDomain,
    status: "new",
    duplicateOfLeadId,
    duplicateConfidence,
    qualityScore: null,
    aiSummary: null,
    whatsappNotifiedAt: null,
    whatsappResponseSentAt: null,
    initialEmailSentAt: null,
    followUp1SentAt: null,
    followUp2SentAt: null,
    followUpCount: 0,
    lastFollowUpSentAt: null,
    emailReplyDetectedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function normalizeWhatsappDigits(value: string | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function isOwnerMessage(from: string | undefined): boolean {
  if (!from) {
    return true;
  }

  return normalizeWhatsappDigits(from) === normalizeWhatsappDigits(env.ownerWhatsappNumber);
}

export class LeadService {
  constructor(
    private readonly repository: LeadRepository,
    private readonly aiClient: LeadAiClient,
    private readonly whatsappGateway: WhatsappGateway,
    private readonly emailGateway: EmailGateway,
    private readonly followUpScheduler: FollowUpScheduler,
    private readonly callGateway?: CallGateway
  ) { }

  async ingest(payload: LeadWebhookPayload, fallbackSource?: string): Promise<LeadIngestionResult> {
    const normalizedLead = normalizeLeadPayload(payload, fallbackSource);
    const existingLeads = await this.repository.findAll();

    let strongestMatch = null;
    for (const existingLead of existingLeads) {
      const match = scoreDuplicateLead(normalizedLead, existingLead);
      if (!match) {
        continue;
      }

      if (!strongestMatch || match.confidence > strongestMatch.confidence) {
        strongestMatch = match;
      }
    }

    if (strongestMatch && strongestMatch.confidence >= env.duplicateConfidenceThreshold) {
      const matchedLead = await this.repository.findById(strongestMatch.existingLeadId);
      if (!matchedLead) {
        throw new Error("Duplicate lead target disappeared during lookup.");
      }

      logger.info(
        {
          existingLeadId: matchedLead.id,
          confidence: strongestMatch.confidence,
          reasons: strongestMatch.reasons
        },
        "Lead identified as duplicate"
      );

      await this.repository.addEvent({
        leadId: matchedLead.id,
        eventType: "duplicate_detected",
        actor: "system",
        payload: {
          confidence: strongestMatch.confidence,
          reasons: strongestMatch.reasons,
          incomingSource: normalizedLead.source
        }
      });

      return {
        lead: matchedLead,
        duplicate: true,
        duplicateMatch: strongestMatch,
        archived: matchedLead.status === "archived",
        notified: Boolean(matchedLead.whatsappNotifiedAt)
      };
    }

    const initialLead = buildLeadRecord(
      normalizedLead,
      strongestMatch?.existingLeadId ?? null,
      strongestMatch?.confidence ?? null
    );

    let lead = await this.repository.create(initialLead);

    await this.repository.addEvent({
      leadId: lead.id,
      eventType: "lead_ingested",
      actor: "system",
      payload: {
        source: lead.source,
        duplicateOfLeadId: lead.duplicateOfLeadId,
        duplicateConfidence: lead.duplicateConfidence
      }
    });

    const enrichment = await this.aiClient.enrichAndScore(lead);
    lead = await this.repository.update(lead.id, {
      qualityScore: enrichment.qualityScore,
      aiSummary: enrichment.summary,
      status: enrichment.shouldArchive ? "archived" : "review_needed"
    });

    await this.repository.addEvent({
      leadId: lead.id,
      eventType: "lead_scored",
      actor: "gemini",
      payload: {
        qualityScore: enrichment.qualityScore,
        summary: enrichment.summary,
        reasoning: enrichment.reasoning,
        research: enrichment.research,
        shouldArchive: enrichment.shouldArchive
      }
    });

    if (enrichment.shouldArchive) {
      await this.repository.addEvent({
        leadId: lead.id,
        eventType: "lead_archived",
        actor: "system",
        payload: {
          threshold: env.lowIntentScoreThreshold,
          qualityScore: enrichment.qualityScore
        }
      });

      logger.info({ leadId: lead.id, qualityScore: enrichment.qualityScore }, "Lead archived by junk filter");

      return {
        lead,
        duplicate: false,
        duplicateMatch: strongestMatch,
        archived: true,
        notified: false
      };
    }

    let notified = false;
    try {
      await this.whatsappGateway.sendApprovalRequest(lead);
      lead = await this.repository.update(lead.id, {
        whatsappNotifiedAt: new Date().toISOString()
      });

      await this.repository.addEvent({
        leadId: lead.id,
        eventType: "approval_requested",
        actor: "system",
        payload: {
          ownerWhatsappNumber: env.ownerWhatsappNumber
        }
      });

      notified = true;
    } catch (whatsappError: unknown) {
      logger.warn(
        { leadId: lead.id, err: whatsappError },
        "WhatsApp notification failed; lead was saved and can be approved via the API"
      );

      await this.repository.addEvent({
        leadId: lead.id,
        eventType: "whatsapp_notification_failed",
        actor: "system",
        payload: {
          error: whatsappError instanceof Error ? whatsappError.message : String(whatsappError)
        }
      });
    }

    logger.info({ leadId: lead.id, source: lead.source, notified }, "Lead ingested");

    return {
      lead,
      duplicate: false,
      duplicateMatch: strongestMatch,
      archived: false,
      notified
    };
  }

  async handleOwnerWhatsappCommand(body: string, from?: string, targetLeadId?: string): Promise<LeadCommandResult> {
    if (!isOwnerMessage(from)) {
      return {
        handled: false,
        action: "ignored",
        reason: "message_not_from_owner",
        lead: null
      };
    }

    const command = body.trim();
    if (command !== "1" && command !== "2") {
      return {
        handled: false,
        action: "ignored",
        reason: "unsupported_command",
        lead: null
      };
    }

    const lead = targetLeadId
      ? await this.repository.findById(targetLeadId)
      : await this.repository.findLatestAwaitingApproval();
    if (!lead) {
      return {
        handled: false,
        action: "ignored",
        reason: "no_pending_lead",
        lead: null
      };
    }

    if (command === "2") {
      const rejectedLead = await this.repository.update(lead.id, { status: "rejected" });
      await this.repository.addEvent({
        leadId: rejectedLead.id,
        eventType: "lead_rejected",
        actor: "owner",
        payload: {
          via: "whatsapp"
        }
      });

      return {
        handled: true,
        action: "rejected",
        lead: rejectedLead
      };
    }

    let approvedLead = await this.repository.update(lead.id, { status: "approved" });
    await this.repository.addEvent({
      leadId: approvedLead.id,
      eventType: "lead_approved",
      actor: "owner",
      payload: {
        via: "whatsapp"
      }
    });

    if (!approvedLead.email) {
      await this.repository.addEvent({
        leadId: approvedLead.id,
        eventType: "email_skipped",
        actor: "system",
        payload: {
          reason: "missing_email_address"
        }
      });

      return {
        handled: true,
        action: "approved",
        lead: approvedLead
      };
    }

    const draft = await this.aiClient.draftOutreachEmail({ lead: approvedLead, step: 0 });
    const delivery = await this.emailGateway.sendEmail(approvedLead, draft, "initial");
    const sentAt = new Date().toISOString();
    approvedLead = await this.repository.update(approvedLead.id, { initialEmailSentAt: sentAt });

    await this.repository.addEvent({
      leadId: approvedLead.id,
      eventType: "initial_email_sent",
      actor: "system",
      payload: {
        messageId: delivery.messageId,
        subject: draft.subject,
        sentAt
      }
    });

    await this.followUpScheduler.scheduleFollowUp(approvedLead.id, 1);
    await this.repository.addEvent({
      leadId: approvedLead.id,
      eventType: "follow_up_scheduled",
      actor: "system",
      payload: {
        step: 1,
        delayHours: env.followUpDelayHours
      }
    });

    // Send AI-generated WhatsApp response to the lead
    if (approvedLead.phone || approvedLead.normalizedPhone) {
      try {
        const whatsappMessage = await this.aiClient.draftWhatsappResponse(approvedLead);
        await this.whatsappGateway.sendLeadResponse(approvedLead, whatsappMessage);
        approvedLead = await this.repository.update(approvedLead.id, {
          whatsappResponseSentAt: new Date().toISOString()
        });

        await this.repository.addEvent({
          leadId: approvedLead.id,
          eventType: "whatsapp_response_sent",
          actor: "system",
          payload: {
            phone: approvedLead.normalizedPhone ?? approvedLead.phone,
            messageSummary: whatsappMessage.slice(0, 120)
          }
        });
      } catch (whatsappResponseError: unknown) {
        logger.warn(
          { leadId: approvedLead.id, err: whatsappResponseError },
          "WhatsApp response to lead failed; lead was approved and email was sent"
        );

        await this.repository.addEvent({
          leadId: approvedLead.id,
          eventType: "whatsapp_response_failed",
          actor: "system",
          payload: {
            error: whatsappResponseError instanceof Error ? whatsappResponseError.message : String(whatsappResponseError)
          }
        });
      }
    }

    // Trigger automated outbound call if lead has a phone number
    if ((approvedLead.phone || approvedLead.normalizedPhone) && this.callGateway) {
      try {
        const callResult = await this.callGateway.initiateCall(approvedLead);

        await this.repository.addEvent({
          leadId: approvedLead.id,
          eventType: "outbound_call_initiated",
          actor: "system",
          payload: {
            callSid: callResult.callSid,
            callLogId: callResult.callLogId,
            phone: approvedLead.normalizedPhone ?? approvedLead.phone
          }
        });
      } catch (callError: unknown) {
        logger.warn(
          { leadId: approvedLead.id, err: callError },
          "Automated outbound call failed; lead was approved and email was sent"
        );

        await this.repository.addEvent({
          leadId: approvedLead.id,
          eventType: "outbound_call_failed",
          actor: "system",
          payload: {
            error: callError instanceof Error ? callError.message : String(callError)
          }
        });
      }
    }

    return {
      handled: true,
      action: "approved",
      lead: approvedLead
    };
  }

  async processFollowUpJob(job: FollowUpJobData): Promise<void> {
    const lead = await this.repository.findById(job.leadId);
    if (!lead) {
      logger.warn({ leadId: job.leadId, step: job.step }, "Skipping follow-up because the lead no longer exists");
      return;
    }

    if (["rejected", "archived", "replied", "closed"].includes(lead.status)) {
      logger.info({ leadId: lead.id, status: lead.status, step: job.step }, "Skipping follow-up because the lead is no longer active");
      return;
    }

    if (lead.emailReplyDetectedAt) {
      logger.info({ leadId: lead.id, step: job.step }, "Skipping follow-up because a reply was already detected");
      return;
    }

    if (!lead.email) {
      logger.info({ leadId: lead.id, step: job.step }, "Skipping follow-up because the lead has no email address");
      return;
    }

    if (job.step > env.maxFollowUpSteps) {
      logger.info({ leadId: lead.id, step: job.step, maxSteps: env.maxFollowUpSteps }, "Follow-up chain completed (max steps reached)");
      return;
    }

    const draft = await this.aiClient.draftOutreachEmail({ lead, step: job.step });
    const kind = `follow_up_${job.step}` as const;
    const delivery = await this.emailGateway.sendEmail(lead, draft, kind);
    const sentAt = new Date().toISOString();

    const patch: import("../types/lead.js").LeadRecordPatch = {
      followUpCount: job.step,
      lastFollowUpSentAt: sentAt
    };
    // Keep backward compat for the fixed columns
    if (job.step === 1) {
      patch.followUp1SentAt = sentAt;
    } else if (job.step === 2) {
      patch.followUp2SentAt = sentAt;
    }

    const updatedLead = await this.repository.update(lead.id, patch);

    await this.repository.addEvent({
      leadId: updatedLead.id,
      eventType: "follow_up_sent",
      actor: "system",
      payload: {
        step: job.step,
        messageId: delivery.messageId,
        subject: draft.subject,
        sentAt
      }
    });

    // Schedule next follow-up if below max steps
    const nextStep = job.step + 1;
    if (nextStep <= env.maxFollowUpSteps) {
      const baseDelayMs = env.followUpDelayHours * 60 * 60 * 1000;
      const nextDelay = Math.round(baseDelayMs * Math.pow(env.followUpDelayMultiplier, job.step - 1));

      await this.followUpScheduler.scheduleFollowUp(updatedLead.id, nextStep, nextDelay);
      await this.repository.addEvent({
        leadId: updatedLead.id,
        eventType: "follow_up_scheduled",
        actor: "system",
        payload: {
          step: nextStep,
          delayMs: nextDelay,
          delayHours: Math.round(nextDelay / (60 * 60 * 1000))
        }
      });
    } else {
      logger.info({ leadId: updatedLead.id, completedSteps: job.step }, "Follow-up chain completed");
    }
  }

  async handleEmailReply(leadEmail: string): Promise<{ handled: boolean; leadId: string | null }> {
    const allLeads = await this.repository.findAll();
    const lead = allLeads.find(
      (l) => l.normalizedEmail === leadEmail.toLowerCase().trim() && ["approved"].includes(l.status)
    );

    if (!lead) {
      logger.info({ email: leadEmail }, "No matching active lead found for email reply");
      return { handled: false, leadId: null };
    }

    const updated = await this.repository.update(lead.id, {
      status: "replied",
      emailReplyDetectedAt: new Date().toISOString()
    });

    await this.repository.addEvent({
      leadId: updated.id,
      eventType: "email_reply_detected",
      actor: "system",
      payload: {
        fromEmail: leadEmail
      }
    });

    logger.info({ leadId: updated.id, email: leadEmail }, "Email reply detected — follow-ups stopped");
    return { handled: true, leadId: updated.id };
  }
}
