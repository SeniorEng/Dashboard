import { User2, Heart, Users, Wallet, FileText } from "lucide-react";

export interface CustomerFormData {
  vorname: string;
  nachname: string;
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
  insuranceProviderId: string;
  versichertennummer: string;
  contactVorname: string;
  contactNachname: string;
  contactType: string;
  contactTelefon: string;
  contactEmail: string;
  contactIsPrimary: boolean;
  entlastungsbetrag45b: string;
  verhinderungspflege39: string;
  pflegesachleistungen36: string;
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
};

export const UMWANDLUNG_45A_BY_PFLEGEGRAD: Record<number, { sachleistung36: number; umwandlung45a: number }> = {
  1: { sachleistung36: 0, umwandlung45a: 0 },
  2: { sachleistung36: 796, umwandlung45a: 318 },
  3: { sachleistung36: 1497, umwandlung45a: 599 },
  4: { sachleistung36: 1859, umwandlung45a: 744 },
  5: { sachleistung36: 2299, umwandlung45a: 920 },
};
