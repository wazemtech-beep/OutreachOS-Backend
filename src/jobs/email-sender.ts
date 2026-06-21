import { createWorker } from "../lib/queue.js";
import prisma from "../lib/db.js";
import nodemailer from "nodemailer";
import { processAutomation } from "../utils/automation-engine.js";
import { decryptApiKey } from "../utils/encryption.js";

async function refreshGoogleToken(refreshToken: string, clientId: string, clientSecret: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
  });
  return res.json();
}

async function refreshMicrosoftToken(refreshToken: string, clientId: string, clientSecret: string, tenantId?: string) {
  const url = tenantId ? `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token` : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token", scope: "https://outlook.office365.com/SMTP.Send offline_access" }).toString(),
  });
  return res.json();
}

// Exported helper: get a fresh (possibly refreshed) access token for an OAuth account
export async function getFreshToken(account: any): Promise<string | null> {
  const isOAuth = account.provider === "google_oauth" || account.provider === "microsoft_oauth";
  if (!isOAuth || !account.oauthToken) return null;

  const oauthToken = account.oauthToken as any;
  let accessToken = oauthToken.accessToken;
  const refreshToken = oauthToken.refreshToken;
  const provider = account.provider === "google_oauth" ? "google_oauth" : "microsoft_oauth";

  const integrations = await prisma.integrationConfig.findMany({ where: { provider: { contains: "_oauth" } } });
  const config = integrations.find((i) => i.provider === provider);
  const meta = (config?.metadata as any) || {};

  // Refresh if expired or expiring in 5 minutes
  if (oauthToken.expiresAt && Date.now() > oauthToken.expiresAt - 5 * 60 * 1000) {
    console.log(`[TOKEN] Refreshing for ${account.email}...`);
    if (config && refreshToken) {
      try {
        const tokenData = account.provider === "google_oauth"
          ? await refreshGoogleToken(refreshToken, decryptApiKey(config.apiKey), decryptApiKey(meta.clientSecret))
          : await refreshMicrosoftToken(refreshToken, decryptApiKey(config.apiKey), decryptApiKey(meta.clientSecret), meta.tenantId);

        if (tokenData.access_token) {
          accessToken = tokenData.access_token;
          // Persist refreshed token to database
          await prisma.emailAccount.update({
            where: { id: account.id },
            data: {
              oauthToken: { ...oauthToken, accessToken: tokenData.access_token, expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000 },
              smtpPass: tokenData.access_token,
              imapPass: tokenData.access_token,
            },
          });
          console.log(`[TOKEN] Refreshed for ${account.email}`);
        }
      } catch (err: any) {
        console.error(`[TOKEN] Refresh failed for ${account.email}:`, err.message);
      }
    }
  }

  return accessToken;
}

export async function buildTransporter(account: any) {
  const isOAuth = account.provider === "google_oauth" || account.provider === "microsoft_oauth";

  if (isOAuth) {
    const accessToken = await getFreshToken(account);
    if (accessToken) {
      return nodemailer.createTransport({
        host: account.smtpHost, port: account.smtpPort, secure: account.smtpSecure,
        auth: { type: "OAuth2", user: account.email, accessToken },
      });
    }
  }

  return nodemailer.createTransport({
    host: account.smtpHost, port: account.smtpPort, secure: account.smtpPort === 465,
    auth: { user: account.smtpUser, pass: account.smtpPass },
    tls: { rejectUnauthorized: false }
  });
}

const emailSendWorker = createWorker("email-send", async (job) => {
  const { accountId, campaignId, campaignLeadId, stepId, recipientEmail, subject, body } = job.data;
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new Error(`Account ${accountId} not found`);

  const transporter = await buildTransporter(account);

  try {
    await transporter.sendMail({ from: account.email, to: recipientEmail, subject, html: body });
    await prisma.sentEmail.create({
      data: { recipientEmail, subject, body, status: "SENT", accountId, campaignId: campaignId || undefined, stepId: stepId || undefined, campaignLeadId: campaignLeadId || undefined },
    });
    if (campaignLeadId) {
      const cl = await prisma.campaignLead.findUnique({ where: { id: campaignLeadId }, select: { leadId: true } });
      if (cl) processAutomation("email_sent", { leadId: cl.leadId, campaignId, stepId, recipientEmail }).catch(console.error);
    }
    return { success: true, recipient: recipientEmail };
  } catch (error: any) {
    await prisma.sentEmail.create({
      data: { recipientEmail, subject, body, status: "FAILED", errorMessage: error.message, accountId, campaignId: campaignId || undefined, stepId: stepId || undefined, campaignLeadId: campaignLeadId || undefined },
    });
    throw error;
  }
});

export default emailSendWorker;
