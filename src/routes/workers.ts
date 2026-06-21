import { FastifyInstance } from "fastify";
import prisma from "../lib/db.js";
import { campaignScheduleQueue, emailSendQueue, warmupQueue, csvImportQueue, enrichmentQueue, verificationQueue } from "../lib/queue.js";
import { getOrCreateDefaultWorkspace } from "../lib/workspace.js";

export async function workerRoutes(app: FastifyInstance) {

  // Trigger campaign send
  app.post("/campaigns/:id/send", async (request) => {
    const { id } = request.params as { id: string };
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) return { error: "Campaign not found" };
    await campaignScheduleQueue.add("schedule-campaign", { campaignId: id }, {
      attempts: 3, backoff: { type: "exponential", delay: 5000 },
    });
    return { success: true, message: `Campaign ${campaign.name} queued for processing` };
  });

  // Trigger warmup for all enabled accounts
  app.post("/warmup/run-all", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    const accounts = await prisma.emailAccount.findMany({
      where: { workspaceId: workspace.id, warmupEnabled: true, status: "CONNECTED" },
    });
    for (const account of accounts) {
      await warmupQueue.add("warmup-account", { accountId: account.id });
    }
    return { success: true, queued: accounts.length };
  });

  // Trigger warmup for a specific account
  app.post("/email-accounts/:id/warmup", async (request) => {
    const { id } = request.params as { id: string };
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) return { error: "Account not found" };
    await warmupQueue.add("warmup-account", { accountId: id });
    return { success: true, message: `Warmup queued for ${account.email}` };
  });

  // Trigger IMAP sync for an account
  app.post("/email-accounts/:id/imap-sync", async (request) => {
    const { id } = request.params as { id: string };
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) return { error: "Account not found" };
    await emailSendQueue.add("imap-sync", { accountId: id });
    return { success: true, message: `IMAP sync queued for ${account.email}` };
  });

  // Queue status
  app.get("/queue/status", async () => {
    const [emailWaiting, emailActive, emailCompleted, emailFailed] = await Promise.all([
      emailSendQueue.getWaitingCount(), emailSendQueue.getActiveCount(),
      emailSendQueue.getCompletedCount(), emailSendQueue.getFailedCount(),
    ]);
    const [warmupWaiting, warmupActive, warmupCompleted, warmupFailed] = await Promise.all([
      warmupQueue.getWaitingCount(), warmupQueue.getActiveCount(),
      warmupQueue.getCompletedCount(), warmupQueue.getFailedCount(),
    ]);
    const [csvWaiting, csvActive, csvCompleted, csvFailed] = await Promise.all([
      csvImportQueue.getWaitingCount(), csvImportQueue.getActiveCount(),
      csvImportQueue.getCompletedCount(), csvImportQueue.getFailedCount(),
    ]);
    const [enrichWaiting, enrichActive, enrichCompleted, enrichFailed] = await Promise.all([
      enrichmentQueue.getWaitingCount(), enrichmentQueue.getActiveCount(),
      enrichmentQueue.getCompletedCount(), enrichmentQueue.getFailedCount(),
    ]);
    const [verifyWaiting, verifyActive, verifyCompleted, verifyFailed] = await Promise.all([
      verificationQueue.getWaitingCount(), verificationQueue.getActiveCount(),
      verificationQueue.getCompletedCount(), verificationQueue.getFailedCount(),
    ]);
    return {
      emailQueue: { waiting: emailWaiting, active: emailActive, completed: emailCompleted, failed: emailFailed },
      warmupQueue: { waiting: warmupWaiting, active: warmupActive, completed: warmupCompleted, failed: warmupFailed },
      csvQueue: { waiting: csvWaiting, active: csvActive, completed: csvCompleted, failed: csvFailed },
      enrichmentQueue: { waiting: enrichWaiting, active: enrichActive, completed: enrichCompleted, failed: enrichFailed },
      verificationQueue: { waiting: verifyWaiting, active: verifyActive, completed: verifyCompleted, failed: verifyFailed },
    };
  });
}
