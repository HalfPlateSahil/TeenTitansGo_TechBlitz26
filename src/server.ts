import { env } from "./config/env.js";
import { supabase } from "./config/database.js";
import { hasRedisConfig, hasSmtpConfig, hasSupabaseConfig } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { InMemoryLeadRepository, SupabaseLeadRepository } from "./repositories/lead-repository.js";
import { createApp } from "./app.js";
import { BullMqFollowUpScheduler, InMemoryFollowUpScheduler } from "./services/follow-up-service.js";
import { GeminiLeadAiClient, HeuristicLeadAiClient, TavilyLeadResearchClient } from "./services/ai-service.js";
import { LeadService } from "./services/lead-service.js";
import { LoggingEmailGateway, SmtpEmailGateway } from "./services/email-service.js";
import { LoggingWhatsappGateway, WhatsAppWebGateway } from "./services/whatsapp-service.js";

async function bootstrap() {
  const repository = hasSupabaseConfig && supabase ? new SupabaseLeadRepository(supabase) : new InMemoryLeadRepository();
  const aiClient = env.geminiApiKey
    ? new GeminiLeadAiClient(env.geminiApiKey, env.tavilyApiKey ? new TavilyLeadResearchClient(env.tavilyApiKey) : undefined)
    : new HeuristicLeadAiClient();
  const emailGateway = hasSmtpConfig ? new SmtpEmailGateway() : new LoggingEmailGateway();
  const followUpScheduler = hasRedisConfig ? new BullMqFollowUpScheduler() : new InMemoryFollowUpScheduler();
  const whatsappGateway = env.nodeEnv === "test" ? new LoggingWhatsappGateway() : new WhatsAppWebGateway();
  const leadService = new LeadService(repository, aiClient, whatsappGateway, emailGateway, followUpScheduler);
  const app = createApp(leadService);

  await followUpScheduler.start?.((job) => leadService.processFollowUpJob(job));

  whatsappGateway.start?.((message) => leadService.handleOwnerWhatsappCommand(message.body, message.from).then(() => undefined)).catch((error: unknown) => {
    logger.error({ err: error }, "WhatsApp gateway failed to start; the API will continue without live WhatsApp transport");
  });

  app.listen(env.port, () => {
    logger.info(
      {
        port: env.port,
        persistence: hasSupabaseConfig ? "supabase" : "in-memory",
        followUpQueue: hasRedisConfig ? "bullmq" : "in-memory"
      },
      "Invisible CRM backend listening"
    );
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Failed to bootstrap server");
  process.exit(1);
});
