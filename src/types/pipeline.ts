import type { LeadRecord, LeadResearch, LeadScore } from "./lead.js";
import type { CallLogRecord } from "./call.js";

export interface LeadEnrichmentResult {
  research: LeadResearch;
  score: LeadScore;
  qualityScore: number;
  summary: string;
  reasoning: string | null;
  shouldArchive: boolean;
}

export interface DraftEmailInput {
  lead: LeadRecord;
  step: number;
}

export interface DraftedEmail {
  subject: string;
  text: string;
  html?: string | null;
}

export interface InboundWhatsappMessage {
  from: string;
  body: string;
  /** When set, the command targets this specific lead instead of the latest pending one. */
  targetLeadId?: string;
}

export interface FollowUpJobData {
  leadId: string;
  step: number;
}

export interface EmailReplyPayload {
  from: string;
  to: string;
  subject?: string;
  textBody?: string;
}

export interface LeadAiClient {
  enrichAndScore(lead: LeadRecord): Promise<LeadEnrichmentResult>;
  draftOutreachEmail(input: DraftEmailInput): Promise<DraftedEmail>;
  draftWhatsappResponse(lead: LeadRecord): Promise<string>;
}

export interface WhatsappGateway {
  sendApprovalRequest(lead: LeadRecord): Promise<void>;
  sendLeadResponse(lead: LeadRecord, message: string): Promise<void>;
  start?(handler: (message: InboundWhatsappMessage) => Promise<void>): Promise<void>;
}

export interface EmailGateway {
  sendEmail(
    lead: LeadRecord,
    draft: DraftedEmail,
    kind: "initial" | `follow_up_${number}`
  ): Promise<{ messageId: string }>;
}

export interface FollowUpScheduler {
  scheduleFollowUp(leadId: string, step: number, delayMs?: number): Promise<void>;
  start?(handler: (job: FollowUpJobData) => Promise<void>): Promise<void>;
}

export interface CallGateway {
  initiateCall(lead: LeadRecord): Promise<{ callSid: string; callLogId: string }>;
}

/**
 * Dedicated gateway for sending WhatsApp messages to LEADS (not the owner).
 * Separate from the WhatsappGateway which handles owner notifications.
 */
export interface WhatsappOutreachGateway {
  sendMessage(lead: LeadRecord, message: string): Promise<void>;
  start?(): Promise<void>;
}