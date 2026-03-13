import type { SupabaseClient } from "@supabase/supabase-js";

import { createId } from "../utils/ids.js";
import type {
  LeadEventCreateInput,
  LeadEventRecord,
  LeadRecord,
  LeadRecordPatch
} from "../types/lead.js";

interface LeadRow {
  id: string;
  name: string;
  normalized_name: string;
  email: string | null;
  normalized_email: string | null;
  phone: string | null;
  normalized_phone: string | null;
  source: string;
  inquiry_text: string;
  company_domain: string | null;
  status: LeadRecord["status"];
  duplicate_of_lead_id: string | null;
  duplicate_confidence: number | null;
  quality_score: number | null;
  ai_summary: string | null;
  whatsapp_notified_at: string | null;
  whatsapp_response_sent_at: string | null;
  initial_email_sent_at: string | null;
  follow_up_1_sent_at: string | null;
  follow_up_2_sent_at: string | null;
  follow_up_count: number;
  last_follow_up_sent_at: string | null;
  email_reply_detected_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LeadEventRow {
  id: string;
  lead_id: string;
  event_type: string;
  actor: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

function mapLeadRow(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    email: row.email,
    normalizedEmail: row.normalized_email,
    phone: row.phone,
    normalizedPhone: row.normalized_phone,
    source: row.source,
    inquiryText: row.inquiry_text,
    companyDomain: row.company_domain,
    status: row.status,
    duplicateOfLeadId: row.duplicate_of_lead_id,
    duplicateConfidence: row.duplicate_confidence,
    qualityScore: row.quality_score,
    aiSummary: row.ai_summary,
    whatsappNotifiedAt: row.whatsapp_notified_at,
    whatsappResponseSentAt: row.whatsapp_response_sent_at,
    initialEmailSentAt: row.initial_email_sent_at,
    followUp1SentAt: row.follow_up_1_sent_at,
    followUp2SentAt: row.follow_up_2_sent_at,
    followUpCount: row.follow_up_count ?? 0,
    lastFollowUpSentAt: row.last_follow_up_sent_at,
    emailReplyDetectedAt: row.email_reply_detected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toLeadInsert(lead: LeadRecord): LeadRow {
  return {
    id: lead.id,
    name: lead.name,
    normalized_name: lead.normalizedName,
    email: lead.email,
    normalized_email: lead.normalizedEmail,
    phone: lead.phone,
    normalized_phone: lead.normalizedPhone,
    source: lead.source,
    inquiry_text: lead.inquiryText,
    company_domain: lead.companyDomain,
    status: lead.status,
    duplicate_of_lead_id: lead.duplicateOfLeadId,
    duplicate_confidence: lead.duplicateConfidence,
    quality_score: lead.qualityScore,
    ai_summary: lead.aiSummary,
    whatsapp_notified_at: lead.whatsappNotifiedAt,
    whatsapp_response_sent_at: lead.whatsappResponseSentAt,
    initial_email_sent_at: lead.initialEmailSentAt,
    follow_up_1_sent_at: lead.followUp1SentAt,
    follow_up_2_sent_at: lead.followUp2SentAt,
    follow_up_count: lead.followUpCount,
    last_follow_up_sent_at: lead.lastFollowUpSentAt,
    email_reply_detected_at: lead.emailReplyDetectedAt,
    created_at: lead.createdAt,
    updated_at: lead.updatedAt
  };
}

function toLeadPatch(patch: LeadRecordPatch): Partial<LeadRow> {
  const updatedAt = new Date().toISOString();

  return {
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.qualityScore === undefined ? {} : { quality_score: patch.qualityScore }),
    ...(patch.aiSummary === undefined ? {} : { ai_summary: patch.aiSummary }),
    ...(patch.whatsappNotifiedAt === undefined ? {} : { whatsapp_notified_at: patch.whatsappNotifiedAt }),
    ...(patch.whatsappResponseSentAt === undefined ? {} : { whatsapp_response_sent_at: patch.whatsappResponseSentAt }),
    ...(patch.initialEmailSentAt === undefined ? {} : { initial_email_sent_at: patch.initialEmailSentAt }),
    ...(patch.followUp1SentAt === undefined ? {} : { follow_up_1_sent_at: patch.followUp1SentAt }),
    ...(patch.followUp2SentAt === undefined ? {} : { follow_up_2_sent_at: patch.followUp2SentAt }),
    ...(patch.followUpCount === undefined ? {} : { follow_up_count: patch.followUpCount }),
    ...(patch.lastFollowUpSentAt === undefined ? {} : { last_follow_up_sent_at: patch.lastFollowUpSentAt }),
    ...(patch.emailReplyDetectedAt === undefined ? {} : { email_reply_detected_at: patch.emailReplyDetectedAt }),
    updated_at: updatedAt
  };
}

function mapLeadEventRow(row: LeadEventRow): LeadEventRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    eventType: row.event_type,
    actor: row.actor,
    payload: row.payload ?? {},
    createdAt: row.created_at
  };
}

