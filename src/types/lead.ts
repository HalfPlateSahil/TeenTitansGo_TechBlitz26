export const leadStatuses = [
  "new",
  "review_needed",
  "approved",
  "rejected",
  "archived",
  "replied",
  "closed"
] as const;

export type LeadStatus = (typeof leadStatuses)[number];

export interface NormalizedLeadInput {
  name: string;
  email: string | null;
  phone: string | null;
  source: string;
  inquiryText: string;
  companyDomain: string | null;
}

export interface LeadResearch {
  companyName: string | null;
  companyIndustry: string | null;
  companySize: string | null;
  summary: string | null;
  raw: Record<string, unknown> | null;
}

export interface LeadScore {
  value: number | null;
  summary: string | null;
  reasoning: string | null;
  raw: Record<string, unknown> | null;
}

export interface LeadEventRecord {
  id: string;
  leadId: string;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LeadEventCreateInput {
  leadId: string;
  eventType: string;
  actor?: string;
  payload?: Record<string, unknown>;
}

export interface LeadRecordPatch {
  status?: LeadStatus;
  qualityScore?: number | null;
  aiSummary?: string | null;
  whatsappNotifiedAt?: string | null;
  initialEmailSentAt?: string | null;
  followUp1SentAt?: string | null;
  followUp2SentAt?: string | null;
  followUpCount?: number;
  lastFollowUpSentAt?: string | null;
  emailReplyDetectedAt?: string | null;
}

export interface LeadRecord {
  id: string;
  name: string;
  normalizedName: string;
  email: string | null;
  normalizedEmail: string | null;
  phone: string | null;
  normalizedPhone: string | null;
  source: string;
  inquiryText: string;
  companyDomain: string | null;
  status: LeadStatus;
  duplicateOfLeadId: string | null;
  duplicateConfidence: number | null;
  qualityScore: number | null;
  aiSummary: string | null;
  whatsappNotifiedAt: string | null;
  initialEmailSentAt: string | null;
  followUp1SentAt: string | null;
  followUp2SentAt: string | null;
  followUpCount: number;
  lastFollowUpSentAt: string | null;
  emailReplyDetectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateMatch {
  existingLeadId: string;
  confidence: number;
  reasons: string[];
}

export interface LeadIngestionResult {
  lead: LeadRecord;
  duplicate: boolean;
  duplicateMatch: DuplicateMatch | null;
  archived: boolean;
  notified: boolean;
}

export interface LeadCommandResult {
  handled: boolean;
  action: "approved" | "rejected" | "ignored";
  reason?: string;
  lead: LeadRecord | null;
}
