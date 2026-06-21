import prisma from "../lib/db.js";

// Assign a lead to a variant based on split percentage
export function assignVariant(
  leadId: string,
  variants: { id: string; splitPercent: number }[]
): string {
  // Deterministic assignment based on lead ID hash
  const hash = simpleHash(leadId);
  const bucket = hash % 100;

  let cumulative = 0;
  for (const v of variants) {
    cumulative += v.splitPercent;
    if (bucket < cumulative) return v.id;
  }

  return variants[variants.length - 1].id;
}

// Simple string hash function
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

// Get analytics for A/B test variants in a campaign
export async function getVariantAnalytics(campaignId: string) {
  const steps = await prisma.campaignStep.findMany({
    where: { campaignId, variantGroup: { not: null } },
    orderBy: { order: "asc" },
  });

  // Group steps by variant group
  const groups: Record<string, any[]> = {};
  for (const step of steps) {
    const group = step.variantGroup || `step-${step.order}`;
    if (!groups[group]) groups[group] = [];
    groups[group].push(step);
  }

  const results: Record<string, any[]> = {};

  for (const [group, groupSteps] of Object.entries(groups)) {
    results[group] = [];

    for (const step of groupSteps) {
      const sentEmails = await prisma.sentEmail.findMany({
        where: { stepId: step.id },
        select: { status: true },
      });

      const total = sentEmails.filter((e) =>
        ["SENT", "DELIVERED", "OPENED", "CLICKED", "REPLIED"].includes(e.status)
      ).length;
      const opened = sentEmails.filter((e) =>
        ["OPENED", "CLICKED", "REPLIED"].includes(e.status)
      ).length;
      const replied = sentEmails.filter((e) => e.status === "REPLIED").length;
      const clicked = sentEmails.filter((e) => e.status === "CLICKED").length;

      results[group].push({
        stepId: step.id,
        variantGroup: group,
        variantSplit: step.variantSplit,
        subject: step.subject,
        total,
        openRate: total > 0 ? ((opened / total) * 100).toFixed(1) : "0",
        replyRate: total > 0 ? ((replied / total) * 100).toFixed(1) : "0",
        clickRate: total > 0 ? ((clicked / total) * 100).toFixed(1) : "0",
      });
    }
  }

  return results;
}

// Determine winning variant based on reply rate
export function getWinningVariant(variants: { replyRate: number; stepId: string }[]) {
  if (variants.length === 0) return null;
  return variants.reduce((best, v) =>
    parseFloat(v.replyRate as any) > parseFloat(best.replyRate as any) ? v : best
  );
}
