import { FastifyInstance } from "fastify";
import prisma from "../lib/db.js";
import { getOrCreateDefaultWorkspace } from "../lib/workspace.js";
import { encryptApiKey, decryptApiKey } from "../utils/encryption.js";

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/settings", async () => {
    const { user, workspace } = await getOrCreateDefaultWorkspace();
    return { ...user, enforceSchedule: workspace.enforceSchedule };
  });

  app.put("/settings", async (request) => {
    const { name, email, signature, timezone, currency, language, enforceSchedule } = request.body as any;
    const { user, workspace } = await getOrCreateDefaultWorkspace();
    
    if (enforceSchedule !== undefined) {
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: { enforceSchedule }
      });
    }

    return prisma.user.update({
      where: { id: user.id },
      data: { name, email, signature, timezone, currency, language },
    });
  });

  // === Integrations with Encryption ===
  app.get("/integrations", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    const integrations = await prisma.integrationConfig.findMany({ where: { workspaceId: workspace.id } });
    // Return masked keys for security
    return integrations.map((i) => ({
      ...i,
      apiKey: i.apiKey ? "••••••" + i.apiKey.slice(-4) : null,
      hasKey: !!i.apiKey,
    }));
  });

  app.post("/integrations", async (request, reply) => {
    const { provider, apiKey, metadata } = request.body as { provider: string; apiKey: string; metadata?: any };
    const { workspace } = await getOrCreateDefaultWorkspace();
    const encryptedKey = encryptApiKey(apiKey);
    const integration = await prisma.integrationConfig.upsert({
      where: { provider_workspaceId: { provider, workspaceId: workspace.id } },
      update: { apiKey: encryptedKey, metadata },
      create: { provider, apiKey: encryptedKey, metadata, workspaceId: workspace.id },
    });
    return reply.status(201).send({ ...integration, apiKey: "••••••" + apiKey.slice(-4) });
  });

  app.delete("/integrations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.integrationConfig.delete({ where: { id } });
    return reply.status(204).send();
  });

  // Get decrypted API key for internal use
  app.get("/integrations/:provider/key", async (request) => {
    const { provider } = request.params as { provider: string };
    const { workspace } = await getOrCreateDefaultWorkspace();
    const integration = await prisma.integrationConfig.findFirst({
      where: { provider, workspaceId: workspace.id },
    });
    if (!integration) return { key: null };
    return { key: decryptApiKey(integration.apiKey) };
  });

  app.get("/unsubscribes", async () => {
    const { user } = await getOrCreateDefaultWorkspace();
    return prisma.globalUnsubscribe.findMany({ where: { userId: user.id } });
  });

  app.delete("/unsubscribes/:email", async (request, reply) => {
    const { email } = request.params as { email: string };
    await prisma.globalUnsubscribe.deleteMany({ where: { email } });
    return reply.status(204).send();
  });

  app.post("/unsubscribes", async (request) => {
    const { email } = request.body as { email: string };
    const { user } = await getOrCreateDefaultWorkspace();
    return prisma.globalUnsubscribe.upsert({
      where: { email },
      update: {},
      create: { email, userId: user.id },
    });
  });

  // === Knowledge Base ===
  app.get("/knowledge-base", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    let kb = await prisma.knowledgeBase.findUnique({ where: { workspaceId: workspace.id } });
    if (!kb) {
      kb = await prisma.knowledgeBase.create({ data: { workspaceId: workspace.id } });
    }
    return kb;
  });

  app.put("/knowledge-base", async (request) => {
    const body = request.body as any;
    const { workspace } = await getOrCreateDefaultWorkspace();
    return prisma.knowledgeBase.upsert({
      where: { workspaceId: workspace.id },
      update: body,
      create: { ...body, workspaceId: workspace.id },
    });
  });

  // === Data Export ===
  app.get("/export", async (request, reply) => {
    const { workspace } = await getOrCreateDefaultWorkspace();

    const [leads, campaigns, emailAccounts, sentEmails, automations, tasks] = await Promise.all([
      prisma.lead.findMany({ where: { leadList: { workspaceId: workspace.id } } }),
      prisma.campaign.findMany({ where: { workspaceId: workspace.id }, include: { steps: true } }),
      prisma.emailAccount.findMany({ where: { workspaceId: workspace.id }, select: { id: true, label: true, email: true, status: true, provider: true } }),
      prisma.sentEmail.findMany({ where: { campaign: { workspaceId: workspace.id } } }),
      prisma.automation.findMany({ where: { workspaceId: workspace.id } }),
      prisma.task.findMany({ where: { workspaceId: workspace.id } }),
    ]);

    const exportData = {
      exportDate: new Date().toISOString(),
      workspace: { name: workspace.name, slug: workspace.slug },
      leads,
      campaigns,
      emailAccounts,
      sentEmails,
      automations,
      tasks,
    };

    reply.header("Content-Type", "application/json");
    reply.header("Content-Disposition", `attachment; filename="outreachos-export-${workspace.slug}-${Date.now()}.json"`);
    return reply.send(JSON.stringify(exportData, null, 2));
  });
}
