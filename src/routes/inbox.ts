import { FastifyInstance } from "fastify";
import prisma from "../lib/db.js";
import { getOrCreateDefaultWorkspace } from "../lib/workspace.js";

export async function inboxRoutes(app: FastifyInstance) {
  app.get("/inbox", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    const emails = await prisma.incomingEmail.findMany({
      where: { account: { workspaceId: workspace.id } },
      include: {
        account: { select: { email: true, label: true } },
        campaignLead: {
          include: {
            campaign: { select: { name: true } },
            lead: { select: { firstName: true, lastName: true, email: true, companyName: true } },
          },
        },
      },
      orderBy: { receivedAt: "desc" },
      take: 100,
    });
    
    // Map to frontend expected format
    return emails.map(e => ({
      id: e.id,
      recipientEmail: e.toEmail,
      senderEmail: e.fromEmail,
      subject: e.subject,
      body: e.htmlBody || e.textBody || "",
      textBody: e.textBody,
      status: e.isRead ? "READ" : "UNREAD",
      sentAt: e.receivedAt,
      isCampaignReply: !!e.campaignLeadId,
      account: e.account,
      campaign: e.campaignLead?.campaign,
      campaignLead: e.campaignLead,
    }));
  });

  app.get("/inbox/:emailId", async (request) => {
    const { emailId } = request.params as { emailId: string };
    const email = await prisma.incomingEmail.findUnique({
      where: { id: emailId },
      include: {
        account: { select: { email: true, label: true } },
        campaignLead: {
          include: {
            campaign: { select: { name: true } },
            lead: true,
          },
        },
      },
    });

    if (email && !email.isRead) {
      await prisma.incomingEmail.update({ where: { id: email.id }, data: { isRead: true } });
      email.isRead = true;
    }

    return email;
  });
}
