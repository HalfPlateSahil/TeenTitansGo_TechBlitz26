import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { CallLogRepository } from "../repositories/call-log-repository.js";
import type { LeadRepository } from "../repositories/lead-repository.js";
import type { CallConversationState, CallOutcome } from "../types/call.js";

/**
 * Manages the AI-powered conversation during a Twilio call.
 * Uses Twilio's turn-based <Say> + <Gather> approach:
 *   1. Twilio calls the lead
 *   2. TwiML responds with <Say> (AI greeting) + <Gather> (listen for speech)
 *   3. Lead speaks → Twilio transcribes → posts to /api/calls/gather/:id
 *   4. Gemini generates response → TwiML <Say> + <Gather> again
 *   5. Loop continues until conversation ends or max turns reached
 */

const MAX_CONVERSATION_TURNS = 10;

// In-memory store for active conversation states (keyed by callLogId)
const activeConversations = new Map<string, CallConversationState>();

export class CallConversationService {
  constructor(
    private readonly callLogRepository: CallLogRepository,
    private readonly leadRepository: LeadRepository
  ) {}

  /**
   * Generate the initial TwiML when the call is first answered.
   */
  async generateInitialTwiml(callLogId: string): Promise<string> {
    const callLog = await this.callLogRepository.findById(callLogId);
    if (!callLog) {
      logger.error({ callLogId }, "Call log not found for TwiML generation");
      return this.buildHangupTwiml("Sorry, there was an error connecting your call.");
    }

    const lead = await this.leadRepository.findById(callLog.leadId);
    if (!lead) {
      logger.error({ callLogId, leadId: callLog.leadId }, "Lead not found for call");
      return this.buildHangupTwiml("Sorry, there was an error connecting your call.");
    }

    // Mark call as picked up
    await this.callLogRepository.update(callLogId, {
      pickedUp: true,
      status: "in-progress"
    });

    // Initialize conversation state
    const state: CallConversationState = {
      callLogId,
      leadId: lead.id,
      leadName: lead.name,
      leadInquiry: lead.inquiryText,
      leadAiSummary: lead.aiSummary,
      turns: []
    };

    // Generate AI greeting
    const greeting = await this.generateAiGreeting(state);
    state.turns.push({ role: "ai", text: greeting });
    activeConversations.set(callLogId, state);

    logger.info({ callLogId, leadId: lead.id }, "Call answered — starting AI conversation");

    return this.buildGatherTwiml(greeting, callLogId);
  }

  /**
   * Handle the lead's speech input from Twilio's <Gather> result.
   */
  async handleGatherResult(callLogId: string, speechResult: string): Promise<string> {
    const state = activeConversations.get(callLogId);
    if (!state) {
      logger.warn({ callLogId }, "No active conversation state found");
      return this.buildHangupTwiml("Thank you for your time. We will follow up soon. Goodbye!");
    }

    // Record what the lead said
    state.turns.push({ role: "lead", text: speechResult });

    // Check if we've hit max turns
    if (state.turns.length >= MAX_CONVERSATION_TURNS * 2) {
      const closingMessage = "Thank you so much for your time today! We've covered a lot and I'll make sure our team follows up with all the details. Have a wonderful day!";
      state.turns.push({ role: "ai", text: closingMessage });
      
      // Finalize the conversation
      await this.finalizeConversation(callLogId, state);
      return this.buildHangupTwiml(closingMessage);
    }

    // Generate AI response using Gemini
    const aiResponse = await this.generateAiResponse(state, speechResult);
    state.turns.push({ role: "ai", text: aiResponse });

    // Check if the AI decided to end the conversation
    if (this.shouldEndConversation(aiResponse, state)) {
      await this.finalizeConversation(callLogId, state);
      return this.buildHangupTwiml(aiResponse);
    }

    activeConversations.set(callLogId, state);
    return this.buildGatherTwiml(aiResponse, callLogId);
  }

  /**
   * Handle Twilio status callback updates.
   */
  async handleStatusCallback(
    callSid: string,
    callStatus: string,
    callDuration?: string
  ): Promise<void> {
    const callLog = await this.callLogRepository.findByTwilioCallSid(callSid);
    if (!callLog) {
      logger.warn({ callSid, callStatus }, "Received status callback for unknown call SID");
      return;
    }

    const statusMap: Record<string, string> = {
      "queued": "initiated",
      "ringing": "ringing",
      "in-progress": "in-progress",
      "completed": "completed",
      "no-answer": "no-answer",
      "busy": "busy",
      "failed": "failed",
      "canceled": "canceled"
    };

    const mappedStatus = statusMap[callStatus] ?? callStatus;
    const duration = callDuration ? parseInt(callDuration, 10) : undefined;

    const patch: Record<string, unknown> = {
      status: mappedStatus
    };

    if (duration !== undefined) {
      patch.durationSeconds = duration;
    }

    // If call ended without being picked up
    if (["no-answer", "busy", "failed", "canceled"].includes(mappedStatus)) {
      patch.pickedUp = false;
      patch.callOutcome = mappedStatus === "no-answer" ? "no_answer" : "failed";

      // Log event
      await this.leadRepository.addEvent({
        leadId: callLog.leadId,
        eventType: "outbound_call_ended",
        actor: "twilio",
        payload: {
          callLogId: callLog.id,
          status: mappedStatus,
          pickedUp: false
        }
      });
    }

    // If call completed normally, finalize conversation
    if (mappedStatus === "completed") {
      patch.durationSeconds = duration ?? 0;
      const state = activeConversations.get(callLog.id);
      if (state && state.turns.length > 0) {
        await this.finalizeConversation(callLog.id, state);
      } else {
        // Call was completed but no conversation happened (maybe voicemail)
        patch.callOutcome = "voicemail";
      }
    }

    await this.callLogRepository.update(callLog.id, patch as any);

    logger.info(
      { callLogId: callLog.id, callSid, status: mappedStatus, duration },
      "Call status updated"
    );
  }

