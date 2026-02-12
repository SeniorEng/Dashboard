import { CONTACT_TYPES as CONTACT_TYPE_VALUES } from "../schema/customers";

export { CONTACT_TYPE_VALUES };

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
