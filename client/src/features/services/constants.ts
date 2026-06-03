import type { ServiceFormData } from "./types";

export const UNIT_TYPE_LABELS: Record<string, string> = {
  hours: "Stunden",
  kilometers: "Kilometer",
  flat: "Pauschale",
};

export const UNIT_SUFFIX: Record<string, string> = {
  hours: "/Std.",
  kilometers: "/km",
  flat: " pauschal",
};

export const LOHNART_LABELS: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
};

export const EMPTY_FORM: ServiceFormData = {
  name: "",
  code: "",
  description: "",
  unitType: "hours",
  defaultPriceCents: "",
  vatRate: "19",
  minDurationMinutes: "",
  isBillable: true,
  employeeRateCents: "",
  lohnartKategorie: "hauswirtschaft",
  budgetPots: [],
  isDefault: false,
  isActive: true,
  sortOrder: "0",
};
