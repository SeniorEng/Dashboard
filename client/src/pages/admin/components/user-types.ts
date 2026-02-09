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

export function formatPhoneDisplay(phone: string): string {
  if (!phone) return '';
  if (phone.startsWith('+49')) {
    return '0' + phone.slice(3).replace(/(\d{3})(\d+)/, '$1 $2');
  }
  return phone;
}

export function validateGermanPhoneNumber(input: string): 
  | { valid: true; normalized: string; formatted: string }
  | { valid: false; error: string } {
  if (!input || input.trim() === "") {
    return { valid: false, error: "Telefonnummer ist erforderlich" };
  }
  
  const cleaned = input.trim().replace(/\s+/g, '');
  
  const germanPattern = /^(\+49|0049|0)[1-9]\d{6,13}$/;
  if (!germanPattern.test(cleaned)) {
    return { valid: false, error: "Ungültige deutsche Telefonnummer" };
  }
  
  let normalized: string;
  if (cleaned.startsWith('+49')) {
    normalized = cleaned;
  } else if (cleaned.startsWith('0049')) {
    normalized = '+49' + cleaned.slice(4);
  } else if (cleaned.startsWith('0')) {
    normalized = '+49' + cleaned.slice(1);
  } else {
    normalized = '+49' + cleaned;
  }
  
  const nationalNumber = normalized.slice(3);
  const formatted = '0' + nationalNumber.slice(0, 3) + ' ' + nationalNumber.slice(3);
  
  return { valid: true, normalized, formatted };
}
