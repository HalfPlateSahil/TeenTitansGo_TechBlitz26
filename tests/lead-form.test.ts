import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { InMemoryLeadRepository } from "../src/repositories/lead-repository.js";
import { HeuristicLeadAiClient } from "../src/services/ai-service.js";
import { LoggingEmailGateway } from "../src/services/email-service.js";
import { InMemoryFollowUpScheduler } from "../src/services/follow-up-service.js";
import { LeadService } from "../src/services/lead-service.js";
import { LoggingWhatsappGateway } from "../src/services/whatsapp-service.js";

function buildApp() {
  const repository = new InMemoryLeadRepository();
  const aiClient = new HeuristicLeadAiClient();
  const whatsappGateway = new LoggingWhatsappGateway();
  const emailGateway = new LoggingEmailGateway();
  const followUpScheduler = new InMemoryFollowUpScheduler();
  const leadService = new LeadService(repository, aiClient, whatsappGateway, emailGateway, followUpScheduler);
  return {
    repository,
    app: createApp(leadService, repository)
  };
}

describe("POST /api/leads/submit", () => {
  it("creates a lead from a valid form submission", async () => {
    const { repository, app } = buildApp();

    const response = await request(app)
      .post("/api/leads/submit")
      .send({
        name: "Robin",
        email: "robin@titans.com",
        message: "Need a CRM for inbound leads"
      });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.message).toContain("Robin");

    const leads = await repository.findAll();
    expect(leads).toHaveLength(1);
    expect(leads[0].name).toBe("Robin");
    expect(leads[0].source).toBe("website_form");
  });

  it("accepts a submission with phone only (no email)", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/api/leads/submit")
      .send({
        name: "Starfire",
        phone: "+1-555-867-5309",
        message: "Interested in a demo"
      });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
  });

  it("rejects when name is missing", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/api/leads/submit")
      .send({
        email: "robin@titans.com",
        message: "Need help"
      });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toBeDefined();
  });

  it("rejects when both email and phone are missing", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/api/leads/submit")
      .send({
        name: "Beast Boy",
        message: "Interested in the product"
      });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toContain("contact");
  });

  it("rejects when message is missing", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/api/leads/submit")
      .send({
        name: "Cyborg",
        email: "cyborg@titans.com"
      });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
  });
});
