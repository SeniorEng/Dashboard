import type { DocumentTypeData, DocTypeFormData, TriggerData } from "./types";

export const emptyForm: DocTypeFormData = {
  name: "",
  description: "",
  targetType: "employee",
  context: "beide",
  inputMethod: "upload",
  isMandatory: false,
  renewalDays: "",
  reviewIntervalMonths: "",
  reminderLeadTimeDays: "14",
  isActive: true,
};

export function toFormData(dt: DocumentTypeData): DocTypeFormData {
  return {
    name: dt.name,
    description: dt.description || "",
    targetType: dt.targetType || "employee",
    context: dt.context || "beide",
    inputMethod: dt.inputMethod || "upload",
    isMandatory: dt.isMandatory ?? false,
    renewalDays: dt.renewalDays?.toString() || "",
    reviewIntervalMonths: dt.reviewIntervalMonths?.toString() || "",
    reminderLeadTimeDays: dt.reminderLeadTimeDays?.toString() || "14",
    isActive: dt.isActive,
  };
}

export function toPayload(form: DocTypeFormData) {
  return {
    name: form.name,
    description: form.description || null,
    targetType: form.targetType,
    context: form.context,
    inputMethod: form.inputMethod,
    isMandatory: form.isMandatory,
    renewalDays: form.renewalDays ? parseInt(form.renewalDays) : null,
    reviewIntervalMonths: form.reviewIntervalMonths ? parseInt(form.reviewIntervalMonths) : null,
    reminderLeadTimeDays: form.reminderLeadTimeDays ? parseInt(form.reminderLeadTimeDays) : 14,
    isActive: form.isActive,
  };
}

export function createEmptyTrigger(entityType: string): TriggerData {
  return {
    entityType,
    triggerType: "field_match",
    conditionField: null,
    conditionOperator: "equals",
    conditionValue: null,
    requirement: "pflicht",
    sortOrder: 0,
    isActive: true,
  };
}
