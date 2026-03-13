import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { createId } from "../utils/ids.js";
import type { LeadRecord } from "../types/lead.js";
import type { CallGateway } from "../types/pipeline.js";
import type { CallLogRepository } from "../repositories/call-log-repository.js";

export class TwilioCallGateway implements CallGateway {
  constructor(private readonly callLogRepository: CallLogRepository) {}

  async initiateCall(lead: LeadRecord): Promise<{ callSid: string; callLogId: string }> {
    if (!lead.phone && !lead.normalizedPhone) {
      throw new Error(`Lead ${lead.id} has no phone number for calling.`);
    }

    const phoneNumber = lead.normalizedPhone ?? lead.phone!;
    const callLogId = createId();

    // Create call log record first
    await this.callLogRepository.create({
      id: callLogId,
      leadId: lead.id,
      fromNumber: env.twilioPhoneNumber!,
      toNumber: phoneNumber,
      status: "initiated"
    });

    // Initiate outbound call via Twilio REST API
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Calls.json`;
    const twimlUrl = `${env.appBaseUrl}/api/calls/twiml/${callLogId}`;
    const statusCallbackUrl = `${env.appBaseUrl}/api/calls/status`;

    const params = new URLSearchParams();
    params.append("To", phoneNumber);
    params.append("From", env.twilioPhoneNumber!);
    params.append("Url", twimlUrl);
    params.append("StatusCallback", statusCallbackUrl);
    params.append("StatusCallbackEvent", "initiated ringing answered completed");
    params.append("StatusCallbackMethod", "POST");
    params.append("Method", "POST");
    // Timeout: ring for 30 seconds before giving up
    params.append("Timeout", "30");

    const authHeader = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString("base64");

    const response = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody }, "Twilio call initiation failed");
      
      await this.callLogRepository.update(callLogId, { status: "failed" });
      throw new Error(`Twilio call failed with ${response.status}: ${errorBody}`);
    }

    const callData = (await response.json()) as { sid: string };
    const callSid = callData.sid;

    // Update call log with the Twilio SID
    await this.callLogRepository.update(callLogId, { twilioCallSid: callSid });

    logger.info(
      { callLogId, callSid, leadId: lead.id, to: phoneNumber },
      "Outbound call initiated via Twilio"
    );

    return { callSid, callLogId };
  }
}

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
      "Twilio is not configured; call was logged instead of placed"
    );

    return { callSid, callLogId };
  }
}
