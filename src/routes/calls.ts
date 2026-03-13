import { Router } from "express";

import { logger } from "../lib/logger.js";
import type { CallConversationService } from "../services/call-conversation-service.js";
import type { CallLogRepository } from "../repositories/call-log-repository.js";

/**
 * Call routes — Twilio TwiML webhooks + mobile app API for call logs.
 */
export function createCallRouter(
  callConversationService: CallConversationService,
  callLogRepository: CallLogRepository
): Router {
  const router = Router();

  // ——— POST /api/calls/twiml/:callLogId ———
  // Twilio hits this when the call is answered. Returns TwiML greeting + Gather.
  router.post("/api/calls/twiml/:callLogId", async (request, response) => {
    try {
      logger.info(
        { callLogId: request.params.callLogId },
        "Twilio TwiML webhook hit"
      );

      const twiml = await callConversationService.generateInitialTwiml(request.params.callLogId);

      response.type("text/xml");
      response.send(twiml);
    } catch (error) {
      logger.error({ err: error, callLogId: request.params.callLogId }, "TwiML generation failed");
      response.type("text/xml");
      response.send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Sorry, there was a technical issue. Goodbye!</Say><Hangup/></Response>'
      );
    }
  });

  // ——— POST /api/calls/gather/:callLogId ———
  // Twilio posts speech result here after lead speaks.
  router.post("/api/calls/gather/:callLogId", async (request, response) => {
    try {
      const speechResult = request.body.SpeechResult ?? request.body.Digits ?? "";

      logger.info(
        { callLogId: request.params.callLogId, speechResult },
        "Twilio Gather result received"
      );

      if (!speechResult) {
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
      response.send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Thank you for your time. Our team will follow up. Goodbye!</Say><Hangup/></Response>'
      );
    }
  });

  // ——— POST /api/calls/no-input/:callLogId ———
  router.post("/api/calls/no-input/:callLogId", async (request, response) => {
    try {
      const twiml = await callConversationService.handleNoInput(request.params.callLogId);
      response.type("text/xml");
      response.send(twiml);
    } catch (error) {
      logger.error({ err: error }, "No-input handling failed");
      response.type("text/xml");
      response.send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Goodbye!</Say><Hangup/></Response>'
      );
    }
  });

  // ——— POST /api/calls/status ———
  // Twilio status callback.
  router.post("/api/calls/status", async (request, response) => {
    try {
      const callSid = request.body.CallSid;
      const callStatus = request.body.CallStatus;
      const callDuration = request.body.CallDuration;

      logger.info({ callSid, callStatus, callDuration }, "Twilio status callback");

      if (!callSid || !callStatus) {
        response.status(400).json({ ok: false, error: "Missing CallSid or CallStatus" });
        return;
      }

      await callConversationService.handleStatusCallback(callSid, callStatus, callDuration);

      response.status(200).json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "Status callback failed");
      response.status(200).json({ ok: true });
    }
  });

  // ——— POST /api/calls/agent-webhook ———
  // Python AI agent webhook (VideoSDK). Kept for compatibility.
  router.post("/api/calls/agent-webhook", async (request, response) => {
    try {
      const { callLogId, leadId, durationSeconds, transcript, turnCount } = request.body;
      logger.info({ callLogId, leadId, durationSeconds, turnCount }, "Agent webhook received");

      if (callLogId) {
        await callConversationService.handleAgentWebhook({
          callLogId, leadId, roomId: "", durationSeconds: durationSeconds ?? 0,
          transcript: transcript ?? "", turnCount: turnCount ?? 0
        });
      }

      response.json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "Agent webhook failed");
      response.status(500).json({ ok: false });
    }
  });

  // ——— GET /api/leads/:id/calls ———
  router.get("/api/leads/:id/calls", async (request, response, next) => {
    try {
      const calls = await callLogRepository.findByLeadId(request.params.id);
      response.json({
        ok: true,
        count: calls.length,
        calls: calls.map((call) => ({
          id: call.id, status: call.status, pickedUp: call.pickedUp,
          durationSeconds: call.durationSeconds, callOutcome: call.callOutcome,
          aiSummary: call.aiSummary, createdAt: call.createdAt, updatedAt: call.updatedAt
        }))
      });
    } catch (error) { next(error); }
  });

  // ——— GET /api/calls/:id ———
  router.get("/api/calls/:id", async (request, response, next) => {
    try {
      const call = await callLogRepository.findById(request.params.id);
      if (!call) { response.status(404).json({ ok: false, error: "Not found" }); return; }
      response.json({ ok: true, call });
    } catch (error) { next(error); }
  });

  return router;
}
