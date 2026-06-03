export interface DocumentTypeData {
  id: number;
  name: string;
  description: string | null;
  targetType: string;
  context: string;
  inputMethod: string;
  isMandatory: boolean;
  renewalDays: number | null;
  reviewIntervalMonths: number | null;
  reminderLeadTimeDays: number | null;
  isActive: boolean;
  hasTemplate: boolean;
  templateName: string | null;
  templateSlug: string | null;
}

export interface TriggerData {
  id?: number;
  entityType: string;
  triggerType: string;
  conditionField: string | null;
  conditionOperator: string;
  conditionValue: string | null;
  requirement: string;
  sortOrder: number;
  isActive: boolean;
}

export interface DocTypeFormData {
  name: string;
  description: string;
  targetType: string;
  context: string;
  inputMethod: string;
  isMandatory: boolean;
  renewalDays: string;
  reviewIntervalMonths: string;
  reminderLeadTimeDays: string;
  isActive: boolean;
}

export interface InputField {
  key: string;
  label: string;
}

export interface TemplateOption {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  context: string;
  targetType: string;
  requiresCustomerSignature: boolean;
  requiresEmployeeSignature: boolean;
  documentTypeId: number | null;
  version: number;
  inputFields?: InputField[];
}

export interface RenderResult {
  html: string;
  printableHtml: string;
  templateId: number;
  templateVersion: number;
}

export interface GenerateResult {
  id: number;
  fileName: string;
  objectPath: string;
  integrityHash: string;
  signingStatus?: string;
  signingLink?: string | null;
}
