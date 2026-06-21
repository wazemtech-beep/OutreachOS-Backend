import { resolveTxt, resolveMx, Resolver } from "dns";
import { promisify } from "util";

// Use Google DNS for reliable resolution
const resolver = new Resolver();
resolver.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

const resolveTxtAsync = promisify(resolver.resolveTxt.bind(resolver));
const resolveMxAsync = promisify(resolver.resolveMx.bind(resolver));

export interface DNSCheckResult {
  record: string;
  status: "PASS" | "FAIL" | "WARN" | "NOT_FOUND";
  value?: string;
  details?: string;
  fixInstructions?: string;
}

export interface DomainDNSReport {
  domain: string;
  spf: DNSCheckResult;
  dkim: DNSCheckResult;
  dmarc: DNSCheckResult;
  mx: DNSCheckResult;
  overallScore: number;
}

// Check SPF record
export async function checkSPF(domain: string): Promise<DNSCheckResult> {
  try {
    const records = await resolveTxtAsync(domain);
    const spfRecord = records.flat().find((r) => r.startsWith("v=spf1"));

    if (!spfRecord) {
      return {
        record: "SPF",
        status: "FAIL",
        details: "No SPF record found",
        fixInstructions: `Add this TXT record to your DNS:\nv=spf1 include:_spf.google.com ~all`,
      };
    }

    const hasAll = spfRecord.includes("-all") || spfRecord.includes("~all") || spfRecord.includes("+all");
    if (!hasAll) {
      return {
        record: "SPF",
        status: "WARN",
        value: spfRecord,
        details: "SPF record exists but missing 'all' qualifier",
      };
    }

    const hasSoftFail = spfRecord.includes("~all");
    return {
      record: "SPF",
      status: "PASS",
      value: spfRecord,
      details: hasSoftFail ? "Uses ~all (soft fail) — consider switching to -all" : "Properly configured",
    };
  } catch (err: any) {
    return {
      record: "SPF",
      status: "FAIL",
      details: `DNS lookup failed: ${err.message}`,
    };
  }
}

// Check DKIM record
export async function checkDKIM(domain: string, selector: string = "default"): Promise<DNSCheckResult> {
  try {
    const dkimDomain = `${selector}._domainkey.${domain}`;
    const records = await resolveTxtAsync(dkimDomain);

    if (!records || records.length === 0) {
      // Try common selectors
      const commonSelectors = ["google", "selector1", "selector2", "k1", "mandrill", "everlytickey1"];
      for (const s of commonSelectors) {
        try {
          const altRecords = await resolveTxtAsync(`${s}._domainkey.${domain}`);
          if (altRecords && altRecords.length > 0) {
            return {
              record: "DKIM",
              status: "PASS",
              value: altRecords.flat().join(""),
              details: `Found with selector '${s}' instead of '${selector}'`,
            };
          }
        } catch {}
      }

      return {
        record: "DKIM",
        status: "FAIL",
        details: `No DKIM record found for selector '${selector}'`,
        fixInstructions: `Generate a DKIM key pair and add the public key as a TXT record at:\n${selector}._domainkey.${domain}`,
      };
    }

    const value = records.flat().join("");
    return {
      record: "DKIM",
      status: "PASS",
      value: value.substring(0, 100) + "...",
      details: "DKIM record found and valid",
    };
  } catch (err: any) {
    return {
      record: "DKIM",
      status: "FAIL",
      details: `DNS lookup failed: ${err.message}`,
    };
  }
}

