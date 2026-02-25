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
