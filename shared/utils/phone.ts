import {
  parsePhoneNumber,
  isValidPhoneNumber,
  formatIncompletePhoneNumber,
  CountryCode,
  PhoneNumber,
} from "libphonenumber-js/min";

export type PhoneValidationResult =
  | { valid: true; normalized: string; formatted: string; type: "mobile" | "landline" | "unknown" }
  | { valid: false; error: string };

export function validateGermanPhone(input: string): PhoneValidationResult {
  if (!input || input.trim() === "") {
    return { valid: false, error: "Telefonnummer ist erforderlich" };
  }

  const cleaned = input.trim();

  try {
    if (!isValidPhoneNumber(cleaned, "DE")) {
      return { valid: false, error: "Ungültige Telefonnummer" };
    }

    const phoneNumber = parsePhoneNumber(cleaned, "DE");

    if (phoneNumber.country !== "DE") {
      return { valid: false, error: "Bitte eine deutsche Telefonnummer eingeben" };
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
      formatted: phoneNumber.formatNational(),
      type,
    };
  } catch {
    return { valid: false, error: "Ungültige Telefonnummer" };
  }
}

export function normalizePhone(input: string): string | null {
  const result = validateGermanPhone(input);
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
      return phoneNumber.formatNational();
    }
  } catch {
    // Fall through to return original
  }

  return e164OrInput;
}

export function formatPhoneAsYouType(input: string): string {
  if (!input) return "";
  return formatIncompletePhoneNumber(input, "DE");
}