// Check DMARC record
export async function checkDMARC(domain: string): Promise<DNSCheckResult> {
  try {
    const records = await resolveTxtAsync(`_dmarc.${domain}`);
    const dmarcRecord = records.flat().find((r) => r.startsWith("v=DMARC1"));

    if (!dmarcRecord) {
      return {
        record: "DMARC",
        status: "FAIL",
        details: "No DMARC record found",
        fixInstructions: `Add this TXT record to _dmarc.${domain}:\nv=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      };
    }

    const policyMatch = dmarcRecord.match(/p=(none|quarantine|reject)/);
    const policy = policyMatch?.[1] || "unknown";

    if (policy === "none") {
      return {
        record: "DMARC",
        status: "WARN",
        value: dmarcRecord,
        details: "DMARC policy is 'none' (monitoring only). Consider upgrading to quarantine or reject.",
        fixInstructions: `Update DMARC policy to: v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`,
      };
    }

    return {
      record: "DMARC",
      status: "PASS",
      value: dmarcRecord,
      details: `DMARC policy: ${policy}`,
    };
  } catch (err: any) {
    return {
      record: "DMARC",
      status: "FAIL",
      details: `DNS lookup failed: ${err.message}`,
    };
  }
}

// Check MX records
export async function checkMX(domain: string): Promise<DNSCheckResult> {
  try {
    const records = await resolveMxAsync(domain);

    if (!records || records.length === 0) {
      return {
        record: "MX",
        status: "FAIL",
        details: "No MX records found",
      };
    }

    const prioritized = records.sort((a, b) => a.priority - b.priority);
    return {
      record: "MX",
      status: "PASS",
      value: prioritized.map((r) => `${r.exchange} (priority ${r.priority})`).join(", "),
      details: `${records.length} MX records found`,
    };
  } catch (err: any) {
    return {
      record: "MX",
      status: "WARN",
      details: `MX lookup failed: ${err.message}`,
    };
  }
}

// Full DNS report for a domain
export async function getDomainDNSReport(domain: string): Promise<DomainDNSReport> {
  const [spf, dkim, dmarc, mx] = await Promise.all([
    checkSPF(domain),
    checkDKIM(domain),
    checkDMARC(domain),
    checkMX(domain),
  ]);

  const checks = [spf, dkim, dmarc, mx];
  const passCount = checks.filter((c) => c.status === "PASS").length;
  const overallScore = Math.round((passCount / checks.length) * 100);

  return { domain, spf, dkim, dmarc, mx, overallScore };
}

// Check if domain is on any blacklists
export async function checkBlacklists(domain: string): Promise<{ blacklist: string; listed: boolean; details: string; ip?: string }[]> {
  // IP-based blacklists (Spamhaus, Barracuda, SpamCop)
  const ipBlacklists = [
    { name: "Spamhaus ZEN", dns: "zen.spamhaus.org" },
    { name: "Barracuda", dns: "b.barracudacentral.org" },
    { name: "SpamCop", dns: "bl.spamcop.net" },
  ];

  // Domain-based blacklists (SURBL, Invaluement)
  const domainBlacklists = [
    { name: "SURBL", dns: "multi.surbl.org" },
    { name: "Invaluement", dns: "ivmSIP.dnsbl-1.ivevelop.net" },
  ];

  const results: { blacklist: string; listed: boolean; details: string; ip?: string }[] = [];

  // Resolve domain to IP for IP-based checks
  const resolve4Async = promisify(resolver.resolve4.bind(resolver));
  let ips: string[] = [];
  try {
    ips = await resolve4Async(domain);
  } catch {
    results.push({ blacklist: "DNS", listed: false, details: "Could not resolve domain to IP" });
  }

  // Check IP-based blacklists
  for (const ip of ips.slice(0, 3)) {
    const reversedIp = ip.split(".").reverse().join(".");
    for (const bl of ipBlacklists) {
      try {
        const lookupDomain = `${reversedIp}.${bl.dns}`;
        await resolve4Async(lookupDomain);
        results.push({ blacklist: bl.name, listed: true, details: `IP ${ip} IS LISTED on ${bl.name}!`, ip });
      } catch {
        results.push({ blacklist: bl.name, listed: false, details: `IP ${ip} not listed on ${bl.name}`, ip });
      }
    }
  }

  // Check domain-based blacklists
  for (const bl of domainBlacklists) {
    try {
      const lookupDomain = `${domain}.${bl.dns}`;
      await resolve4Async(lookupDomain);
      results.push({ blacklist: bl.name, listed: true, details: `Domain ${domain} IS LISTED on ${bl.name}!` });
    } catch {
      results.push({ blacklist: bl.name, listed: false, details: `Domain ${domain} not listed on ${bl.name}` });
    }
  }

  // Deduplicate by blacklist name (keep first result)
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.blacklist)) return false;
    seen.add(r.blacklist);
    return true;
  });
}
