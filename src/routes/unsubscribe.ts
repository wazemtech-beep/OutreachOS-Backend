import { FastifyInstance } from "fastify";
import prisma from "../lib/db.js";
import { processAutomation } from "../utils/automation-engine.js";

// Unsubscribe webhook handler — called when lead clicks unsubscribe link in email
export async function unsubscribeRoutes(app: FastifyInstance) {

  // Simple unsubscribe page — lead lands here after clicking link
  app.get("/unsubscribe", async (request, reply) => {
    const { email, campaign, token } = request.query as { email: string; campaign: string; token: string };

    if (!email) {
      return reply.send("<html><body><h2>Invalid unsubscribe link</h2></body></html>");
    }

    // Add to global unsubscribe list
    const user = await prisma.user.findFirst();
    if (user) {
      await prisma.globalUnsubscribe.upsert({
        where: { email },
        update: {},
        create: { email, userId: user.id },
      });
    }

    // Find workspace and add to workspace unsubscribe
    const lead = await prisma.lead.findFirst({ where: { email } });
    if (lead) {
      const leadList = await prisma.leadList.findUnique({ where: { id: lead.leadListId }, select: { workspaceId: true } });
      if (leadList) {
        await prisma.workspaceUnsubscribe.upsert({
          where: { email_workspaceId: { email, workspaceId: leadList.workspaceId } },
          update: {},
          create: { email, workspaceId: leadList.workspaceId, source: campaign || "email_link" },
        });

        // Update lead status
        await prisma.lead.update({ where: { id: lead.id }, data: { status: "UNSUBSCRIBED" } });

        // Remove from active campaigns
        await prisma.campaignLead.updateMany({
          where: { leadId: lead.id, exitedAt: null },
          data: { exitedAt: new Date(), exitReason: "unsubscribed" },
        });

        // Fire automation
        processAutomation("unsubscribe_received", { leadId: lead.id, email, campaign }).catch(console.error);
      }
    }

    return reply.send(`
      <html>
        <head><title>Unsubscribed</title>
        <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0;}
        .card{background:#1e293b;padding:3rem;border-radius:1rem;text-align:center;max-width:400px;}</style></head>
        <body><div class="card">
          <h1 style="font-size:1.5rem;margin-bottom:1rem;">Successfully Unsubscribed</h1>
          <p style="color:#94a3b8;">You have been removed from our mailing list. You will no longer receive emails from this campaign.</p>
        </div></body>
      </html>
    `);
  });

  // Check if email is unsubscribed
  app.get("/api/v1/unsubscribed/:email", async (request) => {
    const { email } = request.params as { email: string };
    const globalUnsub = await prisma.globalUnsubscribe.findUnique({ where: { email } });
    return { unsubscribed: !!globalUnsub };
  });
}
