// Execute a webhook with lead data as payload
export async function executeWebhook(
  url: string,
  payload: Record<string, any>,
  timeoutMs: number = 10000
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "OutreachOS-Webhook/1.0",
      },
      body: JSON.stringify({
        event: payload.event || "webhook.triggered",
        timestamp: new Date().toISOString(),
        data: payload,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    return {
      success: response.ok,
      statusCode: response.status,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.name === "AbortError" ? "Timeout" : err.message,
    };
  }
}

// Build payload for different step types
export function buildWebhookPayload(
  stepType: string,
  lead: Record<string, any>,
  campaign: Record<string, any>,
  step: Record<string, any>,
  extra?: Record<string, any>
): Record<string, any> {
  return {
    event: `${stepType.toLowerCase()}.triggered`,
    lead: {
      id: lead.id,
      email: lead.email,
      firstName: lead.firstName,
      lastName: lead.lastName,
      company: lead.companyName,
      jobTitle: lead.jobTitle,
      linkedinUrl: lead.linkedinUrl,
      phone: lead.phone,
      status: lead.status,
    },
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
    },
    step: {
      id: step.id,
      order: step.order,
      type: step.type,
    },
    ...extra,
  };
}
