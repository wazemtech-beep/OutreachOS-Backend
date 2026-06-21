// Spintax parser: {Hey|Hi|Hello} → randomly picks one word
// Supports nested braces and multiple options
export function parseSpintax(text: string): string {
  return text.replace(/\{([^{}]+)\}/g, (match, group) => {
    const options = group.split("|");
    const chosen = options[Math.floor(Math.random() * options.length)];
    return parseSpintax(chosen);
  });
}

// Personalization variables map
export function replaceVariables(
  text: string,
  lead: Record<string, any>,
  sender: { name?: string; email?: string } = {}
): string {
  const vars: Record<string, string> = {
    first_name: lead.firstName || "there",
    last_name: lead.lastName || "",
    full_name: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "there",
    email: lead.email || "",
    company: lead.companyName || "your company",
    job_title: lead.jobTitle || "",
    phone: lead.phone || "",
    website: lead.website || "",
    city: lead.city || "",
    country: lead.country || "",
    industry: lead.industry || "",
    sender_name: sender.name || "there",
    sender_email: sender.email || "",
    sender_first_name: (sender.name || "").split(" ")[0] || "",
    sender_last_name: (sender.name || "").split(" ").slice(1).join(" ") || "",
    current_date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    unsubscribe_link: "{{unsubscribe_link}}",
  };

  // Merge custom fields
  if (lead.customFields && typeof lead.customFields === "object") {
    for (const [key, value] of Object.entries(lead.customFields)) {
      vars[key] = String(value || "");
    }
  }

  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    result = result.replace(regex, value);
  }

  return result;
}

// Process text: first parse spintax, then replace variables
export function processEmailText(
  text: string,
  lead: Record<string, any>,
  sender?: { name?: string; email?: string }
): string {
  const withVars = replaceVariables(text, lead, sender);
  return parseSpintax(withVars);
}

// Generate fallback text: if variable is empty, use fallback
// e.g., {{first_name|there}} → if first_name empty, use "there"
export function processWithFallbacks(text: string, lead: Record<string, any>): string {
  return text.replace(/\{\{(\w+)(?:\|([^}]+))?\}\}/g, (match, key, fallback) => {
    const value = lead[key] || lead.firstName || "";
    if (value) return value;
    return fallback || "there";
  });
}

// Preview: show what the email will look like for a specific lead
export function previewEmail(
  subject: string,
  body: string,
  lead: Record<string, any>,
  sender?: { name?: string; email?: string }
): { subject: string; body: string } {
  return {
    subject: processEmailText(subject, lead, sender),
    body: processEmailText(body, lead, sender),
  };
}
