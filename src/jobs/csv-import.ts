import { createWorker } from "../lib/queue.js";
import prisma from "../lib/db.js";
import Papa from "papaparse";

const columnMap: Record<string, string> = {
  email: "email", "e-mail": "email", "email address": "email",
  firstname: "firstName", "first_name": "firstName", "first name": "firstName",
  lastname: "lastName", "last_name": "lastName", "last name": "lastName",
  company: "companyName", "company_name": "companyName", "company name": "companyName", "organization": "companyName",
  title: "jobTitle", "job_title": "jobTitle", "job title": "jobTitle", "position": "jobTitle",
  linkedin: "linkedinUrl", "linkedin_url": "linkedinUrl", "linkedin url": "linkedinUrl", "linkedin profile": "linkedinUrl",
  phone: "phone", "telephone": "phone", "mobile": "phone",
  website: "website", "url": "website", "company website": "website",
  industry: "industry",
  company_size: "companySize", "companysize": "companySize", "company size": "companySize", "employees": "companySize",
  city: "city", "location": "city",
  country: "country",
};

const csvImportWorker = createWorker("csv-import", async (job) => {
  const { listId, csvText } = job.data;

  console.log(`[CSV] Starting import for list ${listId}...`);

  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });

  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    throw new Error(`CSV parse error: ${parsed.errors[0].message}`);
  }

  const leads: any[] = [];
  const errors: any[] = [];

  for (const [i, row] of parsed.data.entries()) {
    const mapped: Record<string, any> = {};
    const customFields: Record<string, string> = {};

    for (const [header, value] of Object.entries(row as Record<string, string>)) {
      if (!value?.trim()) continue;
      const normalized = header.toLowerCase().trim().replace(/\s+/g, "_");
      const field = columnMap[normalized] || columnMap[header.toLowerCase().trim()];
      if (field) {
        mapped[field] = value.trim();
      } else {
        // FIX: Keep unmapped columns as custom fields
        customFields[header.trim()] = value.trim();
      }
    }

    if (!mapped.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mapped.email)) {
      errors.push({ row: i + 2, email: mapped.email || "(missing)", error: "Invalid or missing email" });
      continue;
    }

    if (Object.keys(customFields).length > 0) {
      mapped.customFields = customFields;
    }

    leads.push(mapped);

    // Update progress every 500 rows
    if ((i + 1) % 500 === 0) {
      await job.updateProgress({ processed: i + 1, total: parsed.data.length });
    }
  }

  console.log(`[CSV] Parsed ${leads.length} valid leads, ${errors.length} errors`);

  // Check for existing emails in this list
  const existingEmails = await prisma.lead.findMany({
    where: { leadListId: listId, email: { in: leads.map((l) => l.email) } },
    select: { email: true },
  });
  const existingSet = new Set(existingEmails.map((e) => e.email));
  const newLeads = leads.filter((l) => !existingSet.has(l.email));
  const duplicates = leads.filter((l) => existingSet.has(l.email));

  console.log(`[CSV] ${newLeads.length} new, ${duplicates.length} duplicates`);

  // Batch insert (500 at a time to avoid huge transactions)
  const BATCH_SIZE = 500;
  let inserted = 0;
  for (let i = 0; i < newLeads.length; i += BATCH_SIZE) {
    const batch = newLeads.slice(i, i + BATCH_SIZE);
    await prisma.lead.createMany({
      data: batch.map((l) => ({ ...l, leadListId: listId })),
      skipDuplicates: true,
    });
    inserted += batch.length;
    await job.updateProgress({ processed: parsed.data.length, inserted });
  }

  // Update lead count on the list
  await prisma.leadList.update({
    where: { id: listId },
    data: { leadCount: { increment: inserted } },
  });

  const result = {
    imported: inserted,
    duplicates: duplicates.length,
    errors: errors.length,
    errorDetails: errors.slice(0, 20),
    duplicateEmails: duplicates.slice(0, 20).map((d) => d.email),
  };

  console.log(`[CSV] Import complete: ${inserted} imported, ${duplicates.length} dupes, ${errors.length} errors`);
  return result;
});

csvImportWorker.on("completed", (job) => {
  console.log(`[CSV] Import job ${job.id} completed`);
});

csvImportWorker.on("failed", (job, err) => {
  console.error(`[CSV] Import job ${job?.id} failed:`, err.message);
});

export default csvImportWorker;
