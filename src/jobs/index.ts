import prisma from "../lib/db.js";
import { campaignScheduleQueue, imapSyncQueue } from "../lib/queue.js";
import emailSendWorker from "./email-sender.js";
import warmupWorker from "./warmup.js";
import imapSyncWorker from "./imap-sync.js";
import campaignSchedulerWorker from "./campaign-scheduler.js";
import csvImportWorker from "./csv-import.js";

console.log("[WORKERS] Starting all workers...");

// Auto campaign scheduler - runs every 15 minutes
setInterval(async () => {
  try {
    const activeCampaigns = await prisma.campaign.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
    });
    for (const campaign of activeCampaigns) {
      await campaignScheduleQueue.add("auto-schedule", { campaignId: campaign.id }, {
        removeOnComplete: true,
        attempts: 2,
      });
    }
    if (activeCampaigns.length > 0) {
      console.log(`[WORKERS] Auto-scheduled ${activeCampaigns.length} campaigns`);
    }
  } catch (err: any) {
    console.error("[WORKERS] Auto-schedule error:", err.message);
  }
}, 1 * 60 * 1000); // 1 minute interval

// Auto IMAP sync - runs every 2 minutes
setInterval(async () => {
  try {
    const connectedAccounts = await prisma.emailAccount.findMany({
      where: { status: "CONNECTED" },
      select: { id: true, email: true },
    });
    for (const account of connectedAccounts) {
      await imapSyncQueue.add("auto-imap-sync", { accountId: account.id }, {
        removeOnComplete: true,
        attempts: 1,
      });
    }
    if (connectedAccounts.length > 0) {
      console.log(`[WORKERS] Auto-queued IMAP sync for ${connectedAccounts.length} accounts`);
    }
  } catch (err: any) {
    console.error("[WORKERS] Auto-IMAP-sync error:", err.message);
  }
}, 2 * 60 * 1000); // 2 minute interval

export {
  emailSendWorker,
  warmupWorker,
  imapSyncWorker,
  campaignSchedulerWorker,
  csvImportWorker,
};

console.log("[WORKERS] Core workers started. Auto-scheduler active (15min interval).");
