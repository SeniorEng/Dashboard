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
  austrittsDatum: string | null;
  vacationDaysPerYear: number;
  isActive: boolean;
  isAnonymized: boolean;
  isAdmin: boolean;
  haustierAkzeptiert: boolean;
  lbnr: string | null;
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
  austrittsDatum?: string | null;
  vacationDaysPerYear?: number;
  isAdmin: boolean;
  haustierAkzeptiert: boolean;
  lbnr?: string | null;
  roles: string[];
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
