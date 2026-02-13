import { CONTACT_TYPES as CONTACT_TYPE_VALUES } from "../schema/customers";

export { CONTACT_TYPE_VALUES };

export const BILLING_TYPES = [
  "pflegekasse_gesetzlich",
  "pflegekasse_privat",
  "selbstzahler",
] as const;

export type BillingType = typeof BILLING_TYPES[number];

export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
  pflegekasse_gesetzlich: "Pflegekasse (gesetzlich)",
  pflegekasse_privat: "Pflegekasse (privat)",
  selbstzahler: "Selbstzahler",
};

export const BILLING_TYPE_SHORT_LABELS: Record<BillingType, string> = {
  pflegekasse_gesetzlich: "Gesetzlich",
  pflegekasse_privat: "Privat",
  selbstzahler: "Selbstzahler",
};

export const BILLING_TYPE_SELECT_OPTIONS = BILLING_TYPES.map((v) => ({
  value: v,
  label: BILLING_TYPE_LABELS[v],
}));

export const BILLING_TYPE_DESCRIPTIONS: Record<BillingType, string> = {
  pflegekasse_gesetzlich: "Abrechnung über gesetzliche Pflegekasse inkl. Forderungsabtretung",
  pflegekasse_privat: "Abrechnung über private Pflegekasse, optional mit SEPA-Mandat",
  selbstzahler: "Direktabrechnung ohne Pflegekasse, optional mit SEPA-Mandat",
};

export function isPflegekasseCustomer(billingType: BillingType): boolean {
  return billingType === "pflegekasse_gesetzlich" || billingType === "pflegekasse_privat";
}

export function needsInsuranceData(billingType: BillingType): boolean {
  return isPflegekasseCustomer(billingType);
}

export function needsBudgetData(billingType: BillingType): boolean {
  return isPflegekasseCustomer(billingType);
}

export function needsPflegegradData(billingType: BillingType): boolean {
  return isPflegekasseCustomer(billingType);
}

export function needsVorerkrankungenData(billingType: BillingType): boolean {
  return isPflegekasseCustomer(billingType);
}

export type DocumentRequirement = "pflicht" | "optional" | "nicht_relevant";

export interface DocumentConfig {
  slug: string;
  label: string;
  requirement: DocumentRequirement;
}

export function getRequiredDocuments(billingType: BillingType): DocumentConfig[] {
  switch (billingType) {
    case "pflegekasse_gesetzlich":
      return [
        { slug: "betreuungsvertrag_pflegekasse", label: "Betreuungsvertrag", requirement: "pflicht" },
        { slug: "datenschutzvereinbarung", label: "Datenschutzvereinbarung", requirement: "pflicht" },
        { slug: "forderungsabtretung", label: "Forderungsabtretung", requirement: "pflicht" },
      ];
    case "pflegekasse_privat":
      return [
        { slug: "betreuungsvertrag_pflegekasse", label: "Betreuungsvertrag", requirement: "pflicht" },
        { slug: "datenschutzvereinbarung", label: "Datenschutzvereinbarung", requirement: "pflicht" },
        { slug: "sepa_lastschriftmandat", label: "SEPA-Lastschriftmandat", requirement: "optional" },
      ];
    case "selbstzahler":
      return [
        { slug: "dienstleistungsvertrag_selbstzahler", label: "Dienstleistungsvertrag", requirement: "pflicht" },
        { slug: "datenschutzvereinbarung", label: "Datenschutzvereinbarung", requirement: "pflicht" },
        { slug: "sepa_lastschriftmandat", label: "SEPA-Lastschriftmandat", requirement: "optional" },
      ];
  }
}

export function getStepsForBillingType(billingType: BillingType): string[] {
  const baseSteps = ["customerType", "personal"];

  if (isPflegekasseCustomer(billingType)) {
    return [...baseSteps, "insurance", "contacts", "budgets", "contract", "signatures", "matching"];
  }

  return [...baseSteps, "contacts", "contract", "signatures", "matching"];
}

export const PFLEGEGRAD_VALUES = [1, 2, 3, 4, 5] as const;

export const PFLEGEGRAD_SELECT_OPTIONS = PFLEGEGRAD_VALUES.map((v) => ({
  value: String(v),
  label: `Pflegegrad ${v}`,
}));

export const CONTACT_TYPE_LABELS: Record<string, string> = {
  familie: "Familienmitglied",
  angehoerige: "Angehörige",
  nachbar: "Nachbar/in",
  hausarzt: "Hausarzt",
  betreuer: "Betreuer/in",
  sonstige: "Sonstige",
};

export const CONTACT_TYPE_SELECT_OPTIONS = CONTACT_TYPE_VALUES.map((v) => ({
  value: v,
  label: CONTACT_TYPE_LABELS[v] ?? v,
}));
