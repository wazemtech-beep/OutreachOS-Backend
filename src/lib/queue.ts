import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
} as any);

export const csvImportQueue = new Queue("csv-import", { connection: connection as any });
export const emailSendQueue = new Queue("email-send", { connection: connection as any });
export const warmupQueue = new Queue("warmup", { connection: connection as any });
export const campaignScheduleQueue = new Queue("campaign-schedule", { connection: connection as any });
export const enrichmentQueue = new Queue("enrichment", { connection: connection as any });
export const verificationQueue = new Queue("verification", { connection: connection as any });
export const imapSyncQueue = new Queue("imap-sync", { connection: connection as any });

export function createWorker(name: string, handler: (job: any) => Promise<any>) {
  return new Worker(name, handler, { connection: connection as any, concurrency: 5 });
}