  /**
   * Finalize a conversation — generate summary, store transcript, log events.
   */
  private async finalizeConversation(callLogId: string, state: CallConversationState): Promise<void> {
    // Build transcript
    const transcript = state.turns
      .map((turn) => `${turn.role === "ai" ? "AI Agent" : "Lead"}: ${turn.text}`)
      .join("\n\n");

    // Generate AI summary of the call
    const summary = await this.generateCallSummary(state);

    // Determine call outcome
    const outcome = await this.determineCallOutcome(state);

    // Update call log
    await this.callLogRepository.update(callLogId, {
      transcript,
      aiSummary: summary,
      callOutcome: outcome,
      status: "completed"
    });

    // Add event to lead timeline
    await this.leadRepository.addEvent({
      leadId: state.leadId,
      eventType: "outbound_call_completed",
      actor: "system",
      payload: {
        callLogId,
        durationTurns: state.turns.length,
        outcome,
        summary
      }
    });

    // Clean up active conversation
    activeConversations.delete(callLogId);

    logger.info(
      { callLogId, leadId: state.leadId, outcome, turns: state.turns.length },
      "Call conversation finalized"
    );
  }

  /**
   * Generate a greeting using Gemini.
   */
  private async generateAiGreeting(state: CallConversationState): Promise<string> {
    if (!env.geminiApiKey) {
      return `Hello ${state.leadName}! This is an AI assistant calling on behalf of our team. You recently reached out to us about ${state.leadInquiry}. I would love to learn more about what you're looking for. Could you tell me a bit more about your needs?`;
    }

    const prompt = [
      "You are a friendly, professional AI sales assistant making an outbound call to a lead.",
      "Generate a natural opening greeting for this phone call.",
      "Keep it under 40 words. Be warm but professional. Do NOT be pushy.",
      "Return valid JSON only: { \"greeting\": \"string\" }",
      "",
      `Lead name: ${state.leadName}`,
      `Their inquiry: ${state.leadInquiry}`,
      state.leadAiSummary ? `Context: ${state.leadAiSummary}` : ""
    ].filter(Boolean).join("\n");

    try {
      const data = await this.requestGeminiJson<{ greeting: string }>(prompt);
      return data.greeting || `Hello ${state.leadName}! Thanks for reaching out to us. I'd love to learn more about what you're looking for.`;
    } catch (error) {
      logger.warn({ err: error }, "Gemini greeting generation failed, using fallback");
      return `Hello ${state.leadName}! This is an AI assistant calling on behalf of our team. You recently reached out about ${state.leadInquiry}. Could you tell me more about what you need?`;
    }
  }

  /**
   * Generate an AI response using Gemini based on conversation context.
   */
  private async generateAiResponse(state: CallConversationState, leadSpeech: string): Promise<string> {
    if (!env.geminiApiKey) {
      return `That's really helpful, thank you for sharing that. Let me make sure our team gets back to you with the right information. Is there anything else you'd like to know?`;
    }

    const conversationHistory = state.turns
      .map((turn) => `${turn.role === "ai" ? "You (AI)" : "Lead"}: ${turn.text}`)
      .join("\n");

    const prompt = [
      "You are a friendly, professional AI sales assistant on a phone call with a lead.",
      "Generate your next response in the conversation.",
      "Rules:",
      "- Keep responses under 50 words (this is a phone call, be concise)",
      "- Be helpful, warm, and professional",
      "- Ask relevant follow-up questions to understand their needs",
      "- Do NOT make promises you can't keep",
      "- If they seem uninterested, gracefully wrap up the call",
      "- If they ask something you can't answer, say the team will follow up",
      "- Return valid JSON only: { \"response\": \"string\", \"shouldEnd\": boolean }",
      "",
      `Lead name: ${state.leadName}`,
      `Their original inquiry: ${state.leadInquiry}`,
      state.leadAiSummary ? `Context: ${state.leadAiSummary}` : "",
      "",
      "Conversation so far:",
      conversationHistory,
      "",
      `Lead just said: "${leadSpeech}"`
    ].filter(Boolean).join("\n");

    try {
      const data = await this.requestGeminiJson<{ response: string; shouldEnd?: boolean }>(prompt);
      return data.response || "Thank you for sharing that. Our team will definitely follow up with more details.";
    } catch (error) {
      logger.warn({ err: error }, "Gemini response generation failed, using fallback");
      return "I appreciate you sharing that. Let me make sure the right person from our team connects with you for the next steps. Thank you for your time!";
    }
  }

