import { createWorker, emailSendQueue } from "../lib/queue.js";
import prisma from "../lib/db.js";
import { processEmailText } from "../utils/personalization.js";
import { assignVariant } from "../utils/ab-testing.js";
import { executeWebhook, buildWebhookPayload } from "../utils/webhook.js";

const campaignSchedulerWorker = createWorker("campaign-schedule", async (job) => {
  const { campaignId } = job.data;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      workspace: { select: { enforceSchedule: true } },
      steps: { orderBy: { order: "asc" } },
      campaignLeads: {
        where: { exitedAt: null },
        include: { lead: true },
      },
    },
  });

  if (!campaign || campaign.status !== "ACTIVE") {
    return { skipped: true, reason: "not_active" };
  }

  const now = new Date();
  const dayOfWeek = now.getDay();
  const sendingDays: number[] = (campaign.sendingDays as number[]) || [1, 2, 3, 4, 5];

  if (campaign.workspace?.enforceSchedule !== false) {
    if (!sendingDays.includes(dayOfWeek)) {
      return { skipped: true, reason: "not_sending_day" };
    }

    const hours = now.getHours();
    const startHour = parseInt(campaign.sendingWindowStart?.split(":")[0] || "9");
    const endHour = parseInt(campaign.sendingWindowEnd?.split(":")[0] || "17");

    if (hours < startHour || hours >= endHour) {
      return { skipped: true, reason: "outside_window" };
    }
  }

  // Daily limit check
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todaySentCount = await prisma.sentEmail.count({
    where: {
      campaignId,
      sentAt: { gte: todayStart },
      status: { in: ["SENT", "DELIVERED", "OPENED", "CLICKED", "REPLIED"] },
    },
  });

  const remaining = campaign.dailySendLimit - todaySentCount;
  if (remaining <= 0) {
    return { skipped: true, reason: "daily_limit" };
  }

  // FIX: Filter accounts by workspace
  const accounts = await prisma.emailAccount.findMany({
    where: { workspaceId: campaign.workspaceId, status: "CONNECTED", role: { in: ["SENDING_ONLY", "BOTH"] } },
  });
  if (accounts.length === 0) {
    return { skipped: true, reason: "no_accounts" };
  }

  let sent = 0;
  const minDelay = campaign.minDelayMinutes ?? 2;
  const maxDelay = campaign.maxDelayMinutes ?? 5;

  for (const cl of campaign.campaignLeads) {
    if (sent >= remaining) break;

    const step = campaign.steps[cl.currentStep];
    if (!step) continue;

    // FIX: Drip spacing - check if enough time has passed since last email
    if (cl.currentStep > 0) {
      const lastSentEmail = await prisma.sentEmail.findFirst({
        where: { campaignLeadId: cl.id },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true },
      });
      if (lastSentEmail) {
        const daysSinceLastEmail = (now.getTime() - lastSentEmail.sentAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceLastEmail < step.delayDays) {
          continue; // Skip this lead - not enough time has passed
        }
      }
    }

    // A/B Testing: Get the right variant
    let activeStep = step;
    if (step.variantGroup) {
      const variants = campaign.steps.filter((s) => s.variantGroup === step.variantGroup);
      const variantOptions = variants.map((v) => ({
        id: v.id,
        splitPercent: (v.variantSplit as any)?.percent || Math.floor(100 / variants.length),
      }));
      const assignedVariantId = assignVariant(cl.leadId, variantOptions);
      activeStep = variants.find((v) => v.id === assignedVariantId) || step;
    }

    // Multichannel Step Handling
    if (activeStep.type === "LINKEDIN") {
      await prisma.task.create({
        data: {
          type: "LINKEDIN",
          title: `LinkedIn: ${activeStep.subject || "Send message"}`,
          description: activeStep.body || `Message ${cl.lead.firstName || cl.lead.email}`,
          leadId: cl.leadId,
          workspaceId: campaign.workspaceId,
        },
      });
      // FIX: Increment step so task isn't created again
      await prisma.campaignLead.update({ where: { id: cl.id }, data: { currentStep: cl.currentStep + 1 } });
      continue;
    }

    if (activeStep.type === "WEBHOOK") {
      const webhookUrl = activeStep.subject || (activeStep.metadata as any)?.url;
      if (webhookUrl) {
        const payload = buildWebhookPayload("WEBHOOK", cl.lead, campaign, activeStep);
        await executeWebhook(webhookUrl, payload);
      }
      await prisma.campaignLead.update({ where: { id: cl.id }, data: { currentStep: cl.currentStep + 1 } });
      continue;
    }

    if (activeStep.type === "NOTE") {
      await prisma.task.create({
        data: { type: "NOTE", title: activeStep.body || "Internal note", leadId: cl.leadId, workspaceId: campaign.workspaceId },
      });
      await prisma.campaignLead.update({ where: { id: cl.id }, data: { currentStep: cl.currentStep + 1 } });
      continue;
    }

    // EMAIL Step
    if (activeStep.type !== "EMAIL" || !activeStep.subject || !activeStep.body) continue;

    const sender = { name: "User", email: "user@outreachos.local" };
    let subject = processEmailText(activeStep.subject, cl.lead, sender);
    let body = processEmailText(activeStep.body, cl.lead, sender);

    if (campaign.unsubscribeLink) {
      body += `\n\n<a href="${campaign.unsubscribeLink}">Unsubscribe</a>`;
    }

    // FIX: Rotate across workspace accounts
    const account = accounts[sent % accounts.length];

    const delayMinutes = minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));

    await emailSendQueue.add("send-email", {
      accountId: account.id,
      campaignId: campaign.id,
      campaignLeadId: cl.id,
      stepId: activeStep.id,
      recipientEmail: cl.lead.email,
      subject,
      body,
    }, { delay: delayMinutes * 60 * 1000 });

    await prisma.campaignLead.update({ where: { id: cl.id }, data: { currentStep: cl.currentStep + 1 } });
    sent++;
  }

  return { campaignId: campaign.id, queued: sent, dailySent: todaySentCount + sent };
});

export default campaignSchedulerWorker;
