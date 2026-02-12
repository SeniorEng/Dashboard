export interface UserData {
  id: number;
  email: string;
  displayName: string;
  vorname: string | null;
  nachname: string | null;
  telefon: string | null;
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
  stadt: string | null;
  geburtsdatum: string | null;
  eintrittsdatum: string | null;
  vacationDaysPerYear: number;
  isActive: boolean;
  isAdmin: boolean;
  roles: string[];
  createdAt: string;
}

export interface UserFormData {
  email: string;
  password?: string;
  vorname: string;
  nachname: string;
  telefon?: string;
  strasse?: string;
  hausnummer?: string;
  plz?: string;
  stadt?: string;
  geburtsdatum?: string;
  eintrittsdatum?: string;
  vacationDaysPerYear?: number;
  isAdmin: boolean;
  roles: string[];
  compensation?: {
    hourlyRateHauswirtschaftCents?: number;
    hourlyRateAlltagsbegleitungCents?: number;
    travelCostType?: "kilometergeld" | "pauschale";
    kilometerRateCents?: number;
    monthlyTravelAllowanceCents?: number;
    validFrom: string;
  };
}

export interface CompensationData {
  id: number;
  userId: number;
  hourlyRateHauswirtschaftCents: number | null;
  hourlyRateAlltagsbegleitungCents: number | null;
  travelCostType: string | null;
  kilometerRateCents: number | null;
  monthlyTravelAllowanceCents: number | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
}

export const ROLE_LABELS: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
  erstberatung: "Erstberatung",
  personenbefoerderung: "Personenbeförderung",
  kinderbetreuung: "Kinderbetreuung",
};

export const AVAILABLE_ROLES = [
  "hauswirtschaft",
  "alltagsbegleitung",
  "erstberatung",
  "personenbefoerderung",
  "kinderbetreuung",
];

export { formatPhoneForDisplay, validateGermanPhone } from "@shared/utils/phone";
