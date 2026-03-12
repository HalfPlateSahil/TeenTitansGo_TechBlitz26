import type { LeadRecord, LeadResearch, LeadScore } from "./lead.js";

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
  step: 0 | 1 | 2;
}

export interface DraftedEmail {
  subject: string;
  text: string;
  html?: string | null;
}

export interface InboundWhatsappMessage {
  from: string;
  body: string;
}

export interface FollowUpJobData {
  leadId: string;
  step: 1 | 2;
}

export interface LeadAiClient {
  enrichAndScore(lead: LeadRecord): Promise<LeadEnrichmentResult>;
  draftOutreachEmail(input: DraftEmailInput): Promise<DraftedEmail>;
}

export interface WhatsappGateway {
  sendApprovalRequest(lead: LeadRecord): Promise<void>;
  start?(handler: (message: InboundWhatsappMessage) => Promise<void>): Promise<void>;
}

export interface EmailGateway {
  sendEmail(
    lead: LeadRecord,
    draft: DraftedEmail,
    kind: "initial" | "follow_up_1" | "follow_up_2"
  ): Promise<{ messageId: string }>;
}

export interface FollowUpScheduler {
  scheduleFollowUp(leadId: string, step: 1 | 2, delayMs?: number): Promise<void>;
  start?(handler: (job: FollowUpJobData) => Promise<void>): Promise<void>;
}