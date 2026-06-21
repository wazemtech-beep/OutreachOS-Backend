interface ReplyAgentInput {
  emailContent: string;
  leadEmail: string;
  leadName?: string;
  leadCompany?: string;
  campaignName?: string;
  knowledgeBase: string;
  apiKey?: string;
  mode: "autopilot" | "suggest";
}

export async function classifyReply(emailContent: string, apiKey?: string): Promise<{ label: string; confidence: number }> {
  return fallbackClassify(emailContent);
}

export async function generateReply(input: ReplyAgentInput): Promise<{
  label: string; confidence: number; reply?: string; action?: string;
}> {
  const classification = await classifyReply(input.emailContent, input.apiKey);

  if (["not_interested", "unsubscribe"].includes(classification.label)) {
    return { label: classification.label, confidence: classification.confidence, action: "mark_only" };
  }

  if (classification.label === "out_of_office") {
    return { label: "out_of_office", confidence: classification.confidence, action: "schedule_followup" };
  }

  return { label: classification.label, confidence: classification.confidence, reply: fallbackReply(input), action: "send_or_draft" };
}

export async function autoProcessReplies(campaignId: string, apiKey?: string) {
  const prisma = (await import("../lib/db.js")).default;
  const unreplied = await prisma.sentEmail.findMany({
    where: { campaignId, status: "REPLIED", repliedAt: { not: null } },
    include: { campaignLead: { include: { lead: true } } },
    take: 50,
  });

  const results: any[] = [];
  for (const email of unreplied) {
    const lead = email.campaignLead?.lead;
    if (!lead) continue;
    const result = await generateReply({
      emailContent: email.body || "",
      leadEmail: lead.email,
      leadName: [lead.firstName, lead.lastName].filter(Boolean).join(" "),
      leadCompany: lead.companyName || undefined,
      knowledgeBase: "Our product/service",
      apiKey,
      mode: "suggest",
    });
    results.push({ emailId: email.id, leadEmail: lead.email, ...result });
  }
  return results;
}

function fallbackClassify(content: string): { label: string; confidence: number } {
  const lower = content.toLowerCase();
  if (lower.includes("unsubscribe") || lower.includes("remove me")) return { label: "unsubscribe", confidence: 0.9 };
  if (lower.includes("not interested") || lower.includes("no thank")) return { label: "not_interested", confidence: 0.8 };
  if (lower.includes("out of office") || lower.includes("vacation") || lower.includes("auto-reply")) return { label: "out_of_office", confidence: 0.95 };
  if (lower.includes("wrong person")) return { label: "wrong_person", confidence: 0.7 };
  if (lower.includes("schedule") || lower.includes("meeting") || lower.includes("call")) return { label: "interested", confidence: 0.8 };
  if (lower.includes("?")) return { label: "question", confidence: 0.6 };
  return { label: "question", confidence: 0.4 };
}

function fallbackReply(input: ReplyAgentInput): string {
  const name = input.leadName || "there";
  const company = input.leadCompany || "your company";
  return `Hey ${name}, thanks for getting back to me! I'd love to learn more about what ${company} is working on. Would you be open to a quick 10-minute call this week?`;
}
