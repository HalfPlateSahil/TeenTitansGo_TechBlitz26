import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  OWNER_WHATSAPP_NUMBER: z.string().min(5).default("15551234567"),
  DUPLICATE_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  LOW_INTENT_SCORE_THRESHOLD: z.coerce.number().int().min(0).max(100).default(20),
  SUPABASE_URL: z.string().url().optional().or(z.literal("")),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal("")),
  GEMINI_API_KEY: z.string().optional().or(z.literal("")),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  TAVILY_API_KEY: z.string().optional().or(z.literal("")),
  GMAIL_SMTP_HOST: z.string().default("smtp.gmail.com"),
  GMAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  GMAIL_SMTP_USER: z.string().optional().or(z.literal("")),
  GMAIL_SMTP_PASS: z.string().optional().or(z.literal("")),
  OUTREACH_FROM_EMAIL: z.string().email().optional().or(z.literal("")),
  OUTREACH_FROM_NAME: z.string().optional().or(z.literal("")),
  UPSTASH_REDIS_URL: z.string().optional().or(z.literal("")),
  UPSTASH_REDIS_TOKEN: z.string().optional().or(z.literal("")),
  FOLLOW_UP_DELAY_HOURS: z.coerce.number().positive().default(48),
  MAX_FOLLOW_UP_STEPS: z.coerce.number().int().min(0).default(5),
  FOLLOW_UP_DELAY_MULTIPLIER: z.coerce.number().positive().default(1.5),
  INSTAGRAM_VERIFY_TOKEN: z.string().optional().or(z.literal("")),
  WHATSAPP_SESSION_PATH: z.string().default(".wwebjs_auth"),
  WHATSAPP_HEADLESS: z.coerce.boolean().default(true),
  TELEGRAM_BOT_TOKEN: z.string().optional().or(z.literal("")),
  TELEGRAM_OWNER_CHAT_ID: z.string().optional().or(z.literal(""))
});

const parsed = envSchema.parse(process.env);

export const env = {
  nodeEnv: parsed.NODE_ENV,
  port: parsed.PORT,
  appBaseUrl: parsed.APP_BASE_URL,
  ownerWhatsappNumber: parsed.OWNER_WHATSAPP_NUMBER,
  duplicateConfidenceThreshold: parsed.DUPLICATE_CONFIDENCE_THRESHOLD,
  lowIntentScoreThreshold: parsed.LOW_INTENT_SCORE_THRESHOLD,
  supabaseUrl: parsed.SUPABASE_URL || null,
  supabaseServiceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY || null,
  geminiApiKey: parsed.GEMINI_API_KEY || null,
  geminiModel: parsed.GEMINI_MODEL,
  tavilyApiKey: parsed.TAVILY_API_KEY || null,
  gmailSmtpHost: parsed.GMAIL_SMTP_HOST,
  gmailSmtpPort: parsed.GMAIL_SMTP_PORT,
  gmailSmtpUser: parsed.GMAIL_SMTP_USER || null,
  gmailSmtpPass: parsed.GMAIL_SMTP_PASS || null,
  outreachFromEmail: parsed.OUTREACH_FROM_EMAIL || null,
  outreachFromName: parsed.OUTREACH_FROM_NAME || null,
  upstashRedisUrl: parsed.UPSTASH_REDIS_URL || null,
  upstashRedisToken: parsed.UPSTASH_REDIS_TOKEN || null,
  followUpDelayHours: parsed.FOLLOW_UP_DELAY_HOURS,
  maxFollowUpSteps: parsed.MAX_FOLLOW_UP_STEPS,
  followUpDelayMultiplier: parsed.FOLLOW_UP_DELAY_MULTIPLIER,
  instagramVerifyToken: parsed.INSTAGRAM_VERIFY_TOKEN || null,
  whatsappSessionPath: parsed.WHATSAPP_SESSION_PATH,
  whatsappHeadless: parsed.WHATSAPP_HEADLESS,
  telegramBotToken: parsed.TELEGRAM_BOT_TOKEN || null,
  telegramOwnerChatId: parsed.TELEGRAM_OWNER_CHAT_ID || null
} as const;

export const hasSupabaseConfig = Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
export const hasSmtpConfig = Boolean(env.gmailSmtpUser && env.gmailSmtpPass);
export const hasRedisConfig = Boolean(env.upstashRedisUrl);
export const hasTelegramConfig = Boolean(env.telegramBotToken && env.telegramOwnerChatId);
