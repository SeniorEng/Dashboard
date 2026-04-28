import { documentStorage } from "../storage/documents";
import type { DocumentType, DocumentTypeTrigger } from "@shared/schema";
import { db } from "../lib/db";
import { documentTemplates } from "@shared/schema";
import { eq, and } from "drizzle-orm";

interface DocumentRequirement {
  documentType: DocumentType;
  requirement: "pflicht" | "optional";
  triggeredBy: string;
  template?: {
    id: number;
    slug: string;
    name: string;
  } | null;
}

interface CustomerTriggerData {
  billingType?: string;
  pflegegrad?: number;
  haustierVorhanden?: boolean;
  personenbefoerderungGewuenscht?: boolean;
  acceptsPrivatePayment?: boolean;
}

interface EmployeeTriggerData {
  roles: string[];
  employmentType?: string;
  haustierAkzeptiert?: boolean;
}

function evaluateTrigger(trigger: DocumentTypeTrigger, entityData: Record<string, unknown>): boolean {
  if (trigger.triggerType === "always") return true;

  if (trigger.triggerType === "role") {
    const roles = entityData.roles as string[] | undefined;
    if (!roles || !trigger.conditionField) return false;
    return roles.includes(trigger.conditionField);
  }

  if (trigger.triggerType === "field_match") {
    if (!trigger.conditionField) return false;
    const value = entityData[trigger.conditionField];

    switch (trigger.conditionOperator) {
      case "equals":
        return String(value) === trigger.conditionValue;
      case "greater_than":
        return Number(value) > Number(trigger.conditionValue);
      case "is_true":
        return value === true || value === "true";
      default:
        return false;
    }
  }

  return false;
}

async function getTemplateForDocumentType(documentTypeId: number): Promise<{ id: number; slug: string; name: string } | null> {
  const [template] = await db
    .select({ id: documentTemplates.id, slug: documentTemplates.slug, name: documentTemplates.name })
    .from(documentTemplates)
    .where(and(
      eq(documentTemplates.documentTypeId, documentTypeId),
      eq(documentTemplates.isActive, true),
    ))
    .limit(1);
  return template ?? null;
}

async function evaluateTriggersForEntityType(
  entityType: "customer" | "employee",
  entityData: Record<string, unknown>,
): Promise<DocumentRequirement[]> {
  const triggers = await documentStorage.getActiveTriggersForEntityType(entityType);

  const mandatoryTypes = await documentStorage.getDocumentTypes(true, entityType);
  const mandatoryRequirements: DocumentRequirement[] = [];
  for (const dt of mandatoryTypes) {
    if (dt.isMandatory) {
      const template = await getTemplateForDocumentType(dt.id);
      mandatoryRequirements.push({
        documentType: dt,
        requirement: "pflicht",
        triggeredBy: "Immer verpflichtend",
        template,
      });
    }
  }

  const triggerRequirements: DocumentRequirement[] = [];
  const seenTypeIds = new Set(mandatoryRequirements.map((r) => r.documentType.id));

  for (const trigger of triggers) {
    if (seenTypeIds.has(trigger.documentType.id)) continue;
    if (evaluateTrigger(trigger, entityData)) {
      seenTypeIds.add(trigger.documentType.id);
      const template = await getTemplateForDocumentType(trigger.documentType.id);
      triggerRequirements.push({
        documentType: trigger.documentType,
        requirement: trigger.requirement as "pflicht" | "optional",
        triggeredBy: formatTriggerDescription(trigger),
        template,
      });
    }
  }

  return [...mandatoryRequirements, ...triggerRequirements];
}

export async function evaluateTriggersForCustomer(customerData: CustomerTriggerData): Promise<DocumentRequirement[]> {
  return evaluateTriggersForEntityType("customer", { ...customerData });
}

export async function evaluateTriggersForEmployee(employeeData: EmployeeTriggerData): Promise<DocumentRequirement[]> {
  return evaluateTriggersForEntityType("employee", { ...employeeData });
}

function formatTriggerDescription(trigger: DocumentTypeTrigger): string {
  if (trigger.triggerType === "always") return "Gilt für alle";
  if (trigger.triggerType === "role") return `Rolle: ${trigger.conditionField}`;
  if (trigger.triggerType === "field_match") {
    const field = trigger.conditionField ?? "";
    const op = trigger.conditionOperator === "equals" ? "=" : trigger.conditionOperator === "greater_than" ? ">" : "aktiv";
    const val = trigger.conditionValue ?? "";
    if (trigger.conditionOperator === "is_true") return `${field} ist aktiv`;
    return `${field} ${op} ${val}`;
  }
  return "Unbekannt";
}
