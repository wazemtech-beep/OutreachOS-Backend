import { FastifyInstance } from "fastify";
import prisma from "../lib/db.js";
import { getOrCreateDefaultWorkspace } from "../lib/workspace.js";
import { decryptApiKey } from "../utils/encryption.js";
import { getVariantAnalytics, getWinningVariant } from "../utils/ab-testing.js";
import { generatePersonalizedOpeningLine, generateSubjectVariants } from "../utils/ai-personalization.js";
import { emailSendQueue } from "../lib/queue.js";
import { processEmailText } from "../utils/personalization.js";
import { z } from "zod";

const createCampaignSchema = z.object({
  name: z.string().min(1),
  leadListId: z.string().optional(),
  savedSegmentId: z.string().optional(),
  dailySendLimit: z.number().default(100),
  timezone: z.string().default("UTC"),
  sendingDays: z.array(z.number()).optional(),
  sendingWindowStart: z.string().optional(),
  sendingWindowEnd: z.string().optional(),
  minDelayMinutes: z.number().default(2),
  maxDelayMinutes: z.number().default(5),
  stopCondition: z.string().optional(),
});

const createStepSchema = z.object({
  order: z.number(),
  type: z.enum(["EMAIL", "LINKEDIN", "WEBHOOK", "NOTE", "CALL", "SMS"]).default("EMAIL"),
  subject: z.string().optional(),
  body: z.string().optional(),
  delayDays: z.number().default(3),
  isReplyThread: z.boolean().default(false),
  variantGroup: z.string().optional(),
  metadata: z.any().optional(),
});

