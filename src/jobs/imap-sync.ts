import { createWorker, connection } from "../lib/queue.js";
import prisma from "../lib/db.js";
import { ImapFlow } from "imapflow";
import { processAutomation } from "../utils/automation-engine.js";
import { classifyReply } from "../utils/ai-reply-agent.js";
import { decryptApiKey } from "../utils/encryption.js";
import { getFreshToken } from "./email-sender.js";
import { simpleParser } from "mailparser";

const imapSyncWorker = createWorker("imap-sync", async (job) => {
  const { accountId } = job.data;

  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new Error(`Account ${accountId} not found`);
  if (!account.imapHost || !account.imapUser) {
    return { skipped: true, reason: "no_imap" };
  }

  console.log(`[IMAP] Connecting to ${account.imapHost} for ${account.email}...`);

  // Get lastUid from Redis
  const lastUidKey = `imap_last_uid_${accountId}`;
  const lastUidStr = await connection.get(lastUidKey);
  const lastUid = lastUidStr ? parseInt(lastUidStr) : 0;

  // Build auth config
  const isOAuth = account.provider === "google_oauth" || account.provider === "microsoft_oauth";
  let authConfig: any;

  if (isOAuth) {
    const accessToken = await getFreshToken(account);
    authConfig = { user: account.imapUser, accessToken };
  } else {
    authConfig = { user: account.imapUser, pass: account.imapPass || "" };
  }

  // FIX: Get Groq key from workspace integration with env fallback
  const groqIntegration = await prisma.integrationConfig.findFirst({
    where: { workspaceId: account.workspaceId, provider: "groq" },
  });
  const groqKey = groqIntegration?.apiKey ? decryptApiKey(groqIntegration.apiKey) : (process.env.GROQ_API_KEY || null);

  const client = new ImapFlow({
    host: account.imapHost, port: account.imapPort || 993,
    secure: account.imapSecure ?? true,
    auth: authConfig, logger: false,
  });

  let lock;
  let maxSeenUid = lastUid;

  try {
    await client.connect();
    lock = await client.getMailboxLock("INBOX");

    const messages: any[] = [];
    for await (const message of client.fetch({ uid: `${lastUid + 1}:*` }, {
      uid: true, envelope: true, source: true, flags: true,
    })) {
      messages.push(message);
      if (message.uid > maxSeenUid) maxSeenUid = message.uid;
    }

    let repliesFound = 0;
    let bouncesFound = 0;

    for (const msg of messages) {
      const from = msg.envelope?.from?.[0]?.address || "";
      const subject = msg.envelope?.subject || "";

      const isBounce =
        from.toLowerCase().includes("mailer-daemon") ||
        from.toLowerCase().includes("postmaster") ||
        subject.toLowerCase().includes("delivery failed") ||
        subject.toLowerCase().includes("failure notice");

      if (isBounce) {
        const bodyText = msg.source?.toString() || "";
        const match = bodyText.match(/(?:final-recipient|rfc822);\s*(?:DNS;?\s*)?<?([^\s>]+@[^>\s]+)>?/i);
        const bouncedEmail = match?.[1] || from;

        const sentEmail = await prisma.sentEmail.findFirst({ where: { recipientEmail: bouncedEmail, accountId }, orderBy: { sentAt: "desc" } });
        if (sentEmail && sentEmail.status !== "BOUNCED") {
          await prisma.sentEmail.update({ where: { id: sentEmail.id }, data: { status: "BOUNCED", bouncedAt: new Date() } });
          if (sentEmail.campaignLeadId) {
            const cl = await prisma.campaignLead.findUnique({ where: { id: sentEmail.campaignLeadId }, select: { id: true, leadId: true } });
            if (cl) {
              await prisma.lead.update({ where: { id: cl.leadId }, data: { status: "BOUNCED" } });
              await prisma.campaignLead.update({ where: { id: cl.id }, data: { exitedAt: new Date(), exitReason: "bounced" } });
              processAutomation("bounce_received", { leadId: cl.leadId, campaignId: sentEmail.campaignId }).catch(console.error);
            }
          }
          bouncesFound++;
        }
      } else {
        let parsedMail: any = null;
        try {
          if (msg.source) {
            parsedMail = await simpleParser(msg.source);
          }
        } catch (err) {
          console.error(`[IMAP] Failed to parse email from ${from}`, err);
        }

        const sentEmail = await prisma.sentEmail.findFirst({
          where: { recipientEmail: from, accountId, status: { in: ["SENT", "DELIVERED", "OPENED", "CLICKED"] } },
          orderBy: { sentAt: "desc" },
        });

        // Save every non-bounce incoming email
        await prisma.incomingEmail.create({
          data: {
            accountId: account.id,
            fromEmail: from,
            toEmail: msg.envelope?.to?.[0]?.address || account.email,
            subject: subject,
            textBody: parsedMail?.text || "",
            htmlBody: parsedMail?.html || "",
            campaignLeadId: sentEmail?.campaignLeadId || null,
            receivedAt: msg.envelope?.date || new Date(),
          }
        });

        if (sentEmail) {
          await prisma.sentEmail.update({ where: { id: sentEmail.id }, data: { status: "REPLIED", repliedAt: new Date() } });
          if (sentEmail.campaignLeadId) {
            const cl = await prisma.campaignLead.findUnique({ where: { id: sentEmail.campaignLeadId }, include: { lead: true } });
            if (cl) {
              await prisma.lead.update({ where: { id: cl.leadId }, data: { status: "REPLIED" } });
              await prisma.activity.create({ data: { type: "REPLY_RECEIVED", content: `Replied: "${subject}"`, leadId: cl.leadId } });

              // FIX: Use Groq key from workspace integration
              const classification = await classifyReply(subject + " " + (msg.source?.toString() || ""), groqKey || undefined);
              processAutomation("reply_received", { leadId: cl.leadId, campaignId: sentEmail.campaignId, replyLabel: classification.label }).catch(console.error);

              if (sentEmail.campaignId) {
                const campaign = await prisma.campaign.findUnique({ where: { id: sentEmail.campaignId } });
                if (campaign?.stopCondition === "REPLY") {
                  await prisma.campaignLead.update({ where: { id: cl.id }, data: { exitedAt: new Date(), exitReason: "replied" } });
                }
              }
            }
          }
          repliesFound++;
        }
      }

      try { await client.messageFlagsAdd(msg.uid.toString(), ["\\Seen"]); } catch {}
    }

    lock.release();
    await client.logout();

    // Save lastUid to Redis
    if (maxSeenUid > lastUid) {
      await connection.set(lastUidKey, maxSeenUid.toString());
    }

    console.log(`[IMAP] ${account.email}: ${repliesFound} replies, ${bouncesFound} bounces`);
    return { accountEmail: account.email, repliesFound, bouncesFound, totalProcessed: messages.length };
  } catch (error: any) {
    if (lock) lock.release();
    try { await client.logout(); } catch {}
    console.error(`[IMAP] ${account.email}: Error:`, error.message);
    throw error;
  }
});

export default imapSyncWorker;
