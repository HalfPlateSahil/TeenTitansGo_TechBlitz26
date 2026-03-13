import { env } from "../config/env.js";
import type { LeadResearch, LeadRecord, LeadScore } from "../types/lead.js";
import type { DraftEmailInput, DraftedEmail, LeadAiClient, LeadEnrichmentResult } from "../types/pipeline.js";

interface GeminiJsonResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

interface TavilyResponse {
  answer?: string;
  results?: Array<{
    title?: string;
    content?: string;
    url?: string;
  }>;
}

interface TavilyResearchClient {
  research(lead: LeadRecord): Promise<LeadResearch>;
}

function clampScore(value: number): number {
  return Math.max(1, Math.min(100, Math.round(value)));
}

function deriveCompanyName(domain: string | null): string | null {
  if (!domain) {
    return null;
  }

  const [root] = domain.split(".");
  if (!root) {
    return null;
  }

  return root
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function stripMarkdownFence(value: string): string {
  return value.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}

function extractJsonObject<T>(value: string): T {
  const trimmed = stripMarkdownFence(value);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini response did not include a JSON object.");
  }

  return JSON.parse(trimmed.slice(start, end + 1)) as T;
}

async function requestGeminiJson<T>(apiKey: string, prompt: string): Promise<T> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini request failed with ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as GeminiJsonResponse;
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";

  return extractJsonObject<T>(text);
}

function buildHeuristicResearch(lead: LeadRecord): LeadResearch {
  return {
    companyName: deriveCompanyName(lead.companyDomain),
    companyIndustry: null,
    companySize: null,
    summary: lead.companyDomain
      ? `Lead appears to be associated with ${lead.companyDomain} and asked about: ${lead.inquiryText}`
      : `Lead asked about: ${lead.inquiryText}`,
    raw: {
      source: "heuristic"
    }
  };
}

function buildHeuristicScore(lead: LeadRecord, research: LeadResearch): LeadEnrichmentResult {
  const inquiry = lead.inquiryText.toLowerCase();
  const hasBusinessEmail = Boolean(lead.companyDomain && !/(gmail|yahoo|hotmail|outlook)\./i.test(lead.companyDomain));
  const spamSignals = ["seo", "casino", "forex", "guest post", "backlinks", "loan", "spam"];
  const intentSignals = ["crm", "automation", "follow-up", "follow up", "sales", "lead", "workflow"];

  let scoreValue = 20;
  if (hasBusinessEmail) {
    scoreValue += 25;
  }
  if ((lead.email ?? lead.phone) && inquiry.length >= 20) {
    scoreValue += 15;
  }
  if (intentSignals.some((signal) => inquiry.includes(signal))) {
    scoreValue += 25;
  }
  if (research.companyName) {
    scoreValue += 10;
  }
  if (spamSignals.some((signal) => inquiry.includes(signal))) {
    scoreValue -= 50;
  }

  const qualityScore = clampScore(scoreValue);
  const summary = research.summary ?? `Lead ${lead.name} asked about ${lead.inquiryText}`;
  const reasoning = qualityScore < env.lowIntentScoreThreshold ? "Heuristic spam or low-intent indicators were detected." : "Heuristic business-intent signals were detected.";
  const score: LeadScore = {
    value: qualityScore,
    summary,
    reasoning,
    raw: {
      strategy: "heuristic"
    }
  };

  return {
    research,
    score,
    qualityScore,
    summary,
    reasoning,
    shouldArchive: qualityScore < env.lowIntentScoreThreshold
  };
}

export class TavilyLeadResearchClient implements TavilyResearchClient {
  constructor(private readonly apiKey: string) {}

