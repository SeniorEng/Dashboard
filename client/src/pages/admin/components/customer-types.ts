import { User2, Heart, Users, Wallet, FileText } from "lucide-react";

export interface ContactFormData {
  vorname: string;
  nachname: string;
  contactType: string;
  telefon: string;
  email: string;
  isPrimary: boolean;
}

export interface CustomerFormData {
  vorname: string;
  nachname: string;
  geburtsdatum: string;
  email: string;
  telefon: string;
  festnetz: string;
  strasse: string;
  nr: string;
  plz: string;
  stadt: string;
  pflegegrad: string;
  pflegegradSeit: string;
  primaryEmployeeId: string;
  backupEmployeeId: string;
  vorerkrankungen: string;
  haustierVorhanden: boolean;
  haustierDetails: string;
  insuranceProviderId: string;
  versichertennummer: string;
  contacts: ContactFormData[];
  entlastungsbetrag45b: string;
  verhinderungspflege39: string;
  pflegesachleistungen36: string;
  contractDate: string;
  contractStart: string;
  vereinbarteLeistungen: string;
  contractHours: string;
  contractPeriod: "weekly" | "monthly";
  hauswirtschaftRate: string;
  alltagsbegleitungRate: string;
  erstberatungRate: string;
  kilometerRate: string;
}

export interface SelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

export const STEPS = [
  { id: "personal", title: "Persönliche Daten", icon: User2 },
  { id: "insurance", title: "Pflegekasse", icon: Heart },
  { id: "contacts", title: "Kontakte", icon: Users },
  { id: "budgets", title: "Budgets", icon: Wallet },
  { id: "contract", title: "Vertrag", icon: FileText },
];

export const PFLEGEGRAD_OPTIONS = [
  { value: "1", label: "Pflegegrad 1" },
  { value: "2", label: "Pflegegrad 2" },
  { value: "3", label: "Pflegegrad 3" },
  { value: "4", label: "Pflegegrad 4" },
  { value: "5", label: "Pflegegrad 5" },
];

export const CONTACT_TYPES = [
  { value: "familie", label: "Familienmitglied" },
  { value: "angehoerige", label: "Angehörige" },
  { value: "nachbar", label: "Nachbar/in" },
  { value: "hausarzt", label: "Hausarzt" },
  { value: "betreuer", label: "Betreuer/in" },
  { value: "sonstige", label: "Sonstige" },
];

export const PERIOD_TYPES = [
  { value: "weekly", label: "Pro Woche" },
  { value: "monthly", label: "Pro Monat" },
];

export const DEFAULT_BUDGETS = {
  entlastungsbetrag45b: 131,
  verhinderungspflege39: 3539,
  pflegesachleistungen36: 0,
} as const;

export const EMPTY_CONTACT: ContactFormData = {
  vorname: "",
  nachname: "",
  contactType: "familie",
  telefon: "",
  email: "",
  isPrimary: true,
};

export const MAX_CONTACTS = 3;
