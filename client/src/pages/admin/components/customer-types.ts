import { User2, Heart, Users, Wallet, FileText } from "lucide-react";
import { PFLEGEGRAD_SELECT_OPTIONS, CONTACT_TYPE_SELECT_OPTIONS } from "@shared/domain/customers";

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

export const PFLEGEGRAD_OPTIONS = PFLEGEGRAD_SELECT_OPTIONS;

export const CONTACT_TYPES = CONTACT_TYPE_SELECT_OPTIONS;

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