export interface LeadRepository {
  create(lead: LeadRecord): Promise<LeadRecord>;
  update(id: string, patch: LeadRecordPatch): Promise<LeadRecord>;
  findAll(): Promise<LeadRecord[]>;
  findById(id: string): Promise<LeadRecord | null>;
  findLatestAwaitingApproval(): Promise<LeadRecord | null>;
  addEvent(event: LeadEventCreateInput): Promise<LeadEventRecord>;
  findEventsByLeadId(leadId: string): Promise<LeadEventRecord[]>;
}

export class InMemoryLeadRepository implements LeadRepository {
  private readonly leads = new Map<string, LeadRecord>();
  private readonly leadEvents = new Map<string, LeadEventRecord[]>();

  async create(lead: LeadRecord): Promise<LeadRecord> {
    this.leads.set(lead.id, lead);
    return lead;
  }

  async update(id: string, patch: LeadRecordPatch): Promise<LeadRecord> {
    const existing = this.leads.get(id);
    if (!existing) {
      throw new Error(`Lead ${id} was not found.`);
    }

    const updated: LeadRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    this.leads.set(id, updated);
    return updated;
  }

  async findAll(): Promise<LeadRecord[]> {
    return Array.from(this.leads.values()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    );
  }

  async findById(id: string): Promise<LeadRecord | null> {
    return this.leads.get(id) ?? null;
  }

  async findLatestAwaitingApproval(): Promise<LeadRecord | null> {
    const leads = Array.from(this.leads.values())
      .filter((lead) => lead.status === "review_needed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return leads[0] ?? null;
  }

  async addEvent(event: LeadEventCreateInput): Promise<LeadEventRecord> {
    const record: LeadEventRecord = {
      id: createId(),
      leadId: event.leadId,
      eventType: event.eventType,
      actor: event.actor ?? "system",
      payload: event.payload ?? {},
      createdAt: new Date().toISOString()
    };

    const existing = this.leadEvents.get(event.leadId) ?? [];
    existing.unshift(record);
    this.leadEvents.set(event.leadId, existing);

    return record;
  }

  async findEventsByLeadId(leadId: string): Promise<LeadEventRecord[]> {
    return this.leadEvents.get(leadId) ?? [];
  }
}

export class SupabaseLeadRepository implements LeadRepository {
  constructor(private readonly client: SupabaseClient) { }

  async create(lead: LeadRecord): Promise<LeadRecord> {
    const { data, error } = await this.client.from("leads").insert(toLeadInsert(lead)).select().single();

    if (error) {
      throw new Error(`Failed to create lead: ${error.message}`);
    }

    return mapLeadRow(data as LeadRow);
  }

  async update(id: string, patch: LeadRecordPatch): Promise<LeadRecord> {
    const { data, error } = await this.client
      .from("leads")
      .update(toLeadPatch(patch))
      .eq("id", id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update lead ${id}: ${error.message}`);
    }

    return mapLeadRow(data as LeadRow);
  }

  async findAll(): Promise<LeadRecord[]> {
    const { data, error } = await this.client.from("leads").select("*").order("created_at", { ascending: true });

    if (error) {
      throw new Error(`Failed to list leads: ${error.message}`);
    }

    return (data as LeadRow[]).map(mapLeadRow);
  }

  async findById(id: string): Promise<LeadRecord | null> {
    const { data, error } = await this.client.from("leads").select("*").eq("id", id).maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch lead ${id}: ${error.message}`);
    }

    return data ? mapLeadRow(data as LeadRow) : null;
  }

  async findLatestAwaitingApproval(): Promise<LeadRecord | null> {
    const { data, error } = await this.client
      .from("leads")
      .select("*")
      .eq("status", "review_needed")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch pending approvals: ${error.message}`);
    }

    return data ? mapLeadRow(data as LeadRow) : null;
  }

  async addEvent(event: LeadEventCreateInput): Promise<LeadEventRecord> {
    const { data, error } = await this.client
      .from("lead_events")
      .insert({
        lead_id: event.leadId,
        event_type: event.eventType,
        actor: event.actor ?? "system",
        payload: event.payload ?? {}
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to persist lead event: ${error.message}`);
    }

    return mapLeadEventRow(data as LeadEventRow);
  }

  async findEventsByLeadId(leadId: string): Promise<LeadEventRecord[]> {
    const { data, error } = await this.client
      .from("lead_events")
      .select("*")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to list lead events for ${leadId}: ${error.message}`);
    }

    return (data as LeadEventRow[]).map(mapLeadEventRow);
  }
}
