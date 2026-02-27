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


export const BILLING_TYPE_SELECT_OPTIONS = BILLING_TYPES.map((v) => ({
  value: v,
  label: BILLING_TYPE_LABELS[v],
})).sort((a, b) => a.label.localeCompare(b.label, "de"));

export const BILLING_TYPE_DESCRIPTIONS: Record<BillingType, string> = {
  pflegekasse_gesetzlich: "Abrechnung über gesetzliche Pflegekasse inkl. Forderungsabtretung",
  pflegekasse_privat: "Abrechnung über private Pflegekasse, optional mit SEPA-Mandat",
  selbstzahler: "Direktabrechnung ohne Pflegekasse, optional mit SEPA-Mandat",
};

export function isPflegekasseCustomer(billingType: BillingType): boolean {
  return billingType === "pflegekasse_gesetzlich" || billingType === "pflegekasse_privat";
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

export const DEACTIVATION_REASONS = [
  "stationaere_pflege",
  "versterben",
  "anbieterwechsel",
  "angehoerigenpflege",
  "gesundheitliche_verbesserung",
  "krankenhausaufenthalt",
  "umzug",
  "finanzielle_gruende",
  "wunsch_des_kunden",
  "kein_interesse",
  "zusammengefuehrt",
  "sonstiges",
] as const;

export type DeactivationReason = typeof DEACTIVATION_REASONS[number];

export const DEACTIVATION_REASON_LABELS: Record<DeactivationReason, string> = {
  stationaere_pflege: "Umzug in stationäre Pflege",
  versterben: "Versterben",
  anbieterwechsel: "Wechsel zu anderem Anbieter",
  angehoerigenpflege: "Pflege durch Angehörige übernommen",
  gesundheitliche_verbesserung: "Gesundheitliche Verbesserung",
  krankenhausaufenthalt: "Krankenhausaufenthalt (Langzeit)",
  umzug: "Umzug aus dem Einzugsgebiet",
  finanzielle_gruende: "Finanzielle Gründe",
  wunsch_des_kunden: "Wunsch des Kunden (ohne Angabe)",
  kein_interesse: "Kein Interesse (Erstberatung)",
  zusammengefuehrt: "Mit bestehendem Kunden zusammengeführt",
  sonstiges: "Sonstiges",
};

export const DEACTIVATION_REASON_SELECT_OPTIONS = DEACTIVATION_REASONS.map((v) => ({
  value: v,
  label: DEACTIVATION_REASON_LABELS[v],
})).sort((a, b) => a.label.localeCompare(b.label, "de"));

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
})).sort((a, b) => a.label.localeCompare(b.label, "de"));
