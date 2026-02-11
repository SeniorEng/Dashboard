import { timestamp as pgTimestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import { isValidPhoneNumber, parsePhoneNumber } from "libphonenumber-js/min";

export const timestamp = (name: string) => pgTimestamp(name, { withTimezone: true });

// German phone validation using libphonenumber-js
export const germanPhoneSchema = z.string().refine(
  (value) => {
    if (!value || value.trim() === "") return false;
    try {
      if (!isValidPhoneNumber(value, "DE")) return false;
      const parsed = parsePhoneNumber(value, "DE");
      return parsed?.country === "DE";
    } catch {
      return false;
    }
  },
  { message: "Ungültige deutsche Telefonnummer" }
);

// Transform phone to E.164 format for storage
export const germanPhoneTransformSchema = germanPhoneSchema.transform((value) => {
  const parsed = parsePhoneNumber(value, "DE");
  return parsed?.format("E.164") ?? value;
});

// Legacy regex (kept for backward compatibility)
export const germanPhoneRegex = /^(\+49|0)[1-9]\d{1,14}$/;

// Optional phone validation - validates and transforms to E.164 if provided
// Handles: null, undefined, empty string, E.164 format, user input formats
export const optionalGermanPhoneSchema = z.union([
  z.null(),
  z.undefined(),
  z.literal(""),
  z.string(),
]).transform((value, ctx) => {
  if (value === null || value === undefined || value === "") return null;
  
  const trimmed = value.trim();
  if (trimmed === "") return null;
  
  try {
    if (!isValidPhoneNumber(trimmed, "DE")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ungültige deutsche Telefonnummer",
      });
      return z.NEVER;
    }
    const parsed = parsePhoneNumber(trimmed, "DE");
    if (parsed?.country !== "DE") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ungültige deutsche Telefonnummer",
      });
      return z.NEVER;
    }
    return parsed.format("E.164");
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Ungültige deutsche Telefonnummer",
    });
    return z.NEVER;
  }
});

// German validation patterns
export const ikNummerSchema = z.string()
  .regex(/^\d{9}$/, "IK-Nummer muss genau 9 Ziffern haben");

export const versichertennummerSchema = z.string()
  .regex(/^[A-Z]\d{9}$/, "Versichertennummer muss 1 Buchstabe + 9 Ziffern sein (z.B. A123456789)");

export const plzSchema = z.string()
  .regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben");
