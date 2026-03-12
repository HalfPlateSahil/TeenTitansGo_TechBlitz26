1. Overview & Objective
Small to mid-size businesses hemorrhage revenue due to slow lead response times and inconsistent follow-ups. Traditional CRMs require manual data entry, which is often abandoned.

The Objective: Build an "invisible" CRM and autonomous AI sales agent that requires zero monthly operating costs for the core infrastructure. The system will ingest leads, score them using AI, and manage outreach automatically. The human user controls the pipeline entirely via simple text commands on their personal WhatsApp, bypassing traditional web dashboards.

2. Target Audience
Primary Users: Service-based business owners, local contractors, and boutique agencies who have inbound lead flow but lack dedicated sales teams or high software budgets.

User Persona: "The On-the-Go Founder" – They manage operations from their phone and need an automated assistant to handle the grunt work of sales follow-ups without adding another subscription to their expenses.

3. Core Features & User Stories
Module A: The Omnichannel Receptionist (Ingestion)
Custom Webhook Receiver: A custom Express.js endpoint (/api/webhooks/leads) that accepts POST requests from website contact forms or free form builders (like Tally.so free tier).

Data Normalization: Automatically standardizes incoming payloads (Name, Email, Phone, Source, Inquiry Text) into a predictable TypeScript interface.

Duplicate Prevention: Checks the database to ensure the lead doesn't already exist before creating a new record.

Module B: The Detective (AI Enrichment & Scoring)
Free Auto-Research: Uses a free search API (like DuckDuckGo via open-source scraping or the free tier of Tavily) to find company info based on the lead's email domain.

LLM Scoring Engine: Passes the data to a free-tier LLM to generate a "Lead Quality Score" (1-100) and a brief summary.

Junk Filtering: Auto-archives spam or low-intent leads (score < 20) without notifying the user.

Module C: The Executor (Mobile Control & Outreach)
WhatsApp Command UI: Sends a structured message to the user's personal WhatsApp using whatsapp-web.js.

Example Message: "🚨 New Lead: John Doe (Score: 85/100). Summary: Needs software for his plumbing business. Reply '1' to Approve, '2' to Reject."

Autonomous Drafting: The LLM generates highly personalized initial outreach copy.

Zero-Cost Drip Sequences: Schedules follow-up emails using a local task queue. If no reply is detected, it triggers the next step automatically.

The Invisible CRM: Every state change is silently logged to the database.

4. Technical Specifications (The 100% Free Stack)
To support whatsapp-web.js, the architecture shifts from serverless functions to a persistent Node.js environment.

Backend Core: Node.js + Express + TypeScript. (Must be a persistent server, not serverless, to keep the Puppeteer browser alive for WhatsApp).

Hosting: Render (Free Tier), Railway (Free Trial), or local hosting via Ngrok (Free) during development.

Database: Supabase (PostgreSQL). The free tier allows up to 500MB of database space and 50,000 monthly active users, which is more than enough for an MVP.

Messaging Interface: whatsapp-web.js (An open-source Node library that runs a headless Chrome browser to authenticate via WhatsApp Web QR code).

AI / LLM Engine: Google Gemini API (Generous free tier available) or Groq (Free tier for Llama 3 models) for scoring and email drafting.

Email Layer: Nodemailer. Sends emails directly through a standard Gmail/SMTP account for absolutely zero cost (or the Resend API free tier, which allows 3,000 emails/month).

Job Queuing: BullMQ using Upstash (generous free Redis tier) OR a simple local node-cron setup to handle delayed 48-hour follow-ups without needing external services.

5. Architecture Data Flow
Lead Captured: User submits a form -> Triggers POST request to your Express server.

Processing: Express server receives data -> Queries Gemini API for scoring -> Saves initial row to Supabase.

Notification: Express server uses whatsapp-web.js to send a message to the owner's phone.

Decision: Owner replies "1" on WhatsApp. whatsapp-web.js listener catches the "1", updates Supabase to "Approved".

Execution: Express server uses Gemini to draft an email -> Sends via Nodemailer -> Schedules a BullMQ job for 48 hours later.

Follow-up: 48 hours later, worker checks Supabase. If status !== 'replied', it drafts and sends the follow-up.

6. Success Metrics (KPIs)
Lead Response Time: Reduced to < 3 minutes.

Follow-up Rate: 100% execution for approved leads.

Operating Cost: $0.00/month during the MVP phase.

7. Out of Scope (For V2)
Serverless deployment (Next.js/Vercel) for the WhatsApp bot (physically impossible with whatsapp-web.js).

AI Voice calls (requires paid APIs like Vapi).

Complex interactive WhatsApp UI buttons (sticking to reliable text-based commands like "Reply 1 or 2" for maximum compatibility across devices).