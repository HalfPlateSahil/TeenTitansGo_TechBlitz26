-- Add column to track when a WhatsApp response was sent to the lead
ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp_response_sent_at TIMESTAMPTZ;
