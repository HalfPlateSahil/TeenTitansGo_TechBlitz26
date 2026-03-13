import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { InMemoryLeadRepository } from "../src/repositories/lead-repository.js";
import { InMemoryCallLogRepository } from "../src/repositories/call-log-repository.js";
import { HeuristicLeadAiClient } from "../src/services/ai-service.js";
import { LoggingEmailGateway } from "../src/services/email-service.js";
import { InMemoryFollowUpScheduler } from "../src/services/follow-up-service.js";
import { CallConversationService } from "../src/services/call-conversation-service.js";
import { LeadService } from "../src/services/lead-service.js";
import { LoggingWhatsappGateway } from "../src/services/whatsapp-service.js";
import type { CallGateway, DraftEmailInput, DraftedEmail, EmailGateway, LeadAiClient, WhatsappGateway } from "../src/types/pipeline.js";
import type { LeadEnrichmentResult } from "../src/types/pipeline.js";
import type { LeadRecord } from "../src/types/lead.js";

class StubAiClient implements LeadAiClient {
  constructor(private readonly qualityScore: number) {}

  async enrichAndScore(lead: Parameters<LeadAiClient["enrichAndScore"]>[0]): Promise<LeadEnrichmentResult> {
    return {
      research: {
        companyName: "Titans",
        companyIndustry: "Software",
        companySize: "1-10",
        summary: `Research for ${lead.name}`,
        raw: { source: "stub" }
      },
      score: {
        value: this.qualityScore,
        summary: `Scored ${lead.name}`,
        reasoning: "stub",
        raw: { source: "stub" }
      },
      qualityScore: this.qualityScore,
      summary: `Scored ${lead.name}`,
      reasoning: "stub",
      shouldArchive: this.qualityScore < 20
    };
  }

  async draftOutreachEmail(input: DraftEmailInput): Promise<DraftedEmail> {
    return {
      subject: `Hello ${input.lead.name}`,
      text: `Hi ${input.lead.name}, thanks for reaching out.`
    };
  }

  async draftWhatsappResponse(lead: Parameters<LeadAiClient["enrichAndScore"]>[0]): Promise<string> {
    return `Hi ${lead.name}! Thanks for reaching out.`;
  }
}

class StubWhatsappGateway implements WhatsappGateway {
  readonly sentMessages: string[] = [];
  readonly sentLeadResponses: Array<{ leadId: string; message: string }> = [];

  async sendApprovalRequest(lead: Parameters<WhatsappGateway["sendApprovalRequest"]>[0]): Promise<void> {
    this.sentMessages.push(lead.id);
  }

  async sendLeadResponse(lead: LeadRecord, message: string): Promise<void> {
    this.sentLeadResponses.push({ leadId: lead.id, message });
  }
}

class StubEmailGateway implements EmailGateway {
  readonly sentEmails: Array<{ leadId: string; kind: string }> = [];

  async sendEmail(
    lead: Parameters<EmailGateway["sendEmail"]>[0],
    _draft: DraftedEmail,
    kind: Parameters<EmailGateway["sendEmail"]>[2]
  ): Promise<{ messageId: string }> {
    this.sentEmails.push({ leadId: lead.id, kind });
    return { messageId: `${kind}-${lead.id}` };
  }
}

class StubCallGateway implements CallGateway {
  readonly initiatedCalls: Array<{ leadId: string; phone: string | null }> = [];

  async initiateCall(lead: LeadRecord): Promise<{ callSid: string; callLogId: string }> {
    this.initiatedCalls.push({
      leadId: lead.id,
      phone: lead.normalizedPhone ?? lead.phone
    });
    return {
      callSid: `stub-sid-${lead.id}`,
      callLogId: `stub-log-${lead.id}`
    };
  }
}

function buildAppWithCalls(options?: {
  repository?: InMemoryLeadRepository;
  aiClient?: LeadAiClient;
  whatsappGateway?: WhatsappGateway;
  emailGateway?: EmailGateway;
  followUpScheduler?: InMemoryFollowUpScheduler;
  callGateway?: CallGateway;
}) {
  const repository = options?.repository ?? new InMemoryLeadRepository();
  const callLogRepository = new InMemoryCallLogRepository();
  const aiClient = options?.aiClient ?? new HeuristicLeadAiClient();
  const whatsappGateway = options?.whatsappGateway ?? new LoggingWhatsappGateway();
  const emailGateway = options?.emailGateway ?? new LoggingEmailGateway();
  const followUpScheduler = options?.followUpScheduler ?? new InMemoryFollowUpScheduler();
  const callGateway = options?.callGateway;
  const callConversationService = new CallConversationService(callLogRepository, repository);
  const leadService = new LeadService(repository, aiClient, whatsappGateway, emailGateway, followUpScheduler, callGateway);

  return {
    repository,
    callLogRepository,
    whatsappGateway,
    emailGateway,
    followUpScheduler,
    callGateway,
    callConversationService,
    app: createApp(leadService, repository, callConversationService, callLogRepository)
  };
}

