create extension if not exists pgcrypto;

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  email text,
  normalized_email text,
  phone text,
  normalized_phone text,
  source text not null,
  inquiry_text text not null,
  company_domain text,
  status text not null default 'new',
  duplicate_of_lead_id uuid references leads(id),
  duplicate_confidence numeric(4, 2),
  quality_score integer,
  ai_summary text,
  whatsapp_notified_at timestamptz,
  initial_email_sent_at timestamptz,
  follow_up_1_sent_at timestamptz,
  follow_up_2_sent_at timestamptz,
  email_reply_detected_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists leads_normalized_email_unique
  on leads(normalized_email)
  where normalized_email is not null;

create index if not exists leads_normalized_phone_idx
  on leads(normalized_phone);

create index if not exists leads_status_idx
  on leads(status);

create index if not exists leads_created_at_idx
  on leads(created_at desc);

create table if not exists lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  event_type text not null,
  actor text not null default 'system',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists lead_events_lead_id_idx
  on lead_events(lead_id, created_at desc);