  /**
   * Generate a post-call summary using Gemini.
   */
  private async generateCallSummary(state: CallConversationState): Promise<string> {
    if (!env.geminiApiKey) {
      return `Call with ${state.leadName} regarding "${state.leadInquiry}". ${state.turns.length} conversation turns.`;
    }

    const transcript = state.turns
      .map((turn) => `${turn.role === "ai" ? "AI Agent" : "Lead"}: ${turn.text}`)
      .join("\n");

    const prompt = [
      "You are analyzing a completed phone call between an AI sales assistant and a lead.",
      "Generate a concise summary of the call.",
      "Return valid JSON only:",
      '{ "summary": "string (2-3 sentences covering key points discussed, lead interest level, and any action items)" }',
      "",
      `Lead name: ${state.leadName}`,
      `Original inquiry: ${state.leadInquiry}`,
      "",
      "Full transcript:",
      transcript
    ].join("\n");

    try {
      const data = await this.requestGeminiJson<{ summary: string }>(prompt);
      return data.summary || `Call completed with ${state.leadName}. ${state.turns.length} turns in the conversation.`;
    } catch (error) {
      logger.warn({ err: error }, "Gemini call summary generation failed");
      return `Call completed with ${state.leadName} regarding "${state.leadInquiry}". Total conversation turns: ${state.turns.length}.`;
    }
  }

  /**
   * Determine the call outcome using Gemini.
   */
  private async determineCallOutcome(state: CallConversationState): Promise<CallOutcome> {
    if (!env.geminiApiKey || state.turns.length < 2) {
      return "unknown";
    }

    const transcript = state.turns
      .map((turn) => `${turn.role === "ai" ? "AI Agent" : "Lead"}: ${turn.text}`)
      .join("\n");

    const prompt = [
      "Analyze this call transcript and determine the outcome.",
      'Return valid JSON only: { "outcome": "interested" | "not_interested" | "callback_requested" | "unknown" }',
      "",
      "Transcript:",
      transcript
    ].join("\n");

    try {
      const data = await this.requestGeminiJson<{ outcome: CallOutcome }>(prompt);
      return data.outcome || "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * Check if the conversation should end based on AI response signals.
   */
  private shouldEndConversation(aiResponse: string, state: CallConversationState): boolean {
    const endSignals = ["goodbye", "have a great day", "thank you for your time", "we'll follow up", "will follow up"];
    const lowerResponse = aiResponse.toLowerCase();
    
    // End if AI response contains closing signals and we have enough turns
    if (state.turns.length >= 4 && endSignals.some((signal) => lowerResponse.includes(signal))) {
      return true;
    }

    return false;
  }

  // ——— TwiML Builders ———

  private buildGatherTwiml(sayText: string, callLogId: string): string {
    const gatherUrl = `${env.appBaseUrl}/api/calls/gather/${callLogId}`;
    const noInputUrl = `${env.appBaseUrl}/api/calls/no-input/${callLogId}`;

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      `  <Gather input="speech" action="${gatherUrl}" method="POST" speechTimeout="3" language="en-US" enhanced="true">`,
      `    <Say voice="Polly.Joanna">${this.escapeXml(sayText)}</Say>`,
      "  </Gather>",
      `  <Redirect method="POST">${noInputUrl}</Redirect>`,
      "</Response>"
    ].join("\n");
  }

  private buildHangupTwiml(sayText: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      `  <Say voice="Polly.Joanna">${this.escapeXml(sayText)}</Say>`,
      "  <Hangup/>",
      "</Response>"
    ].join("\n");
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  // ——— Gemini Helpers ———

  private async requestGeminiJson<T>(prompt: string): Promise<T> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("\n") ?? "";
    const trimmed = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Gemini response did not include a JSON object.");
    }

    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  }

  /**
   * Handle no-input timeout (lead didn't speak).
   */
  async handleNoInput(callLogId: string): Promise<string> {
    const state = activeConversations.get(callLogId);
    
    if (!state) {
      return this.buildHangupTwiml("It seems we have a connection issue. Our team will reach out to you soon. Goodbye!");
    }

    // Count how many times we've had no input
    const noInputCount = state.turns.filter((t) => t.role === "lead" && t.text === "[no input]").length;

    if (noInputCount >= 2) {
      const closingMessage = "I understand you might be busy right now. Our team will follow up with you via email instead. Thank you and goodbye!";
      state.turns.push({ role: "ai", text: closingMessage });
      await this.finalizeConversation(callLogId, state);
      return this.buildHangupTwiml(closingMessage);
    }

    state.turns.push({ role: "lead", text: "[no input]" });
    const prompt = "I'm sorry, I didn't quite catch that. Could you please repeat?";
    state.turns.push({ role: "ai", text: prompt });
    activeConversations.set(callLogId, state);

    return this.buildGatherTwiml(prompt, callLogId);
  }
}
