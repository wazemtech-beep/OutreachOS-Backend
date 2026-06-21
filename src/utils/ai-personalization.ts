interface AIPersonalizationInput {
  leadEmail: string;
  leadFirstName?: string;
  leadLastName?: string;
  leadCompany?: string;
  leadJobTitle?: string;
  leadIndustry?: string;
  leadLinkedinUrl?: string;
  leadWebsite?: string;
  businessDescription: string;
  tone?: string;
}

export async function generatePersonalizedOpeningLine(
  input: AIPersonalizationInput,
  apiKey?: string
): Promise<{ openingLine: string }> {
  return { openingLine: fallbackOpeningLine(input) };
}

export async function generateSubjectVariants(
  baseSubject: string,
  count: number,
  apiKey?: string
): Promise<string[]> {
  return Array.from({ length: count }, (_, i) => `${baseSubject} (v${i + 1})`);
}

function fallbackOpeningLine(input: AIPersonalizationInput): string {
  const name = input.leadFirstName || "there";
  const company = input.leadCompany || "your company";
  const templates = [
    `Hey ${name}, I noticed ${company} is doing interesting work in the ${input.leadIndustry || "tech"} space.`,
    `Hi ${name}, came across ${company} while researching ${input.leadIndustry || "the industry"} and had a quick thought.`,
    `Hey ${name}, I've been following ${company}'s growth and wanted to reach out.`,
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}