describe("Automated calling on lead approval", () => {
  it("triggers an outbound call when a lead with phone is approved", async () => {
    const callGateway = new StubCallGateway();
    const emailGateway = new StubEmailGateway();

    const { app, repository } = buildAppWithCalls({
      aiClient: new StubAiClient(82),
      whatsappGateway: new StubWhatsappGateway(),
      emailGateway,
      callGateway
    });

    // Ingest a lead with a phone number
    const created = await request(app)
      .post("/api/webhooks/leads")
      .send({
        name: "Raven",
        email: "raven@titans.com",
        phone: "+1-555-123-4567",
        message: "Need help with CRM automation"
      });

    expect(created.status).toBe(201);

    // Approve the lead
    const approval = await request(app)
      .post(`/api/leads/${created.body.lead.id}/approve`)
      .send();

    expect(approval.status).toBe(200);
    expect(approval.body.ok).toBe(true);
    expect(approval.body.action).toBe("approved");

    // Verify call was initiated
    expect(callGateway.initiatedCalls).toHaveLength(1);
    expect(callGateway.initiatedCalls[0].leadId).toBe(created.body.lead.id);

    // Verify email was also sent
    expect(emailGateway.sentEmails).toHaveLength(1);

    // Verify call event was logged
    const events = await repository.findEventsByLeadId(created.body.lead.id);
    const callEvents = events.filter((e) => e.eventType === "outbound_call_initiated");
    expect(callEvents).toHaveLength(1);
    expect(callEvents[0].payload.callSid).toBe(`stub-sid-${created.body.lead.id}`);
  });

  it("does NOT trigger a call when lead has no phone number", async () => {
    const callGateway = new StubCallGateway();

    const { app } = buildAppWithCalls({
      aiClient: new StubAiClient(82),
      whatsappGateway: new StubWhatsappGateway(),
      emailGateway: new StubEmailGateway(),
      callGateway
    });

    // Ingest a lead WITHOUT a phone number
    const created = await request(app)
      .post("/api/webhooks/leads")
      .send({
        name: "Cyborg",
        email: "cyborg@titans.com",
        message: "Interested in your services"
      });

    expect(created.status).toBe(201);

    // Approve the lead
    const approval = await request(app)
      .post(`/api/leads/${created.body.lead.id}/approve`)
      .send();

    expect(approval.status).toBe(200);
    expect(approval.body.ok).toBe(true);

    // Verify NO call was initiated
    expect(callGateway.initiatedCalls).toHaveLength(0);
  });

  it("does NOT trigger a call when no CallGateway is configured", async () => {
    const emailGateway = new StubEmailGateway();

    const { app } = buildAppWithCalls({
      aiClient: new StubAiClient(82),
      whatsappGateway: new StubWhatsappGateway(),
      emailGateway,
      // No callGateway — mimics when Twilio is not configured
      callGateway: undefined
    });

    // Ingest a lead WITH a phone number
    const created = await request(app)
      .post("/api/webhooks/leads")
      .send({
        name: "Beast Boy",
        email: "beastboy@titans.com",
        phone: "+1-555-987-6543",
        message: "Need CRM help"
      });

    expect(created.status).toBe(201);

    // Approve the lead
    const approval = await request(app)
      .post(`/api/leads/${created.body.lead.id}/approve`)
      .send();

    expect(approval.status).toBe(200);
    expect(approval.body.ok).toBe(true);

    // Email should still be sent
    expect(emailGateway.sentEmails).toHaveLength(1);
  });
});

describe("Call log API endpoints", () => {
  it("GET /api/leads/:id/calls returns call logs for a lead", async () => {
    const { app, callLogRepository } = buildAppWithCalls();

    // Create a mock call log
    await callLogRepository.create({
      id: "call-1",
      leadId: "lead-1",
      fromNumber: "+15551234567",
      toNumber: "+15559876543",
      status: "completed"
    });

    await callLogRepository.update("call-1", {
      pickedUp: true,
      durationSeconds: 120,
      callOutcome: "interested",
      aiSummary: "Lead showed strong interest in CRM solution"
    });

    const response = await request(app)
      .get("/api/leads/lead-1/calls")
      .send();

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.count).toBe(1);
    expect(response.body.calls[0].pickedUp).toBe(true);
    expect(response.body.calls[0].durationSeconds).toBe(120);
    expect(response.body.calls[0].callOutcome).toBe("interested");
    expect(response.body.calls[0].aiSummary).toBe("Lead showed strong interest in CRM solution");
  });

  it("GET /api/calls/:id returns full call log detail", async () => {
    const { app, callLogRepository } = buildAppWithCalls();

    await callLogRepository.create({
      id: "call-detail-1",
      leadId: "lead-1",
      fromNumber: "+15551234567",
      toNumber: "+15559876543",
      status: "completed"
    });

    await callLogRepository.update("call-detail-1", {
      pickedUp: true,
      transcript: "AI Agent: Hello!\n\nLead: Hi there.",
      aiSummary: "Brief intro call"
    });

    const response = await request(app)
      .get("/api/calls/call-detail-1")
      .send();

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.call.transcript).toContain("Hello!");
    expect(response.body.call.aiSummary).toBe("Brief intro call");
  });

  it("GET /api/calls/:id returns 404 for unknown call", async () => {
    const { app } = buildAppWithCalls();

    const response = await request(app)
      .get("/api/calls/nonexistent")
      .send();

    expect(response.status).toBe(404);
    expect(response.body.ok).toBe(false);
  });
});

describe("Twilio webhook endpoints", () => {
  it("POST /api/calls/status accepts a status callback", async () => {
    const { app, callLogRepository } = buildAppWithCalls();

    // Create a call log to receive the status
    await callLogRepository.create({
      id: "status-call-1",
      leadId: "lead-1",
      twilioCallSid: "CA12345",
      fromNumber: "+15551234567",
      toNumber: "+15559876543"
    });

    const response = await request(app)
      .post("/api/calls/status")
      .send({
        CallSid: "CA12345",
        CallStatus: "ringing"
      });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it("POST /api/calls/status returns 400 for missing fields", async () => {
    const { app } = buildAppWithCalls();

    const response = await request(app)
      .post("/api/calls/status")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
  });
});
