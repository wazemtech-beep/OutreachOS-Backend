import prisma from "../lib/db.js";

interface AutomationRule {
  trigger: string;
  conditions?: { field: string; operator: string; value: string }[];
  actions: { type: string; params: any }[];
}

// Process an automation trigger
export async function processAutomation(trigger: string, data: Record<string, any>) {
  const { workspace } = await (await import("../lib/workspace.js")).getOrCreateDefaultWorkspace();

  const automations = await prisma.automation.findMany({
    where: { workspaceId: workspace.id, enabled: true },
  });

  for (const automation of automations) {
    const rule = automation.trigger as any;
    if (rule.event !== trigger) continue;

    // Check conditions
    const conditions = (automation.conditions as any[]) || [];
    let conditionsMet = true;

    for (const condition of conditions) {
      const value = getNestedValue(data, condition.field);
      if (!evaluateCondition(value, condition.operator, condition.value)) {
        conditionsMet = false;
        break;
      }
    }

    if (!conditionsMet) continue;

    // Execute actions
    const actions = (automation.actions as any[]) || [];
    for (const action of actions) {
      await executeAction(action, data);
    }

    // Update execution count
    await prisma.automation.update({
      where: { id: automation.id },
      data: { executionCount: { increment: 1 }, lastRunAt: new Date() },
    });

    // Log audit
    await prisma.auditLog.create({
      data: {
        action: "automation_executed",
        entity: "automation",
        entityId: automation.id,
        details: { trigger, leadId: data.leadId, actionsExecuted: actions.length },
        workspaceId: workspace.id,
      },
    });

    console.log(`[AUTOMATION] ${automation.name}: Executed for trigger ${trigger}`);
  }
}

function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((current, key) => current?.[key], obj);
}

function evaluateCondition(value: any, operator: string, expected: string): boolean {
  const str = String(value || "").toLowerCase();
  const exp = expected.toLowerCase();

  switch (operator) {
    case "equals": return str === exp;
    case "not_equals": return str !== exp;
    case "contains": return str.includes(exp);
    case "not_contains": return !str.includes(exp);
    case "starts_with": return str.startsWith(exp);
    case "ends_with": return str.endsWith(exp);
    case "gt": return Number(value) > Number(expected);
    case "lt": return Number(value) < Number(expected);
    case "is_empty": return !value || str === "";
    case "is_not_empty": return !!value && str !== "";
    default: return true;
  }
}

async function executeAction(action: { type: string; params: any }, data: Record<string, any>) {
  const leadId = data.leadId;

  switch (action.type) {
    case "move_to_stage":
      if (leadId && action.params.stage) {
        const deal = await prisma.deal.findUnique({ where: { leadId } });
        if (deal) {
          await prisma.deal.update({ where: { leadId }, data: { stage: action.params.stage } });
        } else {
          const { workspace } = await (await import("../lib/workspace.js")).getOrCreateDefaultWorkspace();
          await prisma.deal.create({
            data: { leadId, stage: action.params.stage, workspaceId: workspace.id },
          });
        }
      }
      break;

    case "add_tag":
      if (leadId && action.params.tagName) {
        const { workspace } = await (await import("../lib/workspace.js")).getOrCreateDefaultWorkspace();
        const tag = await prisma.tag.upsert({
          where: { name_workspaceId: { name: action.params.tagName, workspaceId: workspace.id } },
          update: {},
          create: { name: action.params.tagName, workspaceId: workspace.id },
        });
        await prisma.leadTag.upsert({
          where: { leadId_tagId: { leadId, tagId: tag.id } },
          update: {},
          create: { leadId, tagId: tag.id },
        });
      }
      break;

    case "remove_tag":
      if (leadId && action.params.tagName) {
        const { workspace } = await (await import("../lib/workspace.js")).getOrCreateDefaultWorkspace();
        const tag = await prisma.tag.findFirst({
          where: { name: action.params.tagName, workspaceId: workspace.id },
        });
        if (tag) {
          await prisma.leadTag.deleteMany({ where: { leadId, tagId: tag.id } });
        }
      }
      break;

    case "enroll_campaign":
      if (leadId && action.params.campaignId) {
        await prisma.campaignLead.upsert({
          where: { leadId_campaignId: { leadId, campaignId: action.params.campaignId } },
          update: {},
          create: { leadId, campaignId: action.params.campaignId },
        });
      }
      break;

    case "remove_from_campaign":
      if (leadId && action.params.campaignId) {
        await prisma.campaignLead.updateMany({
          where: { leadId, campaignId: action.params.campaignId, exitedAt: null },
          data: { exitedAt: new Date(), exitReason: "automation" },
        });
      }
      break;

    case "create_task":
      if (leadId) {
        const { workspace } = await (await import("../lib/workspace.js")).getOrCreateDefaultWorkspace();
        await prisma.task.create({
          data: {
            type: action.params.taskType || "CUSTOM",
            title: action.params.title || "Automation task",
            description: action.params.description,
            dueDate: action.params.dueDate ? new Date(action.params.dueDate) : undefined,
            leadId,
            workspaceId: workspace.id,
          },
        });
      }
      break;

    case "send_webhook":
      if (action.params.url) {
        try {
          await fetch(action.params.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "automation.action", data, action: action.params }),
          });
        } catch (err: any) {
          console.error(`[AUTOMATION] Webhook failed: ${err.message}`);
        }
      }
      break;

    case "add_note":
      if (leadId && action.params.content) {
        await prisma.note.create({
          data: { content: action.params.content, leadId },
        });
      }
      break;

    case "update_field":
      if (leadId && action.params.field && action.params.value !== undefined) {
        await prisma.lead.update({
          where: { id: leadId },
          data: { [action.params.field]: action.params.value },
        });
      }
      break;
  }
}

// Predefined automation templates
export const AUTOMATION_TEMPLATES = [
  {
    name: "Tag interested leads",
    trigger: { event: "reply_received" },
    conditions: [{ field: "replyLabel", operator: "equals", value: "interested" }],
    actions: [{ type: "add_tag", params: { tagName: "Hot Lead" } }],
  },
  {
    name: "Move replied leads to pipeline",
    trigger: { event: "reply_received" },
    conditions: [{ field: "replyLabel", operator: "equals", value: "interested" }],
    actions: [
      { type: "move_to_stage", params: { stage: "INTERESTED" } },
      { type: "create_task", params: { title: "Follow up with interested lead", taskType: "CALL" } },
    ],
  },
  {
    name: "Auto-remove unsubscribes",
    trigger: { event: "unsubscribe_received" },
    actions: [
      { type: "add_tag", params: { tagName: "Unsubscribed" } },
      { type: "remove_from_campaign", params: {} },
    ],
  },
  {
    name: "Bounce cleanup",
    trigger: { event: "bounce_received" },
    actions: [
      { type: "add_tag", params: { tagName: "Bounced" } },
      { type: "remove_from_campaign", params: {} },
    ],
  },
];
