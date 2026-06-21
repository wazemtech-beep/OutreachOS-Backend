import { FastifyInstance } from "fastify";
import prisma from "../lib/db.js";
import { getOrCreateDefaultWorkspace } from "../lib/workspace.js";
import { csvImportQueue, enrichmentQueue, verificationQueue } from "../lib/queue.js";
import { z } from "zod";
import Papa from "papaparse";

const createLeadSchema = z.object({
  email: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  companyName: z.string().optional(),
  jobTitle: z.string().optional(),
  linkedinUrl: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  industry: z.string().optional(),
  companySize: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  customFields: z.record(z.string()).optional(),
});

const createLeadListSchema = z.object({
  name: z.string().min(1),
  tags: z.string().optional(),
});

const querySchema = z.object({
  page: z.coerce.number().default(1),
  limit: z.coerce.number().default(50),
  search: z.string().optional(),
  status: z.string().optional(),
  company: z.string().optional(),
  jobTitle: z.string().optional(),
  country: z.string().optional(),
  industry: z.string().optional(),
});

export async function leadListRoutes(app: FastifyInstance) {

  app.get("/lead-lists", async (request) => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    const lists = await prisma.leadList.findMany({
      where: { workspaceId: workspace.id },
      include: { _count: { select: { leads: true } } },
      orderBy: { createdAt: "desc" },
    });
    return lists;
  });

  app.post("/lead-lists", async (request, reply) => {
    const body = createLeadListSchema.parse(request.body);
    const { workspace } = await getOrCreateDefaultWorkspace();
    const list = await prisma.leadList.create({
      data: { name: body.name, tags: body.tags, workspaceId: workspace.id },
    });
    return reply.status(201).send(list);
  });

  app.put("/lead-lists/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = createLeadListSchema.partial().parse(request.body);
    return prisma.leadList.update({ where: { id }, data: body });
  });

  app.delete("/lead-lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.leadList.delete({ where: { id } });
    return reply.status(204).send();
  });

  app.get("/lead-lists/:listId/leads", async (request) => {
    const { listId } = request.params as { listId: string };
    const query = querySchema.parse(request.query);

    const where: any = { leadListId: listId };
    if (query.search) {
      where.OR = [
        { email: { contains: query.search, mode: "insensitive" } },
        { firstName: { contains: query.search, mode: "insensitive" } },
        { lastName: { contains: query.search, mode: "insensitive" } },
        { companyName: { contains: query.search, mode: "insensitive" } },
      ];
    }
    if (query.status) where.status = query.status;
    if (query.company) where.companyName = { contains: query.company, mode: "insensitive" };
    if (query.jobTitle) where.jobTitle = { contains: query.jobTitle, mode: "insensitive" };
    if (query.country) where.country = { contains: query.country, mode: "insensitive" };
    if (query.industry) where.industry = { contains: query.industry, mode: "insensitive" };

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: { createdAt: "desc" },
        include: { tags: { include: { tag: true } }, deal: true },
      }),
      prisma.lead.count({ where }),
    ]);
    return { leads, total, page: query.page, pages: Math.ceil(total / query.limit) };
  });

  app.get("/leads/search/all", async (request) => {
    const query = querySchema.parse(request.query);
    const { workspace } = await getOrCreateDefaultWorkspace();

    const where: any = { leadList: { workspaceId: workspace.id } };
    if (query.search) {
      where.OR = [
        { email: { contains: query.search, mode: "insensitive" } },
        { firstName: { contains: query.search, mode: "insensitive" } },
        { lastName: { contains: query.search, mode: "insensitive" } },
        { companyName: { contains: query.search, mode: "insensitive" } },
        { jobTitle: { contains: query.search, mode: "insensitive" } },
      ];
    }
    if (query.status) where.status = query.status;
    if (query.company) where.companyName = { contains: query.company, mode: "insensitive" };
    if (query.jobTitle) where.jobTitle = { contains: query.jobTitle, mode: "insensitive" };
    if (query.country) where.country = { contains: query.country, mode: "insensitive" };
    if (query.industry) where.industry = { contains: query.industry, mode: "insensitive" };

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: { createdAt: "desc" },
        include: { tags: { include: { tag: true } }, leadList: { select: { name: true } } },
      }),
      prisma.lead.count({ where }),
    ]);
    return { leads, total, page: query.page, pages: Math.ceil(total / query.limit) };
  });

  app.get("/leads/:id", async (request) => {
    const { id } = request.params as { id: string };
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        tags: { include: { tag: true } },
        activities: { orderBy: { createdAt: "desc" }, take: 50 },
        notes: { orderBy: { createdAt: "desc" } },
        deal: true,
      },
    });
    return lead;
  });

  app.post("/lead-lists/:listId/leads", async (request, reply) => {
    const { listId } = request.params as { listId: string };
    const body = createLeadSchema.parse(request.body);
    const lead = await prisma.lead.create({ data: { ...body, leadListId: listId } });
    await prisma.leadList.update({ where: { id: listId }, data: { leadCount: { increment: 1 } } });
    return reply.status(201).send(lead);
  });

  app.put("/leads/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = createLeadSchema.partial().parse(request.body);
    return prisma.lead.update({ where: { id }, data: body });
  });

  app.delete("/leads/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const lead = await prisma.lead.findUnique({ where: { id }, select: { leadListId: true } });
    await prisma.lead.delete({ where: { id } });
    if (lead) {
      await prisma.leadList.update({ where: { id: lead.leadListId }, data: { leadCount: { decrement: 1 } } });
    }
    return reply.status(204).send();
  });

  // CSV Import — uses queue for large files (>500 rows), inline for small
  app.post("/lead-lists/:listId/import", async (request, reply) => {
    const { listId } = request.params as { listId: string };
    const data = await request.file();
    if (!data) return reply.status(400).send({ error: "No file uploaded" });

    const buffer = await data.toBuffer();
    const csvText = buffer.toString("utf-8");

    // Quick row count check
    const rowEstimate = csvText.split("\n").length - 1;

    if (rowEstimate > 500) {
      // Large file — queue it as background job
      const job = await csvImportQueue.add("import-csv", { listId, csvText }, {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
      });
      return reply.status(202).send({
        queued: true,
        jobId: job.id,
        message: `Large CSV (${rowEstimate} rows) queued for background processing`,
      });
    }

    // Small file — process inline (fast enough)
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    if (parsed.errors.length > 0) {
      return reply.status(400).send({ error: "CSV parse error", details: parsed.errors.slice(0, 5) });
    }

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

    const leads: any[] = [];
    const errors: any[] = [];

    for (const [i, row] of parsed.data.entries()) {
      const mapped: any = {};
      const customFields: Record<string, string> = {};
      for (const [header, value] of Object.entries(row as Record<string, string>)) {
        if (!value?.trim()) continue;
        const normalized = header.toLowerCase().trim().replace(/\s+/g, "_");
        const field = columnMap[normalized] || columnMap[header.toLowerCase().trim()];
        if (field) {
          mapped[field] = value.trim();
        } else {
          customFields[header.trim()] = value.trim();
        }
      }
      if (!mapped.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mapped.email)) {
        errors.push({ row: i + 2, data: row, error: "Invalid or missing email" });
        continue;
      }
      if (Object.keys(customFields).length > 0) {
        mapped.customFields = customFields;
      }
      leads.push(mapped);
    }

    const existingEmails = await prisma.lead.findMany({
      where: { leadListId: listId, email: { in: leads.map((l) => l.email) } },
      select: { email: true },
    });
    const existingSet = new Set(existingEmails.map((e) => e.email));
    const newLeads = leads.filter((l) => !existingSet.has(l.email));
    const duplicates = leads.filter((l) => existingSet.has(l.email));

    if (newLeads.length > 0) {
      await prisma.lead.createMany({
        data: newLeads.map((l) => ({ ...l, leadListId: listId })),
        skipDuplicates: true,
      });
      await prisma.leadList.update({
        where: { id: listId },
        data: { leadCount: { increment: newLeads.length } },
      });
    }

    return {
      imported: newLeads.length,
      duplicates: duplicates.length,
      errors: errors.length,
      errorDetails: errors.slice(0, 10),
      duplicateEmails: duplicates.map((d) => d.email).slice(0, 10),
    };
  });

  // Enrich a single lead (basic DNS check)
  app.post("/leads/:id/enrich", async (request) => {
    const { id } = request.params as { id: string };
    const job = await enrichmentQueue.add("enrich-lead", { leadId: id });
    return { queued: true, jobId: job.id };
  });

  // Bulk enrich a list
  app.post("/lead-lists/:listId/enrich", async (request) => {
    const { listId } = request.params as { listId: string };
    const leads = await prisma.lead.findMany({ where: { leadListId: listId, enrichedAt: null }, select: { id: true } });
    for (const lead of leads) {
      await enrichmentQueue.add("enrich-lead", { leadId: lead.id });
    }
    return { queued: leads.length, message: `${leads.length} leads queued for enrichment` };
  });

  // Verify a single email (DNS-based check)
  app.post("/leads/:id/verify", async (request) => {
    const { id } = request.params as { id: string };
    const lead = await prisma.lead.findUnique({ where: { id }, select: { email: true } });
    if (!lead) return { error: "Lead not found" };
    const job = await verificationQueue.add("verify-email", { leadId: id, email: lead.email });
    return { queued: true, jobId: job.id };
  });

  // Bulk verify a list
  app.post("/lead-lists/:listId/verify", async (request) => {
    const { listId } = request.params as { listId: string };
    const job = await verificationQueue.add("verify-bulk", { listId });
    return { queued: true, jobId: job.id, message: "Bulk verification queued" };
  });

  app.get("/lead-lists/:listId/export", async (request, reply) => {
    const { listId } = request.params as { listId: string };
    const leads = await prisma.lead.findMany({ where: { leadListId: listId }, orderBy: { createdAt: "desc" } });
    const csv = Papa.unparse(leads.map((l) => ({
      email: l.email, first_name: l.firstName || "", last_name: l.lastName || "",
      company: l.companyName || "", job_title: l.jobTitle || "", linkedin_url: l.linkedinUrl || "",
      phone: l.phone || "", website: l.website || "", industry: l.industry || "",
      company_size: l.companySize || "", city: l.city || "", country: l.country || "", status: l.status,
    })));
    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", `attachment; filename="leads-${listId}.csv"`);
    return reply.send(csv);
  });

  app.post("/leads/bulk/status", async (request) => {
    const { leadIds, status } = request.body as { leadIds: string[]; status: string };
    await prisma.lead.updateMany({ where: { id: { in: leadIds } }, data: { status: status as any } });
    return { updated: leadIds.length };
  });

  app.post("/leads/bulk/delete", async (request) => {
    const { leadIds } = request.body as { leadIds: string[] };
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    return { deleted: leadIds.length };
  });

  app.post("/leads/bulk/move", async (request) => {
    const { leadIds, targetListId } = request.body as { leadIds: string[]; targetListId: string };
    await prisma.lead.updateMany({ where: { id: { in: leadIds } }, data: { leadListId: targetListId } });
    return { moved: leadIds.length };
  });

  app.post("/leads/:id/tags", async (request) => {
    const { id } = request.params as { id: string };
    const { tagId } = request.body as { tagId: string };
    await prisma.leadTag.create({ data: { leadId: id, tagId } });
    return { success: true };
  });

  app.delete("/leads/:id/tags/:tagId", async (request) => {
    const { id, tagId } = request.params as { id: string; tagId: string };
    await prisma.leadTag.delete({ where: { leadId_tagId: { leadId: id, tagId } } });
    return { success: true };
  });

  app.get("/segments", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    return prisma.savedSegment.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "desc" } });
  });

  app.post("/segments", async (request, reply) => {
    const { name, filters } = request.body as { name: string; filters: any };
    const { workspace } = await getOrCreateDefaultWorkspace();
    const segment = await prisma.savedSegment.create({ data: { name, filters, workspaceId: workspace.id } });
    return reply.status(201).send(segment);
  });

  // === Deal / Pipeline endpoints ===

  app.post("/deals/update", async (request) => {
    const { leadId, stage, value, currency, notes } = request.body as {
      leadId: string; stage?: string; value?: number; currency?: string; notes?: string;
    };
    const { workspace } = await getOrCreateDefaultWorkspace();

    const existing = await prisma.deal.findUnique({ where: { leadId } });
    if (existing) {
      return prisma.deal.update({
        where: { leadId },
        data: {
          ...(stage && { stage }),
          ...(value !== undefined && { value }),
          ...(currency && { currency }),
          ...(notes && { notes }),
        },
      });
    } else {
      return prisma.deal.create({
        data: {
          leadId,
          stage: stage || "NEW",
          value: value || undefined,
          currency: currency || "USD",
          notes: notes || undefined,
          workspaceId: workspace.id,
        },
      });
    }
  });

  app.get("/deals", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    return prisma.deal.findMany({
      where: { workspaceId: workspace.id },
      include: { lead: { select: { id: true, firstName: true, lastName: true, email: true, companyName: true, jobTitle: true, linkedinUrl: true } } },
      orderBy: { updatedAt: "desc" },
    });
  });

  app.get("/deals/pipeline", async () => {
    const { workspace } = await getOrCreateDefaultWorkspace();
    const deals = await prisma.deal.findMany({
      where: { workspaceId: workspace.id },
      include: { lead: { select: { id: true, firstName: true, lastName: true, email: true, companyName: true, jobTitle: true } } },
    });

    const stages = ["NEW", "CONTACTED", "REPLIED", "INTERESTED", "MEETING_BOOKED", "PROPOSAL_SENT", "DEAL_CLOSED", "LOST"];
    const pipeline: Record<string, any[]> = {};
    for (const s of stages) pipeline[s] = [];
    for (const deal of deals) {
      if (pipeline[deal.stage]) pipeline[deal.stage].push(deal);
    }
    return pipeline;
  });
}
