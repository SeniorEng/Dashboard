import {
  parsePhoneNumber,
  isValidPhoneNumber,
  formatIncompletePhoneNumber,
  CountryCode,
  PhoneNumber,
} from "libphonenumber-js/min";

export const DACH_COUNTRIES: CountryCode[] = ["DE", "AT", "CH"];

export function isDACHCountry(country: string | undefined): boolean {
  return DACH_COUNTRIES.includes(country as CountryCode);
}

export type PhoneValidationResult =
  | { valid: true; normalized: string; formatted: string; type: "mobile" | "landline" | "unknown" }
  | { valid: false; error: string };

export function validateDachPhone(input: string): PhoneValidationResult {
  if (!input || input.trim() === "") {
    return { valid: false, error: "Telefonnummer ist erforderlich" };
  }

  const cleaned = input.trim();

  try {
    let phoneNumber: PhoneNumber | undefined;

    for (const country of DACH_COUNTRIES) {
      if (isValidPhoneNumber(cleaned, country)) {
        phoneNumber = parsePhoneNumber(cleaned, country);
        break;
      }
    }

    if (!phoneNumber && isValidPhoneNumber(cleaned)) {
      phoneNumber = parsePhoneNumber(cleaned);
    }

    if (!phoneNumber || !phoneNumber.isValid()) {
      return { valid: false, error: "Ungültige Telefonnummer (DE/AT/CH)" };
    }

    if (!isDACHCountry(phoneNumber.country)) {
      return { valid: false, error: "Ungültige Telefonnummer (DE/AT/CH)" };
    }

    const phoneType = phoneNumber.getType();
    let type: "mobile" | "landline" | "unknown" = "unknown";

    if (phoneType === "MOBILE") {
      type = "mobile";
    } else if (phoneType === "FIXED_LINE" || phoneType === "FIXED_LINE_OR_MOBILE") {
      type = "landline";
    }

    return {
      valid: true,
      normalized: phoneNumber.format("E.164"),
      formatted: phoneNumber.country === "DE" ? phoneNumber.formatNational() : phoneNumber.formatInternational(),
      type,
    };
  } catch {
    return { valid: false, error: "Ungültige Telefonnummer (DE/AT/CH)" };
  }
}


export function normalizePhone(input: string): string | null {
  const result = validateDachPhone(input);
  if (result.valid) {
    return result.normalized;
  }
  return null;
}

export function formatPhoneForDisplay(e164OrInput: string): string {
  if (!e164OrInput) return "";

  try {
    const phoneNumber = parsePhoneNumber(e164OrInput, "DE");
    if (phoneNumber && phoneNumber.isValid()) {
      return phoneNumber.country === "DE" ? phoneNumber.formatNational() : phoneNumber.formatInternational();
    }
  } catch {
  }

  return e164OrInput;
}

export function formatPhoneAsYouType(input: string): string {
  if (!input) return "";
  if (input.startsWith("+") || input.startsWith("00")) {
    const normalized = input.startsWith("00") ? "+" + input.slice(2) : input;
    return formatIncompletePhoneNumber(normalized);
  }
  return formatIncompletePhoneNumber(input, "DE");
}
