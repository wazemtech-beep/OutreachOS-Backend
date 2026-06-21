import prisma from "../lib/db.js";

interface HealthReport {
  accountId: string;
  email: string;
  healthScore: number;
  issues: { type: string; severity: string; message: string; action: string }[];
  actionsTaken: string[];
}

export async function runDeliverabilityAgent(): Promise<HealthReport[]> {
  const accounts = await prisma.emailAccount.findMany({
    where: { status: { in: ["CONNECTED", "WARNING"] } },
  });

  const reports: HealthReport[] = [];

  for (const account of accounts) {
    const issues: HealthReport["issues"] = [];
    const actionsTaken: string[] = [];
    let healthScore = 100;

    // Check bounce rate (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [bounced, totalSent] = await Promise.all([
      prisma.sentEmail.count({
        where: { accountId: account.id, status: "BOUNCED", sentAt: { gte: sevenDaysAgo } },
      }),
      prisma.sentEmail.count({
        where: {
          accountId: account.id,
          status: { in: ["SENT", "DELIVERED", "OPENED", "CLICKED", "REPLIED", "BOUNCED"] },
          sentAt: { gte: sevenDaysAgo },
        },
      }),
    ]);

    const bounceRate = totalSent > 0 ? (bounced / totalSent) * 100 : 0;

    if (bounceRate > 5) {
      issues.push({
        type: "HIGH_BOUNCE_RATE",
        severity: "critical",
        message: `Bounce rate is ${bounceRate.toFixed(1)}% (threshold: 5%)`,
        action: "Pause campaigns and verify email list",
      });
      healthScore -= 30;

      // Auto-pause campaigns using this account
      const campaigns = await prisma.campaign.findMany({
        where: { status: "ACTIVE" },
      });
      for (const campaign of campaigns) {
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: "PAUSED" },
        });
        actionsTaken.push(`Paused campaign: ${campaign.name}`);
      }
    } else if (bounceRate > 3) {
      issues.push({
        type: "ELEVATED_BOUNCE_RATE",
        severity: "warning",
        message: `Bounce rate is ${bounceRate.toFixed(1)}% — approaching threshold`,
        action: "Consider cleaning your email list",
      });
      healthScore -= 15;
    }

    // Check warmup progress
    if (account.warmupEnabled && account.warmupCurrentDay < 14) {
      healthScore -= 10;
      issues.push({
        type: "WARMUP_IN_PROGRESS",
        severity: "info",
        message: `Warmup day ${account.warmupCurrentDay}/14 — account still warming up`,
        action: "Keep sending volume low until warmup completes",
      });
    }

    // Check daily send volume vs account age
    const accountAge = Math.floor((Date.now() - account.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    if (accountAge < 30 && account.dailyLimit > 30) {
      issues.push({
        type: "AGGRESSIVE_LIMIT",
        severity: "warning",
        message: `Account is ${accountAge} days old but daily limit is ${account.dailyLimit}`,
        action: "Reduce daily limit for newer accounts",
      });
      healthScore -= 10;
    }

    // Auto-adjust daily limit based on health
    if (healthScore < 50 && account.dailyLimit > 20) {
      const newLimit = Math.max(20, Math.floor(account.dailyLimit * 0.5));
      await prisma.emailAccount.update({
        where: { id: account.id },
        data: { dailyLimit: newLimit, status: "WARNING" },
      });
      actionsTaken.push(`Reduced daily limit from ${account.dailyLimit} to ${newLimit}`);
    }

    // Update health score
    await prisma.emailAccount.update({
      where: { id: account.id },
      data: { deliverabilityScore: Math.max(0, healthScore) },
    });

    reports.push({
      accountId: account.id,
      email: account.email,
      healthScore: Math.max(0, healthScore),
      issues,
      actionsTaken,
    });
  }

  console.log(`[DELIVERABILITY] Agent checked ${reports.length} accounts`);
  return reports;
}