  async research(lead: LeadRecord): Promise<LeadResearch> {
    if (!lead.companyDomain) {
      return buildHeuristicResearch(lead);
    }

    const query = `${lead.companyDomain} company overview industry team size`; 
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        search_depth: "basic",
        max_results: 3,
        include_answer: true
      })
    });

    if (!response.ok) {
      throw new Error(`Tavily research failed with ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as TavilyResponse;
    const snippets = payload.results?.map((result) => `${result.title ?? "Result"}: ${result.content ?? ""}`.trim()) ?? [];

    return {
      companyName: deriveCompanyName(lead.companyDomain),
      companyIndustry: null,
      companySize: null,
      summary: [payload.answer, ...snippets].filter(Boolean).join(" ").trim() || buildHeuristicResearch(lead).summary,
      raw: payload as unknown as Record<string, unknown>
    };
  }
}

export class HeuristicLeadAiClient implements LeadAiClient {
  async enrichAndScore(lead: LeadRecord): Promise<LeadEnrichmentResult> {
    const research = buildHeuristicResearch(lead);
    return buildHeuristicScore(lead, research);
  }

  async draftOutreachEmail(input: DraftEmailInput): Promise<DraftedEmail> {
    const intro = input.step === 0 ? `Thanks for reaching out, ${input.lead.name}.` : `Checking back in with you, ${input.lead.name}.`;
    const subjectPrefix = input.step === 0 ? "Following up on your inquiry" : `Follow-up ${input.step}`;

    return {
      subject: `${subjectPrefix}: ${input.lead.inquiryText.slice(0, 48)}`,
      text: `${intro}\n\nYou mentioned: ${input.lead.inquiryText}\n\nIf you want, I can outline the next steps and a simple automation plan for your business.\n\nBest,\nYour AI sales assistant`
    };
  }

  async draftWhatsappResponse(lead: LeadRecord): Promise<string> {
    const greeting = `Hi ${lead.name}! \u{1F44B}`;
    const body = `Thanks for reaching out about: ${lead.inquiryText}. We'd love to help you out. We'll be in touch shortly with more details!`;
    return `${greeting}\n\n${body}`;
  }
}

export class GeminiLeadAiClient implements LeadAiClient {
  constructor(
    private readonly apiKey: string,
    private readonly researchClient?: TavilyResearchClient
  ) {}

  async enrichAndScore(lead: LeadRecord): Promise<LeadEnrichmentResult> {
    const research = this.researchClient ? await this.researchClient.research(lead) : buildHeuristicResearch(lead);

    const prompt = [
      "You are scoring inbound sales leads for a small business CRM.",
      "Return valid JSON only.",
      "Required JSON schema:",
      JSON.stringify({
        companyName: "string | null",
        companyIndustry: "string | null",
        companySize: "string | null",
        summary: "string",
        reasoning: "string",
        qualityScore: "integer between 1 and 100"
      }),
      "Archive junk or low-intent leads when the score is below 20.",
      `Lead: ${JSON.stringify({
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        source: lead.source,
        inquiryText: lead.inquiryText,
        companyDomain: lead.companyDomain
      })}`,
      `Research context: ${JSON.stringify(research)}`
    ].join("\n\n");

    const data = await requestGeminiJson<{
      companyName?: string | null;
      companyIndustry?: string | null;
      companySize?: string | null;
      summary?: string;
      reasoning?: string;
      qualityScore?: number;
    }>(this.apiKey, prompt);

    const qualityScore = clampScore(data.qualityScore ?? 15);
    const summary = data.summary?.trim() || research.summary || `Lead ${lead.name} asked about ${lead.inquiryText}`;
    const reasoning = data.reasoning?.trim() || null;
    const mergedResearch: LeadResearch = {
      companyName: data.companyName ?? research.companyName,
      companyIndustry: data.companyIndustry ?? research.companyIndustry,
      companySize: data.companySize ?? research.companySize,
      summary: research.summary,
      raw: research.raw
    };
    const score: LeadScore = {
      value: qualityScore,
      summary,
      reasoning,
      raw: data as unknown as Record<string, unknown>
    };

    return {
      research: mergedResearch,
      score,
      qualityScore,
      summary,
      reasoning,
      shouldArchive: qualityScore < env.lowIntentScoreThreshold
    };
  }

  async draftOutreachEmail(input: DraftEmailInput): Promise<DraftedEmail> {
    const prompt = [
      "You write concise, highly personalized outbound sales emails for small businesses.",
      "Return valid JSON only.",
      JSON.stringify({
        subject: "string",
        text: "string",
        html: "string | null"
      }),
      `This is ${input.step === 0 ? "the initial outreach" : `follow-up ${input.step}`}.`,
      `Lead context: ${JSON.stringify({
        name: input.lead.name,
        email: input.lead.email,
        source: input.lead.source,
        inquiryText: input.lead.inquiryText,
        companyDomain: input.lead.companyDomain,
        aiSummary: input.lead.aiSummary
      })}`,
      "Use a natural tone. Do not overpromise. Keep it under 180 words."
    ].join("\n\n");

    const data = await requestGeminiJson<{
      subject?: string;
      text?: string;
      html?: string | null;
    }>(this.apiKey, prompt);

    return {
      subject: data.subject?.trim() || `Following up with ${input.lead.name}`,
      text: data.text?.trim() || `Hi ${input.lead.name},\n\nThanks for reaching out about ${input.lead.inquiryText}.`,
      html: data.html?.trim() || null
    };
  }

  async draftWhatsappResponse(lead: LeadRecord): Promise<string> {
    const prompt = [
      "You write short, friendly WhatsApp messages on behalf of a small business sales team.",
      "Return valid JSON only.",
      JSON.stringify({ message: "string" }),
      "Requirements:",
      "- Keep it under 100 words.",
      "- Use a warm, conversational tone.",
      "- Reference the lead's inquiry specifically.",
      "- Mention you'll follow up soon or offer to schedule a quick call.",
      "- Do NOT include any placeholders like [Name] — use the actual name.",
      "- You may use 1-2 relevant emojis.",
      `Lead context: ${JSON.stringify({
        name: lead.name,
        source: lead.source,
        inquiryText: lead.inquiryText,
        companyDomain: lead.companyDomain,
        aiSummary: lead.aiSummary
      })}`
    ].join("\n\n");

    const data = await requestGeminiJson<{ message?: string }>(this.apiKey, prompt);

    return (
      data.message?.trim() ||
      `Hi ${lead.name}! \u{1F44B} Thanks for reaching out about ${lead.inquiryText}. We'd love to help — we'll follow up with you shortly!`
    );
  }
}