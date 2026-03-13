import { Router } from "express";

import { logger } from "../lib/logger.js";
import { CallConversationService } from "../services/call-conversation-service.js";
import type { CallLogRepository } from "../repositories/call-log-repository.js";

/**
 * Call routes — Twilio webhooks + mobile app API for call logs.
 */
export function createCallRouter(
  callConversationService: CallConversationService,
  callLogRepository: CallLogRepository
): Router {
  const router = Router();

  // ——— POST /api/calls/twiml/:callLogId ———
  // Twilio calls this webhook when the outbound call is answered.
  // Returns TwiML with AI greeting + <Gather> for lead's speech.
  router.post("/api/calls/twiml/:callLogId", async (request, response, next) => {
    try {
      const twiml = await callConversationService.generateInitialTwiml(request.params.callLogId);

      response.type("text/xml");
      response.send(twiml);
    } catch (error) {
      logger.error({ err: error, callLogId: request.params.callLogId }, "TwiML generation failed");
      response.type("text/xml");
      response.send([
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<Response>",
        '  <Say voice="Polly.Joanna">Sorry, there was a technical issue. Our team will reach out to you shortly. Goodbye!</Say>',
        "  <Hangup/>",
        "</Response>"
      ].join("\n"));
    }
  });

  // ——— POST /api/calls/gather/:callLogId ———
  // Twilio posts <Gather> result (lead's speech) here.
  // Returns TwiML with AI response + next <Gather>.
  router.post("/api/calls/gather/:callLogId", async (request, response, next) => {
    try {
      const speechResult = request.body.SpeechResult ?? request.body.Digits ?? "";

      if (!speechResult) {
        // No input detected, handle timeout
        const twiml = await callConversationService.handleNoInput(request.params.callLogId);
        response.type("text/xml");
        response.send(twiml);
        return;
      }

      const twiml = await callConversationService.handleGatherResult(
        request.params.callLogId,
        speechResult
      );

      response.type("text/xml");
      response.send(twiml);
    } catch (error) {
      logger.error({ err: error, callLogId: request.params.callLogId }, "Gather handling failed");
      response.type("text/xml");
      response.send([
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<Response>",
        '  <Say voice="Polly.Joanna">Thank you for your time. Our team will follow up with you soon. Goodbye!</Say>',
        "  <Hangup/>",
        "</Response>"
      ].join("\n"));
    }
  });

  // ——— POST /api/calls/no-input/:callLogId ———
  // Fallback when <Gather> times out without any speech.
  router.post("/api/calls/no-input/:callLogId", async (request, response, next) => {
    try {
      const twiml = await callConversationService.handleNoInput(request.params.callLogId);
      response.type("text/xml");
      response.send(twiml);
    } catch (error) {
      logger.error({ err: error, callLogId: request.params.callLogId }, "No-input handling failed");
      response.type("text/xml");
      response.send([
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<Response>",
        '  <Say voice="Polly.Joanna">Goodbye!</Say>',
        "  <Hangup/>",
        "</Response>"
      ].join("\n"));
    }
  });

  // ——— POST /api/calls/status ———
  // Twilio status callback — updates call status in our database.
  router.post("/api/calls/status", async (request, response, next) => {
    try {
      const callSid = request.body.CallSid as string;
      const callStatus = request.body.CallStatus as string;
      const callDuration = request.body.CallDuration as string | undefined;

      if (!callSid || !callStatus) {
        response.status(400).json({ ok: false, error: "Missing CallSid or CallStatus" });
        return;
      }

      await callConversationService.handleStatusCallback(callSid, callStatus, callDuration);

      response.status(200).json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "Status callback handling failed");
      // Always return 200 to Twilio to prevent retries
      response.status(200).json({ ok: true });
    }
  });

  // ——— GET /api/leads/:id/calls ———
  // List all call logs for a lead (for the mobile app).
  router.get("/api/leads/:id/calls", async (request, response, next) => {
    try {
      const calls = await callLogRepository.findByLeadId(request.params.id);

      response.json({
        ok: true,
        count: calls.length,
        calls: calls.map((call) => ({
          id: call.id,
          status: call.status,
          pickedUp: call.pickedUp,
          durationSeconds: call.durationSeconds,
          callOutcome: call.callOutcome,
          aiSummary: call.aiSummary,
          createdAt: call.createdAt,
          updatedAt: call.updatedAt
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  // ——— GET /api/calls/:id ———
  // Full call log detail with transcript and summary.
  router.get("/api/calls/:id", async (request, response, next) => {
    try {
      const call = await callLogRepository.findById(request.params.id);
      if (!call) {
        response.status(404).json({ ok: false, error: "Call log not found" });
        return;
      }

      response.json({ ok: true, call });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
