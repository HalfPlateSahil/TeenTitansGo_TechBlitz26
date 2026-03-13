-- Add follow-up tracking columns for N-step follow-ups
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS follow_up_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_follow_up_sent_at timestamptz;
