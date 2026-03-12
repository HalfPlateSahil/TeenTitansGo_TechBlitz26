# TeenTitansGo_TechBlitz26

Backend implementation for the PRD-defined invisible CRM and autonomous AI sales agent.

## Current Implementation

- Express + TypeScript backend scaffold
- Health endpoint at `GET /health`
- Lead ingestion webhook at `POST /api/webhooks/leads`
- Lead normalization for name, email, phone, source, and inquiry text
- Fuzzy duplicate detection with exact-match overrides for email and phone
- Supabase-backed lead repository with persistent `lead_events` logging
- Gemini-driven enrichment and scoring with PRD junk filtering (`score < 20` archives silently)
- WhatsApp approval request handling with `1` approve / `2` reject command processing
- Gemini-drafted email outreach with SMTP delivery and BullMQ follow-up scheduling
- Baseline automated tests for normalization, webhook ingestion, junk filtering, and approval flow

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Copy environment values from `.env.example` into `.env`.

3. Start the development server:

```bash
npm run dev
```

4. Run validation:

```bash
npm run typecheck
npm test
```

## API

### Health

```http
GET /health
```

### Lead Webhook

```http
POST /api/webhooks/leads
Content-Type: application/json
```

Example payload:

```json
{
	"name": "John Doe",
	"email": "john@example.com",
	"phone": "+1 (555) 010-1234",
	"source": "tally.so",
	"message": "Need help automating lead follow-ups"
}
```

### WhatsApp Approval Webhook

```http
POST /api/whatsapp/messages
Content-Type: application/json
```

Example payload:

```json
{
	"from": "15551234567@c.us",
	"body": "1"
}
```

## Notes

- The server now uses Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured, with an in-memory fallback preserved for tests and bootstrap-only development.
- WhatsApp approval messages are sent through `whatsapp-web.js`; on first boot the server will print a QR code in the terminal for session authentication.
- If Gemini, SMTP, or Redis credentials are missing, the code falls back to deterministic local behavior so the webhook pipeline and tests still run.
