import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { createId } from "../utils/ids.js";
import type { LeadRecord } from "../types/lead.js";
import type { CallGateway } from "../types/pipeline.js";
import type { CallLogRepository } from "../repositories/call-log-repository.js";

/**
 * Normalize a phone number to E.164 format.
 */
function toE164(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+") && cleaned.length >= 11) {
    return cleaned;
  }

  const digits = cleaned.replace(/\+/g, "");

  // Indian number (10 digits starting with 6-9)
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `+91${digits}`;
  }

  if (digits.length >= 11) {
    return `+${digits}`;
  }

  // US/Canada 10-digit
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  return `+${digits}`;
}

/**
 * Twilio-powered call gateway.
 * Places real outbound calls using the Twilio REST API.
 * The AI conversation is handled via TwiML webhooks (Say + Gather) served
 * by CallConversationService through the /api/calls routes.
 */
export class TwilioCallGateway implements CallGateway {
  constructor(private readonly callLogRepository: CallLogRepository) {}

  async initiateCall(lead: LeadRecord): Promise<{ callSid: string; callLogId: string }> {
    if (!lead.phone && !lead.normalizedPhone) {
      throw new Error(`Lead ${lead.id} has no phone number for calling.`);
    }

    const rawPhone = lead.normalizedPhone ?? lead.phone!;
    const phoneNumber = toE164(rawPhone);
    const callLogId = createId();

    logger.info(
      { leadId: lead.id, rawPhone, e164Phone: phoneNumber, callLogId },
      "Initiating outbound call via Twilio"
    );

    // Create call log record
    await this.callLogRepository.create({
      id: callLogId,
      leadId: lead.id,
      fromNumber: env.twilioPhoneNumber ?? "unknown",
      toNumber: phoneNumber,
      status: "initiated"
    });

    // Build webhook URLs
    const twimlUrl = `${env.appBaseUrl}/api/calls/twiml/${callLogId}`;
    const statusCallbackUrl = `${env.appBaseUrl}/api/calls/status`;

    logger.info({ twimlUrl, statusCallbackUrl }, "Twilio webhook URLs");

    // Twilio REST API — create outbound call
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Calls.json`;
    const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString("base64");

    const params = new URLSearchParams();
    params.append("To", phoneNumber);
    params.append("From", env.twilioPhoneNumber!);
    params.append("Url", twimlUrl);
    params.append("StatusCallback", statusCallbackUrl);
    params.append("StatusCallbackMethod", "POST");
    params.append("Method", "POST");
    params.append("Timeout", "30");

    const response = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody }, "Twilio call creation failed");
      await this.callLogRepository.update(callLogId, { status: "failed" });
      throw new Error(`Twilio call failed: ${response.status}`);
    }

    const callData = (await response.json()) as { sid: string };
    const callSid = callData.sid;

    // Store the Twilio Call SID
    await this.callLogRepository.update(callLogId, { twilioCallSid: callSid });

    logger.info(
      { callLogId, callSid, leadId: lead.id, to: phoneNumber },
      "Outbound call created via Twilio"
    );

    return { callSid, callLogId };
  }
}

/**
 * Fallback gateway that just logs (when Twilio is not configured).
 */
export class LoggingCallGateway implements CallGateway {
  async initiateCall(lead: LeadRecord): Promise<{ callSid: string; callLogId: string }> {
    const callLogId = `dry-run-${createId()}`;
    const callSid = `dry-run-sid-${createId()}`;

    logger.warn(
      {
        leadId: lead.id,
        phone: lead.normalizedPhone ?? lead.phone,
        callLogId,
        callSid
      },
      "Calling is not configured — call logged but not placed"
    );

    return { callSid, callLogId };
  }
}
