import { Router } from "express";
import { z } from "zod";

import { LeadService } from "../services/lead-service.js";

const formPayloadSchema = z.object({
  name: z.string().min(1, "Name is required."),
  email: z.string().email("Invalid email address.").optional().or(z.literal("")),
  phone: z.string().min(7, "Phone number is too short.").optional().or(z.literal("")),
  company: z.string().optional().or(z.literal("")),
  message: z.string().min(1, "Message is required.")
}).refine(
  (data) => Boolean(data.email) || Boolean(data.phone),
  { message: "At least one contact method (email or phone) is required.", path: ["email"] }
);

export function createLeadFormRouter(leadService: LeadService): Router {
  const router = Router();

  router.post("/api/leads/submit", async (request, response, next) => {
    try {
      const parsed = formPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        response.status(400).json({
          ok: false,
          error: firstIssue?.message ?? "Invalid form data."
        });
        return;
      }

      const { name, email, phone, company, message } = parsed.data;

      const webhookPayload = {
        name,
        email: email || undefined,
        phone: phone || undefined,
        company: company || undefined,
        message,
        source: "website_form"
      };

      const result = await leadService.ingest(webhookPayload, "website_form");

      response.status(result.duplicate ? 200 : 201).json({
        ok: true,
        message: `Thank you, ${name.split(" ")[0]}! We've received your inquiry.`
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
