import { z, ZodIssueCode, ZodErrorMap } from "zod";

const germanErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === "undefined" || issue.received === "null") {
        return { message: "Pflichtfeld" };
      }
      return { message: `Erwartet ${translateType(issue.expected)}, erhalten ${translateType(issue.received)}` };

    case ZodIssueCode.too_small:
      if (issue.type === "string") {
        if (issue.minimum === 1) return { message: "Pflichtfeld" };
        return { message: `Mindestens ${issue.minimum} Zeichen erforderlich` };
      }
      if (issue.type === "number") {
        return { message: `Muss mindestens ${issue.minimum} sein` };
      }
      if (issue.type === "array") {
        return { message: `Mindestens ${issue.minimum} Einträge erforderlich` };
      }
      return { message: `Zu klein` };

    case ZodIssueCode.too_big:
      if (issue.type === "string") {
        return { message: `Maximal ${issue.maximum} Zeichen erlaubt` };
      }
      if (issue.type === "number") {
        return { message: `Darf maximal ${issue.maximum} sein` };
      }
      if (issue.type === "array") {
        return { message: `Maximal ${issue.maximum} Einträge erlaubt` };
      }
      return { message: `Zu groß` };

    case ZodIssueCode.invalid_string:
      if (issue.validation === "email") {
        return { message: "Ungültige E-Mail-Adresse" };
      }
      if (issue.validation === "url") {
        return { message: "Ungültige URL" };
      }
      return { message: "Ungültiges Format" };

    case ZodIssueCode.invalid_enum_value:
      return { message: `Ungültiger Wert. Erlaubt: ${issue.options.join(", ")}` };

    case ZodIssueCode.invalid_date:
      return { message: "Ungültiges Datum" };

    case ZodIssueCode.custom:
      return { message: issue.message || "Ungültige Eingabe" };

    default:
      return { message: ctx.defaultError };
  }
};

function translateType(type: string): string {
  const map: Record<string, string> = {
    string: "Text",
    number: "Zahl",
    boolean: "Wahrheitswert",
    integer: "Ganzzahl",
    float: "Dezimalzahl",
    date: "Datum",
    object: "Objekt",
    array: "Liste",
    undefined: "leer",
    null: "leer",
  };
  return map[type] || type;
}

export function installGermanZodErrors(): void {
  z.setErrorMap(germanErrorMap);
}
