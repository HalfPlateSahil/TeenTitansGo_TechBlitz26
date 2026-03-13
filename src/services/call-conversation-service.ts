import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { CallLogRepository } from "../repositories/call-log-repository.js";
import type { LeadRepository } from "../repositories/lead-repository.js";
import type { CallOutcome } from "../types/call.js";

// ——— In-memory conversation state per call ———
interface ConversationState {
  leadId: string;
  turnCount: number;
  transcript: string[];
  maxTurns: number;
}

const conversations = new Map<string, ConversationState>();

export interface AgentWebhookPayload {
  callLogId: string;
  leadId: string;
  roomId?: string;
  durationSeconds: number;
  transcript: string;
  turnCount: number;
}

/**
 * Manages AI phone conversations via Twilio TwiML.
 *
 * - generateInitialTwiml: returns instant static greeting + <Gather> for speech
 * - handleGatherResult: processes lead speech, gets Gemini AI response, returns TwiML
 * - handleNoInput: handles silence timeout
 * - handleStatusCallback: updates call status
 * - handleAgentWebhook: processes VideoSDK agent results (kept for compatibility)
 */
export class CallConversationService {
  constructor(
    private readonly callLogRepository: CallLogRepository,
    private readonly leadRepository: LeadRepository
  ) {}

  /**
   * Generate the initial TwiML when Twilio connects the call.
   * Returns an INSTANT static greeting (no Gemini call) to avoid Twilio timeout.
   */
  async generateInitialTwiml(callLogId: string): Promise<string> {
    logger.info({ callLogId }, "Generating initial TwiML");

    // Look up the call log to get lead info
    const callLog = await this.callLogRepository.findById(callLogId);
    const lead = callLog?.leadId
      ? await this.leadRepository.findById(callLog.leadId)
      : null;

    // Initialize conversation state
    conversations.set(callLogId, {
      leadId: callLog?.leadId ?? "",
      turnCount: 0,
      transcript: [],
      maxTurns: 8
    });

    // Update status
    if (callLog) {
      await this.callLogRepository.update(callLogId, { status: "in-progress", pickedUp: true });
    }

    const leadName = lead?.name ? lead.name.split(" ")[0] : "there";
    const greeting = `Hi ${leadName}! This is the team following up on your inquiry. How can we help you today?`;

    const gatherUrl = `${env.appBaseUrl}/api/calls/gather/${callLogId}`;
    const noInputUrl = `${env.appBaseUrl}/api/calls/no-input/${callLogId}`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${this.escapeXml(greeting)}</Say>
  <Gather input="speech" speechTimeout="3" timeout="8" action="${gatherUrl}" method="POST">
    <Say voice="alice">I am listening.</Say>
  </Gather>
  <Redirect method="POST">${noInputUrl}</Redirect>
</Response>`;
  }

  /**
   * Handle speech from the lead. Send to Gemini, return AI response as TwiML.
   */
  async handleGatherResult(callLogId: string, speechText: string): Promise<string> {
    logger.info({ callLogId, speechText }, "Processing speech from lead");

    const state = conversations.get(callLogId);
    if (!state) {
      return this.buildSayHangupTwiml("Thank you for your time. Our team will be in touch. Goodbye!");
    }

    // Record lead speech
    state.transcript.push(`Lead: ${speechText}`);
    state.turnCount++;

    // Check if we've hit max turns
    if (state.turnCount >= state.maxTurns) {
      const farewell = "Thank you so much for your time today. Our team will follow up with all the details. Have a great day!";
      state.transcript.push(`AI: ${farewell}`);
      await this.finalizeCall(callLogId, state);
      return this.buildSayHangupTwiml(farewell);
    }

    // Get AI response from Gemini
    const aiResponse = await this.getGeminiResponse(callLogId, speechText, state);
    state.transcript.push(`AI: ${aiResponse}`);

    // Build gather TwiML for next turn
    return this.buildGatherTwiml(callLogId, aiResponse);
  }

  /**
   * Handle silence / no input from the lead.
   */
  async handleNoInput(callLogId: string): Promise<string> {
    const state = conversations.get(callLogId);

    if (!state || state.turnCount === 0) {
      // First timeout — try once more
      return this.buildGatherTwiml(
        callLogId,
        "Hello? Are you still there? I would love to help you with your inquiry."
      );
    }

    // Already had a conversation — wrap up
    const farewell = "It seems like you might be busy. Our team will follow up via email. Thank you and goodbye!";
    if (state) {
      state.transcript.push(`AI: ${farewell}`);
      await this.finalizeCall(callLogId, state);
    }
    return this.buildSayHangupTwiml(farewell);
  }

  /**
   * Handle Twilio status callbacks.
   */
  async handleStatusCallback(
    callSid: string,
    callStatus: string,
    callDuration?: string
  ): Promise<void> {
    logger.info({ callSid, callStatus, callDuration }, "Call status callback");

    const callLog = await this.callLogRepository.findByTwilioCallSid(callSid);
    if (!callLog) {
      logger.warn({ callSid }, "Status callback for unknown call");
      return;
    }

    const statusMap: Record<string, string> = {
      queued: "initiated", ringing: "ringing", "in-progress": "in-progress",
      completed: "completed", "no-answer": "no-answer", busy: "busy",
      failed: "failed", canceled: "canceled"
    };

    const mapped = statusMap[callStatus] ?? callStatus;
    const duration = callDuration ? parseInt(callDuration, 10) : undefined;
    const patch: Record<string, unknown> = { status: mapped };

    if (duration !== undefined) patch.durationSeconds = duration;

    if (["no-answer", "busy", "failed", "canceled"].includes(mapped)) {
      patch.pickedUp = false;
      patch.callOutcome = mapped === "no-answer" ? "no_answer" : "failed";
    }

    // If completed, finalize the call
    if (mapped === "completed") {
      const state = conversations.get(callLog.id);
      if (state && state.transcript.length > 0) {
        await this.finalizeCall(callLog.id, state);
      }
    }

    await this.callLogRepository.update(callLog.id, patch as any);
  }

  /**
   * Handle VideoSDK agent webhook (kept for compatibility).
   */
  async handleAgentWebhook(payload: AgentWebhookPayload): Promise<void> {
    const { callLogId, leadId, durationSeconds, transcript, turnCount } = payload;
    logger.info({ callLogId, leadId, durationSeconds, turnCount }, "Agent webhook");

    const summary = transcript
      ? await this.generateCallSummary(transcript, leadId)
      : `Call duration: ${durationSeconds}s.`;

    const outcome = transcript ? await this.determineCallOutcome(transcript) : "unknown";

    await this.callLogRepository.update(callLogId, {
      transcript, aiSummary: summary, callOutcome: outcome,
      durationSeconds, pickedUp: durationSeconds > 0 && turnCount > 0, status: "completed"
    });
  }

  // ————————————————————————————————————
  //  Private helpers
  // ————————————————————————————————————

  private buildGatherTwiml(callLogId: string, sayText: string): string {
    const gatherUrl = `${env.appBaseUrl}/api/calls/gather/${callLogId}`;
    const noInputUrl = `${env.appBaseUrl}/api/calls/no-input/${callLogId}`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="3" timeout="10" action="${gatherUrl}" method="POST">
    <Say voice="alice">${this.escapeXml(sayText)}</Say>
  </Gather>
  <Redirect method="POST">${noInputUrl}</Redirect>
</Response>`;
  }

