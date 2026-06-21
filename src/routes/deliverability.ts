import { FastifyInstance } from "fastify";
import prisma from "../lib/db.js";
import { getOrCreateDefaultWorkspace } from "../lib/workspace.js";
import { getDomainDNSReport, checkBlacklists } from "../utils/dns-checker.js";
import { buildTransporter, getFreshToken } from "../jobs/email-sender.js";
import { ImapFlow } from "imapflow";

export async function deliverabilityRoutes(app: FastifyInstance) {

  // DNS check for a domain
  app.get("/dns/check/:domain", async (request) => {
    const { domain } = request.params as { domain: string };
    const report = await getDomainDNSReport(domain);
    return report;
  });

  // Blacklist check for a domain
  app.get("/dns/blacklist/:domain", async (request) => {
    const { domain } = request.params as { domain: string };
    const results = await checkBlacklists(domain);
    const listed = results.filter((r) => r.listed);
    return { domain, total: results.length, listed: listed.length, results };
  });

  // Get deliverability scores for all accounts
  app.get("/deliverability/scores", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    const accounts = await prisma.emailAccount.findMany({
      where: { workspaceId: workspace.id },
      select: {
        id: true, label: true, email: true, provider: true,
        deliverabilityScore: true, spfStatus: true, dkimStatus: true, dmarcStatus: true,
        warmupEnabled: true, warmupCurrentDay: true, status: true,
      },
    });

    // Enrich with DNS checks for each unique domain
    const domains = [...new Set(accounts.map((a) => a.email.split("@")[1]))];
    const dnsReports: Record<string, any> = {};

    for (const domain of domains) {
      try {
        dnsReports[domain] = await getDomainDNSReport(domain);
      } catch {
        dnsReports[domain] = { domain, overallScore: 0, spf: { status: "FAIL" }, dkim: { status: "FAIL" }, dmarc: { status: "FAIL" } };
      }
    }

    return accounts.map((a) => {
      const domain = a.email.split("@")[1];
      const dns = dnsReports[domain];
      return {
        ...a,
        domain,
        dnsScore: dns?.overallScore || 0,
        spf: dns?.spf?.status || "UNKNOWN",
        dkim: dns?.dkim?.status || "UNKNOWN",
        dmarc: dns?.dmarc?.status || "UNKNOWN",
      };
    });
  });

  // Inbox placement test
  app.post("/inbox-placement/test", async (request) => {
    const { accountId, subject, body, seedEmails } = request.body as {
      accountId: string; subject: string; body: string; seedEmails: string[];
    };

    const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
    if (!account) return { error: "Account not found" };

    const transporter = await buildTransporter(account);

    const results: { email: string; sent: boolean; error?: string }[] = [];

    for (const seedEmail of seedEmails) {
      try {
        await transporter.sendMail({
          from: account.email,
          to: seedEmail,
          subject: `[Placement Test] ${subject}`,
          html: body.replace("</body>", `<br><br><small>Placement test from ${account.email} at ${new Date().toISOString()}</small></body>`),
        });
        results.push({ email: seedEmail, sent: true });
      } catch (err: any) {
        results.push({ email: seedEmail, sent: false, error: err.message });
      }
    }

    // Wait 30 seconds then check IMAP placement
    return {
      testId: `test-${Date.now()}`,
      sent: results.filter((r) => r.sent).length,
      failed: results.filter((r) => !r.sent).length,
      results,
      message: "Test emails sent. Check placement after 30-60 seconds.",
    };
  });

  // Check inbox placement for sent test emails
  app.post("/inbox-placement/check", async (request) => {
    const { accountId, seedEmails } = request.body as { accountId: string; seedEmails: string[] };

    const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
    if (!account) return { error: "Account not found" };
    if (!account.imapHost || !account.imapUser) {
      return { error: "IMAP not configured for this account" };
    }

    // FIX: Support OAuth accounts
    const isOAuth = account.provider === "google_oauth" || account.provider === "microsoft_oauth";
    let authConfig: any;
    if (isOAuth) {
      const accessToken = await getFreshToken(account);
      authConfig = { user: account.imapUser, accessToken };
    } else {
      authConfig = { user: account.imapUser, pass: account.imapPass || "" };
    }

    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort || 993,
      secure: account.imapSecure ?? true,
      auth: authConfig,
      logger: false,
    });

    const placements: { folder: string; count: number; emails: string[] }[] = [];

    try {
      await client.connect();

      // Check common folders
      const folders = ["INBOX", "Junk", "Spam", "Promotions", "Social", "Updates"];

      for (const folder of folders) {
        try {
          const lock = await client.getMailboxLock(folder);
          let count = 0;
          const emails: string[] = [];

          const unseenSequenceNumbers = await client.search({ seen: false });
          if (unseenSequenceNumbers && unseenSequenceNumbers.length > 0) {
            for await (const msg of client.fetch(unseenSequenceNumbers, { envelope: true })) {
              const subject = msg.envelope?.subject || "";
              if (subject.includes("[Placement Test]")) {
                count++;
                emails.push(msg.envelope?.from?.[0]?.address || "unknown");
              }
            }
          }

          if (count > 0) {
            placements.push({ folder, count, emails });
          }

          lock.release();
        } catch {}
      }

      await client.logout();
    } catch (err: any) {
      try { await client.logout(); } catch {}
      return { error: `IMAP connection failed: ${err.message}` };
    }

    const total = placements.reduce((sum, p) => sum + p.count, 0);
    const inboxCount = placements.find((p) => p.folder === "INBOX")?.count || 0;
    const spamCount = placements.find((p) => ["Junk", "Spam"].includes(p.folder))?.count || 0;
    const promoCount = placements.find((p) => ["Promotions", "Social", "Updates"].includes(p.folder))?.count || 0;

    return {
      total,
      inboxRate: total > 0 ? ((inboxCount / total) * 100).toFixed(1) : "0",
      spamRate: total > 0 ? ((spamCount / total) * 100).toFixed(1) : "0",
      promotionsRate: total > 0 ? ((promoCount / total) * 100).toFixed(1) : "0",
      placements,
    };
  });

  // Domain setup checklist
  app.get("/domains/:domain/checklist", async (request) => {
    const { domain } = request.params as { domain: string };
    const dns = await getDomainDNSReport(domain);
    const blacklists = await checkBlacklists(domain);

    const checklist = [
      { step: "Purchase Domain", status: "completed", details: "Domain exists" },
      { step: "SPF Record", status: dns.spf.status === "PASS" ? "completed" : dns.spf.status === "WARN" ? "warning" : "pending", details: dns.spf.details, fix: dns.spf.fixInstructions },
      { step: "DKIM Record", status: dns.dkim.status === "PASS" ? "completed" : dns.dkim.status === "WARN" ? "warning" : "pending", details: dns.dkim.details, fix: dns.dkim.fixInstructions },
      { step: "DMARC Record", status: dns.dmarc.status === "PASS" ? "completed" : dns.dmarc.status === "WARN" ? "warning" : "pending", details: dns.dmarc.details, fix: dns.dmarc.fixInstructions },
      { step: "MX Records", status: dns.mx.status === "PASS" ? "completed" : "warning", details: dns.mx.details },
      { step: "Blacklist Check", status: blacklists.some((b) => b.listed) ? "pending" : "completed", details: blacklists.some((b) => b.listed) ? `LISTED on ${blacklists.filter((b) => b.listed).map((b) => b.blacklist).join(", ")}` : "Not on any blacklists" },
    ];

    return { domain, overallScore: dns.overallScore, checklist, dns };
  });

  // Lookalike domain suggestions
  app.get("/domains/:domain/suggestions", async (request) => {
    const { domain } = request.params as { domain: string };
    const parts = domain.split(".");
    const name = parts[0];
    const tld = parts.slice(1).join(".");

    const prefixes = ["get", "try", "use", "go", "start", "join", "meet", "talk", "hello", "hey", "app", "my", "the"];
    const suffixes = ["hq", "io", "hub", "lab", "team", "co", "dev", "app", "pro", "now", "fast", "ai", "direct", "mail"];
    const variations = ["", "-", "hq", "mail", "send", "outreach", "contact", "connect"];

    const suggestions: string[] = [];

    for (const prefix of prefixes) {
      suggestions.push(`${prefix}${name}.${tld}`);
    }
    for (const suffix of suffixes) {
      suggestions.push(`${name}${suffix}.${tld}`);
    }
    for (const variation of variations) {
      if (variation) {
        suggestions.push(`${name}${variation}.${tld}`);
        suggestions.push(`${variation}-${name}.${tld}`);
      }
    }

    // Check which ones are available (DNS check)
    const available: string[] = [];
    for (const suggestion of suggestions.slice(0, 20)) {
      try {
        const { resolve4 } = await import("dns");
        const resolver = new (await import("dns")).Resolver();
        resolver.setServers(["8.8.8.8"]);
        await new Promise<void>((resolve, reject) => {
          resolver.resolve4(suggestion, (err: any) => err ? resolve() : reject());
        });
      } catch {
        // Domain doesn't resolve = likely available
        available.push(suggestion);
      }
    }

    return { domain, suggestions: available.slice(0, 10) };
  });
}
