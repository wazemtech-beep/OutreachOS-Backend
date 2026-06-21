import { FastifyInstance } from "fastify";
import prisma from "../lib/db.js";
import { getOrCreateDefaultWorkspace } from "../lib/workspace.js";

export async function analyticsRoutes(app: FastifyInstance) {
  app.get("/analytics/global", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();

    const [totalLeads, totalCampaigns, activeCampaigns, totalSentEmails, emailAccounts] = await Promise.all([
      prisma.lead.count({ where: { leadList: { workspaceId: workspace.id } } }),
      prisma.campaign.count({ where: { workspaceId: workspace.id } }),
      prisma.campaign.count({ where: { workspaceId: workspace.id, status: "ACTIVE" } }),
      prisma.sentEmail.findMany({
        where: { campaign: { workspaceId: workspace.id } },
        select: { status: true, sentAt: true },
      }),
      prisma.emailAccount.findMany({
        where: { workspaceId: workspace.id },
        select: { deliverabilityScore: true },
      }),
    ]);

    const totalSent = totalSentEmails.filter((e) => ["SENT", "DELIVERED", "OPENED", "CLICKED", "REPLIED"].includes(e.status)).length;
    const totalOpened = totalSentEmails.filter((e) => ["OPENED", "CLICKED", "REPLIED"].includes(e.status)).length;
    const totalReplied = totalSentEmails.filter((e) => e.status === "REPLIED").length;
    const totalBounced = totalSentEmails.filter((e) => e.status === "BOUNCED").length;

    const avgDeliverability = emailAccounts.length > 0
      ? emailAccounts.reduce((sum, a) => sum + a.deliverabilityScore, 0) / emailAccounts.length
      : 0;

    return {
      totalLeads,
      totalCampaigns,
      activeCampaigns,
      totalSent,
      openRate: totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : "0",
      replyRate: totalSent > 0 ? ((totalReplied / totalSent) * 100).toFixed(1) : "0",
      bounceRate: totalSent > 0 ? ((totalBounced / totalSent) * 100).toFixed(1) : "0",
      avgDeliverabilityScore: Math.round(avgDeliverability),
      emailAccounts: emailAccounts.length,
    };
  });

  app.get("/analytics/campaigns", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId: workspace.id },
      include: {
        _count: { select: { campaignLeads: true, sentEmails: true } },
        sentEmails: { select: { status: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return campaigns.map((c) => {
      const sent = c.sentEmails.filter((e) => ["SENT", "DELIVERED", "OPENED", "CLICKED", "REPLIED"].includes(e.status)).length;
      const opened = c.sentEmails.filter((e) => ["OPENED", "CLICKED", "REPLIED"].includes(e.status)).length;
      const replied = c.sentEmails.filter((e) => e.status === "REPLIED").length;
      const bounced = c.sentEmails.filter((e) => e.status === "BOUNCED").length;
      return {
        id: c.id, name: c.name, status: c.status,
        totalLeads: c._count.campaignLeads, totalSent: sent,
        openRate: sent > 0 ? ((opened / sent) * 100).toFixed(1) : "0",
        replyRate: sent > 0 ? ((replied / sent) * 100).toFixed(1) : "0",
        bounceRate: sent > 0 ? ((bounced / sent) * 100).toFixed(1) : "0",
        createdAt: c.createdAt,
      };
    });
  });

  app.get("/analytics/leads", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    const statusCounts = await prisma.lead.groupBy({
      by: ["status"],
      where: { leadList: { workspaceId: workspace.id } },
      _count: { status: true },
    });
    return statusCounts.map((s) => ({ status: s.status, count: s._count.status }));
  });

  // Revenue analytics
  app.get("/analytics/revenue", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    const deals = await prisma.deal.findMany({
      where: { workspaceId: workspace.id },
      include: { lead: { select: { companyName: true } } },
    });

    const wonDeals = deals.filter((d) => d.wonAt);
    const totalRevenue = wonDeals.reduce((sum, d) => sum + (d.value || 0), 0);
    const avgDealSize = wonDeals.length > 0 ? totalRevenue / wonDeals.length : 0;

    // Monthly revenue
    const monthlyRevenue: Record<string, number> = {};
    for (const deal of wonDeals) {
      const month = deal.wonAt!.toISOString().substring(0, 7);
      monthlyRevenue[month] = (monthlyRevenue[month] || 0) + (deal.value || 0);
    }

    // Pipeline value
    const pipelineValue = deals.filter((d) => !d.wonAt && !d.lostAt).reduce((sum, d) => sum + (d.value || 0), 0);

    return {
      totalRevenue,
      avgDealSize,
      wonCount: wonDeals.length,
      totalDeals: deals.length,
      pipelineValue,
      monthlyRevenue: Object.entries(monthlyRevenue).sort(([a], [b]) => a.localeCompare(b)).map(([month, revenue]) => ({ month, revenue })),
      dealsByStage: Object.entries(
        deals.reduce((acc, d) => { acc[d.stage] = (acc[d.stage] || 0) + 1; return acc; }, {} as Record<string, number>)
      ).map(([stage, count]) => ({ stage, count })),
    };
  });

  // Funnel data
  app.get("/analytics/funnel", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();

    const [totalLeads, contactedLeads, repliedLeads, interestedLeads, convertedLeads] = await Promise.all([
      prisma.lead.count({ where: { leadList: { workspaceId: workspace.id } } }),
      prisma.lead.count({ where: { leadList: { workspaceId: workspace.id }, status: { not: "NEW" } } }),
      prisma.lead.count({ where: { leadList: { workspaceId: workspace.id }, status: "REPLIED" } }),
      prisma.deal.count({ where: { workspaceId: workspace.id, stage: { in: ["INTERESTED", "MEETING_BOOKED", "PROPOSAL_SENT"] } } }),
      prisma.deal.count({ where: { workspaceId: workspace.id, stage: "DEAL_CLOSED" } }),
    ]);

    return {
      funnel: [
        { stage: "Total Leads", count: totalLeads },
        { stage: "Contacted", count: contactedLeads },
        { stage: "Replied", count: repliedLeads },
        { stage: "Interested", count: interestedLeads },
        { stage: "Converted", count: convertedLeads },
      ],
    };
  });
}
