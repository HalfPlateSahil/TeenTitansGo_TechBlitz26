import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { FollowUpJobData, FollowUpScheduler } from "../types/pipeline.js";

const FOLLOW_UP_QUEUE_NAME = "lead-follow-ups";

function buildRedisConnection() {
  const connectionUrl = new URL(env.upstashRedisUrl!);
  const password = env.upstashRedisToken || connectionUrl.password || undefined;

  return {
    host: connectionUrl.hostname,
    port: Number(connectionUrl.port || 6379),
    username: connectionUrl.username || undefined,
    password,
    tls: connectionUrl.protocol === "rediss:" ? {} : undefined
  };
}

export class BullMqFollowUpScheduler implements FollowUpScheduler {
  private readonly connection = buildRedisConnection();
  private readonly queue = new Queue<FollowUpJobData>(FOLLOW_UP_QUEUE_NAME, {
    connection: this.connection,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 100
    }
  });

  private worker: Worker<FollowUpJobData> | null = null;

  async scheduleFollowUp(leadId: string, step: 1 | 2, delayMs = env.followUpDelayHours * 60 * 60 * 1000): Promise<void> {
    await this.queue.add("follow-up", { leadId, step }, {
      delay: delayMs,
      jobId: `lead-${leadId}-step-${step}`
    });
  }

  async start(handler: (job: FollowUpJobData) => Promise<void>): Promise<void> {
    if (this.worker) {
      return;
    }

    this.worker = new Worker<FollowUpJobData>(FOLLOW_UP_QUEUE_NAME, async (job) => handler(job.data), {
      connection: this.connection
    });

    this.worker.on("completed", (job) => {
      logger.info({ jobId: job.id, data: job.data }, "Follow-up job completed");
    });

    this.worker.on("failed", (job, error) => {
      logger.error({ jobId: job?.id, error, data: job?.data }, "Follow-up job failed");
    });
  }
}

export class InMemoryFollowUpScheduler implements FollowUpScheduler {
  readonly scheduledJobs: Array<FollowUpJobData & { delayMs: number }> = [];

  async scheduleFollowUp(leadId: string, step: 1 | 2, delayMs = env.followUpDelayHours * 60 * 60 * 1000): Promise<void> {
    this.scheduledJobs.push({ leadId, step, delayMs });
  }

  async start(): Promise<void> {
    logger.info("Follow-up scheduler is running in memory mode");
  }
}