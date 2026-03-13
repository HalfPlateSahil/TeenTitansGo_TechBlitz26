export const callStatuses = [
  "initiated",
  "ringing",
  "in-progress",
  "completed",
  "no-answer",
  "busy",
  "failed",
  "canceled"
] as const;

export type CallStatus = (typeof callStatuses)[number];

export const callOutcomes = [
  "interested",
  "not_interested",
  "callback_requested",
  "voicemail",
  "no_answer",
  "failed",
  "unknown"
] as const;

export type CallOutcome = (typeof callOutcomes)[number];

export interface CallLogRecord {
  id: string;
  leadId: string;
  twilioCallSid: string | null;
  fromNumber: string;
  toNumber: string;
  status: CallStatus;
  durationSeconds: number;
  pickedUp: boolean;
  transcript: string | null;
  aiSummary: string | null;
  callOutcome: CallOutcome | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallLogCreateInput {
  id: string;
  leadId: string;
  twilioCallSid?: string | null;
  fromNumber: string;
  toNumber: string;
  status?: CallStatus;
}

export interface CallLogPatch {
  twilioCallSid?: string | null;
  status?: CallStatus;
  durationSeconds?: number;
  pickedUp?: boolean;
  transcript?: string | null;
  aiSummary?: string | null;
  callOutcome?: CallOutcome | null;
}

/** In-memory store for conversation state during an active call */
export interface CallConversationState {
  callLogId: string;
  leadId: string;
  leadName: string;
  leadInquiry: string;
  leadAiSummary: string | null;
  turns: Array<{ role: "ai" | "lead"; text: string }>;
}
