import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { InMemoryLeadRepository } from "../src/repositories/lead-repository.js";
import { HeuristicLeadAiClient } from "../src/services/ai-service.js";
import { LoggingEmailGateway } from "../src/services/email-service.js";
import { InMemoryFollowUpScheduler } from "../src/services/follow-up-service.js";
import { LeadService } from "../src/services/lead-service.js";
import { LoggingWhatsappGateway } from "../src/services/whatsapp-service.js";
import type { DraftEmailInput, DraftedEmail, EmailGateway, FollowUpScheduler, LeadAiClient, WhatsappGateway } from "../src/types/pipeline.js";
import type { LeadEnrichmentResult } from "../src/types/pipeline.js";

class StubAiClient implements LeadAiClient {
  constructor(private readonly qualityScore: number) { }

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
}

class StubWhatsappGateway implements WhatsappGateway {
  readonly sentMessages: string[] = [];

  async sendApprovalRequest(lead: Parameters<WhatsappGateway["sendApprovalRequest"]>[0]): Promise<void> {
    this.sentMessages.push(lead.id);
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

function buildApp(options?: {
  repository?: InMemoryLeadRepository;
  aiClient?: LeadAiClient;
  whatsappGateway?: WhatsappGateway;
  emailGateway?: EmailGateway;
  followUpScheduler?: InMemoryFollowUpScheduler;
}) {
  const repository = options?.repository ?? new InMemoryLeadRepository();
  const aiClient = options?.aiClient ?? new HeuristicLeadAiClient();
  const whatsappGateway = options?.whatsappGateway ?? new LoggingWhatsappGateway();
  const emailGateway = options?.emailGateway ?? new LoggingEmailGateway();
  const followUpScheduler = options?.followUpScheduler ?? new InMemoryFollowUpScheduler();
  const leadService = new LeadService(repository, aiClient, whatsappGateway, emailGateway, followUpScheduler);

  return {
    repository,
    whatsappGateway,
    emailGateway,
    followUpScheduler,
    app: createApp(leadService)
  };
}

describe("POST /api/webhooks/leads", () => {
  it("creates a lead from a webhook payload", async () => {
    const repository = new InMemoryLeadRepository();
    const whatsappGateway = new StubWhatsappGateway();
    const { app } = buildApp({
      repository,
      aiClient: new StubAiClient(85),
      whatsappGateway
    });

    const response = await request(app)
      .post("/api/webhooks/leads")
      .send({
        name: "Robin",
        email: "robin@titans.com",
        message: "Need a CRM for inbound leads"
      });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.duplicate).toBe(false);
    expect(response.body.archived).toBe(false);
    expect(response.body.notified).toBe(true);
    expect(response.body.lead.status).toBe("review_needed");
    expect(response.body.lead.normalizedEmail).toBe("robin@titans.com");
    expect(response.body.lead.qualityScore).toBe(85);
    expect(whatsappGateway.sentMessages).toHaveLength(1);

    const events = await repository.findEventsByLeadId(response.body.lead.id);
    expect(events.map((event) => event.eventType)).toEqual(["approval_requested", "lead_scored", "lead_ingested"]);
  });

  it("returns duplicate when the same lead arrives again", async () => {
    const { app } = buildApp({
      repository: new InMemoryLeadRepository(),
      aiClient: new StubAiClient(70),
      whatsappGateway: new StubWhatsappGateway()
    });
    const payload = {
      name: "Starfire",
      email: "starfire@tamaran.com",
      message: "Interested in follow-up automation"
    };

    await request(app).post("/api/webhooks/leads").send(payload);
    const duplicateResponse = await request(app).post("/api/webhooks/leads").send(payload);

    expect(duplicateResponse.status).toBe(200);
    expect(duplicateResponse.body.duplicate).toBe(true);
    expect(duplicateResponse.body.duplicateMatch.confidence).toBe(1);
  });

  it("archives junk leads without notifying the owner", async () => {
    const whatsappGateway = new StubWhatsappGateway();
    const { app } = buildApp({
      repository: new InMemoryLeadRepository(),
      aiClient: new StubAiClient(10),
      whatsappGateway
    });

    const response = await request(app)
      .post("/api/webhooks/leads")
      .send({
        name: "Spam Sender",
        email: "spam@example.com",
        message: "Guest post backlinks casino SEO package"
      });

    expect(response.status).toBe(201);
    expect(response.body.archived).toBe(true);
    expect(response.body.notified).toBe(false);
    expect(response.body.lead.status).toBe("archived");
    expect(whatsappGateway.sentMessages).toHaveLength(0);
  });
});

describe("POST /api/whatsapp/messages", () => {
  it("approves the latest pending lead, sends email, and schedules a follow-up", async () => {
    const repository = new InMemoryLeadRepository();
    const whatsappGateway = new StubWhatsappGateway();
    const emailGateway = new StubEmailGateway();
    const followUpScheduler = new InMemoryFollowUpScheduler();
    const { app } = buildApp({
      repository,
      aiClient: new StubAiClient(82),
      whatsappGateway,
      emailGateway,
      followUpScheduler
    });

    const created = await request(app)
      .post("/api/webhooks/leads")
      .send({
        name: "Beast Boy",
        email: "beastboy@titans.com",
        message: "Need help automating our inbound sales follow-ups"
      });

    const approval = await request(app)
      .post("/api/whatsapp/messages")
      .send({
        body: "1"
      });

    expect(created.status).toBe(201);
    expect(approval.status).toBe(200);
    expect(approval.body.handled).toBe(true);
    expect(approval.body.action).toBe("approved");
    expect(approval.body.lead.status).toBe("approved");
    expect(emailGateway.sentEmails).toEqual([{ leadId: created.body.lead.id, kind: "initial" }]);
    expect(followUpScheduler.scheduledJobs).toHaveLength(1);
    expect(followUpScheduler.scheduledJobs[0]).toMatchObject({
      leadId: created.body.lead.id,
      step: 1
    });
  });
});
