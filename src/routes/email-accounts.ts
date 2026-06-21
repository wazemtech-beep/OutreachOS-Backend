import { FastifyInstance } from "fastify";
import prisma from "../lib/db.js";
import { getOrCreateDefaultWorkspace } from "../lib/workspace.js";
import { z } from "zod";
import { buildTransporter } from "../jobs/email-sender.js";

const createAccountSchema = z.object({
  label: z.string().min(1),
  email: z.string().email(),
  smtpHost: z.string(),
  smtpPort: z.number(),
  smtpUser: z.string(),
  smtpPass: z.string(),
  smtpSecure: z.boolean().default(true),
  imapHost: z.string().optional(),
  imapPort: z.number().optional(),
  imapUser: z.string().optional(),
  imapPass: z.string().optional(),
  imapSecure: z.boolean().default(true),
  role: z.enum(["SENDING_ONLY", "WARMUP_ONLY", "BOTH"]).default("BOTH"),
  dailyLimit: z.number().default(50),
});

export async function emailAccountRoutes(app: FastifyInstance) {
  app.get("/email-accounts", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    return prisma.emailAccount.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
    });
  });

  app.post("/email-accounts", async (request, reply) => {
    const body = createAccountSchema.parse(request.body);
    const { workspace } = await getOrCreateDefaultWorkspace();
    try {
      const transporter = await buildTransporter({ ...body, provider: "smtp" });
      await transporter.verify();
    } catch (err: any) {
      return reply.status(400).send({ error: "SMTP connection failed", details: err.message });
    }
    const account = await prisma.emailAccount.create({
      data: { ...body, workspaceId: workspace.id },
    });
    return reply.status(201).send(account);
  });

  app.put("/email-accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = createAccountSchema.partial().parse(request.body);
    return prisma.emailAccount.update({ where: { id }, data: body });
  });

  app.delete("/email-accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.emailAccount.delete({ where: { id } });
    return reply.status(204).send();
  });

  app.put("/email-accounts/:id/toggle-warmup", async (request) => {
    const { id } = request.params as { id: string };
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) return { error: "Not found" };
    return prisma.emailAccount.update({
      where: { id },
      data: { warmupEnabled: !account.warmupEnabled },
    });
  });

  app.put("/email-accounts/:id/pause", async (request) => {
    const { id } = request.params as { id: string };
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) return { error: "Not found" };
    return prisma.emailAccount.update({
      where: { id },
      data: { status: account.status === "CONNECTED" ? "DISCONNECTED" : "CONNECTED" },
    });
  });

  app.post("/email-accounts/:id/test", async (request) => {
    const { id } = request.params as { id: string };
    const { testEmail } = request.body as { testEmail: string };
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) return { error: "Not found" };
    try {
      const transporter = await buildTransporter(account);
      await transporter.sendMail({
        from: account.email,
        to: testEmail,
        subject: "OutreachOS - Test Email",
        text: "If you received this, your email account is connected successfully!",
      });
      return { success: true, message: "Test email sent successfully" };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}
