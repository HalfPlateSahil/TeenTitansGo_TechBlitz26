import type { NormalizedLeadInput } from "../types/lead.js";
import type { LeadWebhookPayload } from "../types/webhook.js";

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function pickFirstString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asTrimmedString(payload[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

export function normalizeEmail(email: string | null): string | null {
  if (!email) {
    return null;
  }

  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string | null): string | null {
  if (!phone) {
    return null;
  }

  // Already in E.164 format
  if (phone.startsWith("+") && phone.replace(/\D+/g, "").length >= 10) {
    return phone.replace(/[^\d+]/g, "");
  }

  const digits = phone.replace(/\D+/g, "");
  if (digits.length < 7) {
    return null;
  }

  // 10-digit number: detect Indian vs US
  if (digits.length === 10) {
    // Indian mobile numbers start with 6, 7, 8, or 9
    if (/^[6-9]/.test(digits)) {
      return `+91${digits}`;
    }
    return `+1${digits}`;
  }

  // Already has country code (11+ digits)
  return `+${digits}`;
}

export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

export function extractDomain(email: string | null): string | null {
  if (!email) {
    return null;
  }

  const [, domain] = email.split("@");
  return domain ?? null;
}

export function normalizeLeadPayload(payload: LeadWebhookPayload, fallbackSource = "unknown"): NormalizedLeadInput {
  const nameParts = [
    pickFirstString(payload, ["name", "fullName"]),
    pickFirstString(payload, ["firstName"]),
    pickFirstString(payload, ["lastName"])
  ].filter(Boolean);

  const name = nameParts.join(" ").trim();
  const email = normalizeEmail(pickFirstString(payload, ["email", "mail"]));
  const phone = normalizePhone(pickFirstString(payload, ["phone", "mobile"]));
  const inquiryText =
    pickFirstString(payload, ["inquiryText", "inquiry", "message"]) ??
    "No inquiry text provided.";
  const source = pickFirstString(payload, ["source"]) ?? fallbackSource;

  if (!name) {
    throw new Error("Lead name is required.");
  }

  if (!email && !phone) {
    throw new Error("At least one contact method is required.");
  }

  return {
    name,
    email,
    phone,
    source,
    inquiryText,
    companyDomain: extractDomain(email)
  };
}
