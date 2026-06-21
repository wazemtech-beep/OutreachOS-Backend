import { createWorker } from "../lib/queue.js";
import prisma from "../lib/db.js";
import { buildTransporter } from "./email-sender.js";

const warmupTemplates = [
  "Hey, just wanted to check in on the project. Let me know if you need anything.",
  "Hi! Hope you're doing well. Quick question about the upcoming meeting.",
  "Hello, I wanted to follow up on our last conversation. Any updates?",
  "Hey there! Just circling back on the proposal we discussed.",
  "Hi! Hope your week is going great. Just a quick note to stay in touch.",
  "Hello! Wanted to share some thoughts on the latest developments.",
  "Hey! Checking in to see how things are progressing on your end.",
  "Hi there! Hope all is well. Let me know if you have any questions.",
  "Hello! Just wanted to touch base regarding our previous discussion.",
  "Hey! Hope you had a great weekend. Looking forward to catching up.",
  "Hi! Quick follow-up on the email I sent last week.",
  "Hello! Just a friendly reminder about our upcoming deadline.",
  "Hey there! I saw some interesting news about your industry.",
  "Hi! Wanted to share an article that might be relevant to you.",
  "Hello! Hope everything is running smoothly. Let me know if I can help.",
];

const warmupWorker = createWorker("warmup", async (job) => {
  const { accountId } = job.data;

  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account || !account.warmupEnabled) return { skipped: true };

  const warmupAccounts = await prisma.emailAccount.findMany({
    where: {
      warmupEnabled: true,
      id: { not: accountId },
      status: "CONNECTED",
    },
  });

  if (warmupAccounts.length === 0) {
    console.log(`[WARMUP] No warmup partners found for ${account.email}`);
    return { skipped: true, reason: "no_partners" };
  }

  const day = account.warmupCurrentDay + 1;
  const emailsToSend = Math.min(day * 2, account.warmupMaxDaily);
  const sentToday: string[] = [];

  const transporter = await buildTransporter(account);

  for (let i = 0; i < emailsToSend; i++) {
    const partner = warmupAccounts[Math.floor(Math.random() * warmupAccounts.length)];
    const template = warmupTemplates[Math.floor(Math.random() * warmupTemplates.length)];
    const subject = `Re: ${template.substring(0, 40)}...`;

    try {
      await transporter.sendMail({
        from: account.email,
        to: partner.email,
        subject,
        text: template,
      });

      await prisma.warmupEmail.create({
        data: {
          accountId,
          recipientAccountId: partner.id,
        },
      });

      sentToday.push(partner.email);
    } catch (error: any) {
      console.error(`[WARMUP] Failed to send warmup email:`, error.message);
    }
  }

  await prisma.emailAccount.update({
    where: { id: accountId },
    data: { warmupCurrentDay: day },
  });

  console.log(`[WARMUP] Account ${account.email}: Day ${day}, sent ${sentToday.length} warmup emails`);
  return { day, sent: sentToday.length, emails: sentToday };
});

warmupWorker.on("completed", (job) => {
  console.log(`[WARMUP] Job ${job.id} completed`);
});

export default warmupWorker;
