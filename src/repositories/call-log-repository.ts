import type { SupabaseClient } from "@supabase/supabase-js";

import { createId } from "../utils/ids.js";
import type {
  CallLogRecord,
  CallLogCreateInput,
  CallLogPatch,
  CallStatus,
  CallOutcome
} from "../types/call.js";

interface CallLogRow {
  id: string;
  lead_id: string;
  twilio_call_sid: string | null;
  from_number: string;
  to_number: string;
  status: string;
  duration_seconds: number;
  picked_up: boolean;
  transcript: string | null;
  ai_summary: string | null;
  call_outcome: string | null;
  created_at: string;
  updated_at: string;
}

function mapCallLogRow(row: CallLogRow): CallLogRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    twilioCallSid: row.twilio_call_sid,
    fromNumber: row.from_number,
    toNumber: row.to_number,
    status: row.status as CallStatus,
    durationSeconds: row.duration_seconds ?? 0,
    pickedUp: row.picked_up ?? false,
    transcript: row.transcript,
    aiSummary: row.ai_summary,
    callOutcome: (row.call_outcome as CallOutcome) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toCallLogInsert(input: CallLogCreateInput): Partial<CallLogRow> {
  const now = new Date().toISOString();
  return {
    id: input.id,
    lead_id: input.leadId,
    twilio_call_sid: input.twilioCallSid ?? null,
    from_number: input.fromNumber,
    to_number: input.toNumber,
    status: input.status ?? "initiated",
    duration_seconds: 0,
    picked_up: false,
    transcript: null,
    ai_summary: null,
    call_outcome: null,
    created_at: now,
    updated_at: now
  };
}

function toCallLogPatch(patch: CallLogPatch): Partial<CallLogRow> {
  return {
    ...(patch.twilioCallSid === undefined ? {} : { twilio_call_sid: patch.twilioCallSid }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.durationSeconds === undefined ? {} : { duration_seconds: patch.durationSeconds }),
    ...(patch.pickedUp === undefined ? {} : { picked_up: patch.pickedUp }),
    ...(patch.transcript === undefined ? {} : { transcript: patch.transcript }),
    ...(patch.aiSummary === undefined ? {} : { ai_summary: patch.aiSummary }),
    ...(patch.callOutcome === undefined ? {} : { call_outcome: patch.callOutcome }),
    updated_at: new Date().toISOString()
  };
}

export interface CallLogRepository {
  create(input: CallLogCreateInput): Promise<CallLogRecord>;
  update(id: string, patch: CallLogPatch): Promise<CallLogRecord>;
  findById(id: string): Promise<CallLogRecord | null>;
  findByLeadId(leadId: string): Promise<CallLogRecord[]>;
  findByTwilioCallSid(sid: string): Promise<CallLogRecord | null>;
}

export class InMemoryCallLogRepository implements CallLogRepository {
  private readonly logs = new Map<string, CallLogRecord>();

  async create(input: CallLogCreateInput): Promise<CallLogRecord> {
    const now = new Date().toISOString();
    const record: CallLogRecord = {
      id: input.id,
      leadId: input.leadId,
      twilioCallSid: input.twilioCallSid ?? null,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      status: input.status ?? "initiated",
      durationSeconds: 0,
      pickedUp: false,
      transcript: null,
      aiSummary: null,
      callOutcome: null,
      createdAt: now,
      updatedAt: now
    };

    this.logs.set(record.id, record);
    return record;
  }

  async update(id: string, patch: CallLogPatch): Promise<CallLogRecord> {
    const existing = this.logs.get(id);
    if (!existing) {
      throw new Error(`Call log ${id} not found.`);
    }

    const updated: CallLogRecord = {
      ...existing,
      ...(patch.twilioCallSid !== undefined ? { twilioCallSid: patch.twilioCallSid } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.durationSeconds !== undefined ? { durationSeconds: patch.durationSeconds } : {}),
      ...(patch.pickedUp !== undefined ? { pickedUp: patch.pickedUp } : {}),
      ...(patch.transcript !== undefined ? { transcript: patch.transcript } : {}),
      ...(patch.aiSummary !== undefined ? { aiSummary: patch.aiSummary } : {}),
      ...(patch.callOutcome !== undefined ? { callOutcome: patch.callOutcome } : {}),
      updatedAt: new Date().toISOString()
    };

    this.logs.set(id, updated);
    return updated;
  }

  async findById(id: string): Promise<CallLogRecord | null> {
    return this.logs.get(id) ?? null;
  }

  async findByLeadId(leadId: string): Promise<CallLogRecord[]> {
    return Array.from(this.logs.values())
      .filter((log) => log.leadId === leadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findByTwilioCallSid(sid: string): Promise<CallLogRecord | null> {
    for (const log of this.logs.values()) {
      if (log.twilioCallSid === sid) {
        return log;
      }
    }
    return null;
  }
}

export class SupabaseCallLogRepository implements CallLogRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: CallLogCreateInput): Promise<CallLogRecord> {
    const { data, error } = await this.client
      .from("call_logs")
      .insert(toCallLogInsert(input))
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create call log: ${error.message}`);
    }

    return mapCallLogRow(data as CallLogRow);
  }

  async update(id: string, patch: CallLogPatch): Promise<CallLogRecord> {
    const { data, error } = await this.client
      .from("call_logs")
      .update(toCallLogPatch(patch))
      .eq("id", id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update call log ${id}: ${error.message}`);
    }

    return mapCallLogRow(data as CallLogRow);
  }

  async findById(id: string): Promise<CallLogRecord | null> {
    const { data, error } = await this.client
      .from("call_logs")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch call log ${id}: ${error.message}`);
    }

    return data ? mapCallLogRow(data as CallLogRow) : null;
  }

  async findByLeadId(leadId: string): Promise<CallLogRecord[]> {
    const { data, error } = await this.client
      .from("call_logs")
      .select("*")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to list call logs for lead ${leadId}: ${error.message}`);
    }

    return (data as CallLogRow[]).map(mapCallLogRow);
  }

  async findByTwilioCallSid(sid: string): Promise<CallLogRecord | null> {
    const { data, error } = await this.client
      .from("call_logs")
      .select("*")
      .eq("twilio_call_sid", sid)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch call log by SID ${sid}: ${error.message}`);
    }

    return data ? mapCallLogRow(data as CallLogRow) : null;
  }
}