export async function campaignRoutes(app: FastifyInstance) {
  app.get("/campaigns", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    return prisma.campaign.findMany({
      where: { workspaceId: workspace.id },
      include: {
        steps: { orderBy: { order: "asc" } },
        leadList: { select: { name: true, _count: { select: { leads: true } } } },
        _count: { select: { campaignLeads: true, sentEmails: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  app.post("/campaigns", async (request, reply) => {
    const body = createCampaignSchema.parse(request.body);
    const { workspace } = await getOrCreateDefaultWorkspace();
    const campaign = await prisma.campaign.create({
      data: {
        name: body.name,
        workspaceId: workspace.id,
        leadListId: body.leadListId,
        savedSegmentId: body.savedSegmentId,
        dailySendLimit: body.dailySendLimit,
        timezone: body.timezone,
        sendingDays: body.sendingDays ?? [1, 2, 3, 4, 5],
        sendingWindowStart: body.sendingWindowStart ?? "09:00",
        sendingWindowEnd: body.sendingWindowEnd ?? "17:00",
        minDelayMinutes: body.minDelayMinutes,
        maxDelayMinutes: body.maxDelayMinutes,
        stopCondition: body.stopCondition,
      },
    });
    return reply.status(201).send(campaign);
  });

  app.get("/campaigns/:id", async (request) => {
    const { id } = request.params as { id: string };
    return prisma.campaign.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { order: "asc" } },
        leadList: { select: { name: true } },
        _count: { select: { campaignLeads: true, sentEmails: true } },
      },
    });
  });

  app.put("/campaigns/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = createCampaignSchema.partial().parse(request.body);
    return prisma.campaign.update({ where: { id }, data: body });
  });

  app.put("/campaigns/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: string };

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        workspace: { select: { enforceSchedule: true } },
        steps: { orderBy: { order: "asc" } },
        leadList: { include: { leads: true } },
      },
    });

    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });

    if (status === "ACTIVE") {
      // 1. Sync leads into CampaignLead table
      const existingLeads = await prisma.campaignLead.findMany({
        where: { campaignId: id },
        select: { leadId: true },
      });
      const existingLeadIds = new Set(existingLeads.map((l) => l.leadId));
      const newLeads = (campaign.leadList?.leads || []).filter((l) => !existingLeadIds.has(l.id));
      if (newLeads.length > 0) {
        await prisma.campaignLead.createMany({
          data: newLeads.map((l) => ({ campaignId: id, leadId: l.id })),
        });
      }

      // 2. Update status first
      const updated = await prisma.campaign.update({ where: { id }, data: { status: status as any } });

      // 3. Directly queue email-send jobs (bypass campaignScheduleQueue worker)
      const accounts = await prisma.emailAccount.findMany({
        where: { workspaceId: campaign.workspaceId, status: "CONNECTED", role: { in: ["SENDING_ONLY", "BOTH"] } },
      });

      if (accounts.length > 0 && campaign.steps.length > 0) {
        const campaignLeads = await prisma.campaignLead.findMany({
          where: { campaignId: id, exitedAt: null },
          include: { lead: true },
        });

        let queued = 0;
        const enforceSchedule = campaign.workspace?.enforceSchedule;
        for (const cl of campaignLeads) {
          const step = campaign.steps[cl.currentStep];
          if (!step || step.type !== "EMAIL" || !step.subject || !step.body) continue;

          const sender = { name: "Outreach", email: accounts[queued % accounts.length].email };
          const subject = processEmailText(step.subject, cl.lead, sender);
          const body = processEmailText(step.body, cl.lead, sender);
          const account = accounts[queued % accounts.length];
          const delayMs = (campaign.minDelayMinutes ?? 0) * 60 * 1000 * queued;

          await emailSendQueue.add("send-email", {
            accountId: account.id,
            campaignId: id,
            campaignLeadId: cl.id,
            stepId: step.id,
            recipientEmail: cl.lead.email,
            subject,
            body,
          }, { delay: delayMs });

          await prisma.campaignLead.update({ where: { id: cl.id }, data: { currentStep: cl.currentStep + 1 } });
          queued++;
          console.log(`[CAMPAIGN] Queued email to ${cl.lead.email} with ${delayMs}ms delay`);
        }
        console.log(`[CAMPAIGN] ${campaign.name}: Queued ${queued} emails directly.`);
      }

      return updated;
    }

    return prisma.campaign.update({ where: { id }, data: { status: status as any } });
  });

  app.delete("/campaigns/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.campaign.delete({ where: { id } });
    return reply.status(204).send();
  });

  app.post("/campaigns/:id/duplicate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const original = await prisma.campaign.findUnique({ where: { id }, include: { steps: true } });
    if (!original) return reply.status(404).send({ error: "Campaign not found" });
    const duplicate = await prisma.campaign.create({
      data: {
        name: `${original.name} (Copy)`,
        workspaceId: original.workspaceId,
        leadListId: original.leadListId,
        dailySendLimit: original.dailySendLimit,
        timezone: original.timezone,
        sendingDays: original.sendingDays as any,
        sendingWindowStart: original.sendingWindowStart,
        sendingWindowEnd: original.sendingWindowEnd,
        minDelayMinutes: original.minDelayMinutes,
        maxDelayMinutes: original.maxDelayMinutes,
        stopCondition: original.stopCondition,
        steps: {
          create: original.steps.map((s) => ({
            order: s.order, type: s.type, subject: s.subject, body: s.body,
            delayDays: s.delayDays, isReplyThread: s.isReplyThread,
            variantGroup: s.variantGroup, variantSplit: s.variantSplit as any, metadata: s.metadata as any,
          })),
        },
      },
      include: { steps: true },
    });
    return reply.status(201).send(duplicate);
  });

  app.get("/campaigns/:campaignId/steps", async (request) => {
    const { campaignId } = request.params as { campaignId: string };
    return prisma.campaignStep.findMany({ where: { campaignId }, orderBy: { order: "asc" } });
  });

  app.post("/campaigns/:campaignId/steps", async (request, reply) => {
    const { campaignId } = request.params as { campaignId: string };
    const body = createStepSchema.parse(request.body);
    const step = await prisma.campaignStep.create({ data: { ...body, campaignId } });
    return reply.status(201).send(step);
  });

  app.put("/steps/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = createStepSchema.partial().parse(request.body);
    return prisma.campaignStep.update({ where: { id }, data: body });
  });

  app.delete("/steps/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.campaignStep.delete({ where: { id } });
    return reply.status(204).send();
  });

  app.put("/steps/reorder", async (request) => {
    const { steps } = request.body as { steps: { id: string; order: number }[] };
    for (const s of steps) {
      await prisma.campaignStep.update({ where: { id: s.id }, data: { order: s.order } });
    }
    return { success: true };
  });

  app.get("/campaigns/:id/analytics", async (request) => {
    const { id } = request.params as { id: string };
    const [campaign, sentEmails, steps] = await Promise.all([
      prisma.campaign.findUnique({ where: { id }, select: { _count: { select: { campaignLeads: true } } } }),
      prisma.sentEmail.findMany({ where: { campaignId: id } }),
      prisma.campaignStep.findMany({ where: { campaignId: id }, orderBy: { order: "asc" } }),
    ]);

    const totalSent = sentEmails.filter((e) => ["SENT", "DELIVERED", "OPENED", "CLICKED", "REPLIED"].includes(e.status)).length;
    const totalOpened = sentEmails.filter((e) => ["OPENED", "CLICKED", "REPLIED"].includes(e.status)).length;
    const totalReplied = sentEmails.filter((e) => e.status === "REPLIED").length;
    const totalBounced = sentEmails.filter((e) => e.status === "BOUNCED").length;
    const totalClicked = sentEmails.filter((e) => e.status === "CLICKED").length;

    const stepAnalytics = steps.map((step) => {
      const stepEmails = sentEmails.filter((e) => e.stepId === step.id);
      const sent = stepEmails.filter((e) => ["SENT", "DELIVERED", "OPENED", "CLICKED", "REPLIED"].includes(e.status)).length;
      const opened = stepEmails.filter((e) => ["OPENED", "CLICKED", "REPLIED"].includes(e.status)).length;
      const replied = stepEmails.filter((e) => e.status === "REPLIED").length;
      return {
        stepId: step.id, order: step.order, type: step.type, subject: step.subject,
        sent, openRate: sent > 0 ? ((opened / sent) * 100).toFixed(1) : "0",
        replyRate: sent > 0 ? ((replied / sent) * 100).toFixed(1) : "0",
      };
    });

    return {
      campaignId: id,
      totalLeads: campaign?._count.campaignLeads ?? 0,
      totalSent,
      openRate: totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : "0",
      replyRate: totalSent > 0 ? ((totalReplied / totalSent) * 100).toFixed(1) : "0",
      bounceRate: totalSent > 0 ? ((totalBounced / totalSent) * 100).toFixed(1) : "0",
      clickRate: totalSent > 0 ? ((totalClicked / totalSent) * 100).toFixed(1) : "0",
      stepAnalytics,
    };
  });

  // === A/B Testing Endpoints ===

  // Add a variant to a step
  app.post("/campaigns/:campaignId/steps/:stepId/variants", async (request, reply) => {
    const { campaignId, stepId } = request.params as { campaignId: string; stepId: string };
    const { subject, body, splitPercent } = request.body as {
      subject?: string; body?: string; splitPercent?: number;
    };

    const originalStep = await prisma.campaignStep.findUnique({ where: { id: stepId } });
    if (!originalStep) return reply.status(404).send({ error: "Step not found" });

    const group = originalStep.variantGroup || `ab-${stepId}`;
    const existingVariants = await prisma.campaignStep.findMany({
      where: { variantGroup: group },
    });

    const variantIndex = existingVariants.length + 1;
    const variant = await prisma.campaignStep.create({
      data: {
        order: originalStep.order,
        type: originalStep.type,
        subject: subject || originalStep.subject,
        body: body || originalStep.body,
        delayDays: originalStep.delayDays,
        isReplyThread: originalStep.isReplyThread,
        variantGroup: group,
        variantSplit: { variantIndex, percent: splitPercent || Math.floor(100 / (variantIndex + 1)) },
        campaignId,
      },
    });

    // Update original step's variant group
    await prisma.campaignStep.update({
      where: { id: stepId },
      data: { variantGroup: group },
    });

    return reply.status(201).send(variant);
  });

  // Get variant analytics for a campaign
  app.get("/campaigns/:id/ab-analytics", async (request) => {
    const { id } = request.params as { id: string };
    const variantData = await getVariantAnalytics(id);
    return variantData;
  });

  // Declare a winning variant
  app.post("/campaigns/:campaignId/steps/:stepId/winner", async (request) => {
    const { campaignId, stepId } = request.params as { campaignId: string; stepId: string };
    const group = (await prisma.campaignStep.findUnique({ where: { id: stepId } }))?.variantGroup;
    if (!group) return { error: "Step has no variant group" };

    // Delete all other variants in the group
    const deleted = await prisma.campaignStep.deleteMany({
      where: { variantGroup: group, id: { not: stepId } },
    });

    await prisma.campaignStep.update({
      where: { id: stepId },
      data: { variantGroup: null, variantSplit: null as any },
    });

    return { success: true, deletedVariants: deleted.count };
  });

  // === AI Personalization Endpoints ===

  // Generate AI opening line for a single lead
  app.post("/campaigns/:id/ai-generate", async (request) => {
    const { id } = request.params as { id: string };
    const { leadId, businessDescription } = request.body as { leadId: string; businessDescription: string };

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) return { error: "Lead not found" };

    // Get OpenAI key from integrations
    const { workspace } = await getOrCreateDefaultWorkspace();
    const integration = await prisma.integrationConfig.findFirst({
      where: { workspaceId: workspace.id, provider: "openai" },
    });

    const result = await generatePersonalizedOpeningLine({
      leadEmail: lead.email,
      leadFirstName: lead.firstName || undefined,
      leadLastName: lead.lastName || undefined,
      leadCompany: lead.companyName || undefined,
      leadJobTitle: lead.jobTitle || undefined,
      leadIndustry: lead.industry || undefined,
      leadLinkedinUrl: lead.linkedinUrl || undefined,
      leadWebsite: lead.website || undefined,
      businessDescription,
    }, integration?.apiKey ? decryptApiKey(integration.apiKey) : undefined);

    return result;
  });

  // Generate A/B subject variants
  app.post("/campaigns/:id/ai-subject-variants", async (request) => {
    const { id } = request.params as { id: string };
    const { baseSubject, count } = request.body as { baseSubject: string; count?: number };

    const { workspace } = await getOrCreateDefaultWorkspace();
    const integration = await prisma.integrationConfig.findFirst({
      where: { workspaceId: workspace.id, provider: "openai" },
    });

    const variants = await generateSubjectVariants(baseSubject, count || 3, integration?.apiKey ? decryptApiKey(integration.apiKey) : undefined);
    return { variants };
  });

  // Preview email with variables populated
  app.post("/campaigns/:id/preview-step", async (request) => {
    const { stepId, leadId } = request.body as { stepId: string; leadId: string };
    const step = await prisma.campaignStep.findUnique({ where: { id: stepId } });
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!step || !lead) return { error: "Step or lead not found" };

    const { processEmailText } = await import("../utils/personalization.js");
    const sender = { name: "User", email: "user@outreachos.local" };

    return {
      subject: processEmailText(step.subject || "", lead as any, sender),
      body: processEmailText(step.body || "", lead as any, sender),
    };
  });
}