  private buildSayHangupTwiml(text: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${this.escapeXml(text)}</Say>
  <Hangup/>
</Response>`;
  }

  private escapeXml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  private async getGeminiResponse(
    callLogId: string,
    userText: string,
    state: ConversationState
  ): Promise<string> {
    const fallback = "That's great to hear. Could you tell me more about what you're looking for?";

    if (!env.geminiApiKey) return fallback;

    const lead = state.leadId ? await this.leadRepository.findById(state.leadId) : null;

    const prompt = [
      "You are a professional, friendly AI sales assistant on a phone call.",
      "Generate a CONCISE response (2-3 sentences max) to the customer.",
      "Be helpful and natural. Do NOT use markdown or special characters.",
      "",
      lead ? `Customer: ${lead.name}` : "",
      lead ? `Original inquiry: ${lead.inquiryText}` : "",
      "",
      "Conversation so far:",
      ...state.transcript.slice(-6),
      "",
      `Customer just said: "${userText}"`,
      "",
      'Return JSON: { "response": "your reply here" }'
    ].filter(Boolean).join("\n");

    try {
      const data = await this.callGemini<{ response: string }>(prompt);
      return data.response || fallback;
    } catch (e) {
      logger.error({ err: e }, "Gemini response failed, using fallback");
      return fallback;
    }
  }

  private async finalizeCall(callLogId: string, state: ConversationState): Promise<void> {
    const transcript = state.transcript.join("\n\n");
    const summary = await this.generateCallSummary(transcript, state.leadId);
    const outcome = await this.determineCallOutcome(transcript);

    await this.callLogRepository.update(callLogId, {
      transcript, aiSummary: summary, callOutcome: outcome,
      pickedUp: true, status: "completed"
    });

    if (state.leadId) {
      await this.leadRepository.addEvent({
        leadId: state.leadId, eventType: "outbound_call_completed", actor: "system",
        payload: { callLogId, outcome, summary: summary.slice(0, 200), turnCount: state.turnCount }
      });
    }

    conversations.delete(callLogId);
    logger.info({ callLogId, turnCount: state.turnCount, outcome }, "Call finalized");
  }

  private async generateCallSummary(transcript: string, leadId: string): Promise<string> {
    const fallback = `Call completed. ${transcript.split("\n").length} turns.`;
    if (!env.geminiApiKey) return fallback;

    const prompt = [
      "Summarize this phone call in 2-3 sentences. Include key points and next steps.",
      'Return JSON: { "summary": "..." }',
      "", "Transcript:", transcript
    ].join("\n");

    try {
      const data = await this.callGemini<{ summary: string }>(prompt);
      return data.summary || fallback;
    } catch { return fallback; }
  }

  private async determineCallOutcome(transcript: string): Promise<CallOutcome> {
    if (!env.geminiApiKey) return "unknown";

    const prompt = [
      "Determine the outcome of this call.",
      'Return JSON: { "outcome": "interested" | "not_interested" | "callback_requested" | "unknown" }',
      "", "Transcript:", transcript
    ].join("\n");

    try {
      const data = await this.callGemini<{ outcome: CallOutcome }>(prompt);
      return data.outcome || "unknown";
    } catch { return "unknown"; }
  }

  private async callGemini<T>(prompt: string): Promise<T> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });

    if (!response.ok) throw new Error(`Gemini ${response.status}`);

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("\n") ?? "";
    const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start === -1 || end === -1) throw new Error("No JSON in Gemini response");
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  }
}
