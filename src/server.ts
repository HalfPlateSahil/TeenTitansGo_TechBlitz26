import { env } from "./config/env.js";
import { supabase } from "./config/database.js";
import { hasRedisConfig, hasSmtpConfig, hasSupabaseConfig, hasTelegramConfig, hasTwilioConfig } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { InMemoryLeadRepository, SupabaseLeadRepository } from "./repositories/lead-repository.js";
import { InMemoryCallLogRepository, SupabaseCallLogRepository } from "./repositories/call-log-repository.js";
import { createApp } from "./app.js";
import { BullMqFollowUpScheduler, InMemoryFollowUpScheduler } from "./services/follow-up-service.js";
import { GeminiLeadAiClient, HeuristicLeadAiClient, TavilyLeadResearchClient } from "./services/ai-service.js";
import { LeadService } from "./services/lead-service.js";
import { LoggingEmailGateway, SmtpEmailGateway } from "./services/email-service.js";
import { LoggingTelegramGateway, TelegramGateway } from "./services/telegram-service.js";
import { LoggingWhatsappGateway, WhatsAppWebGateway } from "./services/whatsapp-service.js";
import { TwilioCallGateway, LoggingCallGateway } from "./services/call-service.js";
import { CallConversationService } from "./services/call-conversation-service.js";

async function bootstrap() {
  const repository = hasSupabaseConfig && supabase ? new SupabaseLeadRepository(supabase) : new InMemoryLeadRepository();
  const callLogRepository = hasSupabaseConfig && supabase ? new SupabaseCallLogRepository(supabase) : new InMemoryCallLogRepository();
  const aiClient = env.geminiApiKey
    ? new GeminiLeadAiClient(env.geminiApiKey, env.tavilyApiKey ? new TavilyLeadResearchClient(env.tavilyApiKey) : undefined)
    : new HeuristicLeadAiClient();
  const emailGateway = hasSmtpConfig ? new SmtpEmailGateway() : new LoggingEmailGateway();
  const followUpScheduler = hasRedisConfig ? new BullMqFollowUpScheduler() : new InMemoryFollowUpScheduler();

  const notificationGateway = hasTelegramConfig
    ? new TelegramGateway()
    : env.nodeEnv === "test"
      ? new LoggingWhatsappGateway()
      : new LoggingTelegramGateway();

  const callGateway = hasTwilioConfig
    ? new TwilioCallGateway(callLogRepository)
    : new LoggingCallGateway();

  const callConversationService = new CallConversationService(callLogRepository, repository);

  const leadService = new LeadService(repository, aiClient, notificationGateway, emailGateway, followUpScheduler, hasTwilioConfig ? callGateway : undefined);
  const app = createApp(leadService, repository, callConversationService, callLogRepository);

  await followUpScheduler.start?.((job) => leadService.processFollowUpJob(job));

  notificationGateway.start?.((message) => leadService.handleOwnerWhatsappCommand(message.body, message.from, message.targetLeadId).then(() => undefined)).catch((error: unknown) => {
    logger.error({ err: error }, "Notification gateway failed to start; the API will continue without live notifications");
  });

  app.listen(env.port, () => {
    logger.info(
      {
        port: env.port,
        persistence: hasSupabaseConfig ? "supabase" : "in-memory",
        followUpQueue: hasRedisConfig ? "bullmq" : "in-memory",
        twillioCalls: hasTwilioConfig ? "enabled" : "disabled"
      },
      "Invisible CRM backend listening"
    );
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Failed to bootstrap server");
  process.exit(1);
});
