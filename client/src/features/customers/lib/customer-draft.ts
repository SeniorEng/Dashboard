import type { CustomerFormData } from "../components/wizard/customer-types";

export const DRAFT_KEY = "careconnect_customer_draft";
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// DSGVO Art. 9 / Identitäts- / Kontaktdaten dürfen NICHT im Klartext im
// Browser-Storage liegen. Diese Felder werden bewusst NICHT im Entwurf
// persistiert (Gesundheit, Versicherung, Geburtsdatum, Adresse, Kontakte,
// Name, Kontaktdaten). Der Restore-Flow stellt nur die übrigen, nicht
// sensiblen Schritt-/Konfigurationsdaten wieder her.
export const SENSITIVE_DRAFT_FIELDS = [
  "vorname",
  "nachname",
  "geburtsdatum",
  "email",
  "telefon",
  "festnetz",
  "strasse",
  "nr",
  "plz",
  "stadt",
  "pflegegrad",
  "pflegegradSeit",
  "vorerkrankungen",
  "versichertennummer",
  "contacts",
] as const satisfies readonly (keyof CustomerFormData)[];

export type SensitiveDraftField = (typeof SENSITIVE_DRAFT_FIELDS)[number];
export type SanitizedDraftFormData = Partial<Omit<CustomerFormData, SensitiveDraftField>>;

export interface CustomerDraft {
  formData: SanitizedDraftFormData;
  currentStep: number;
  timestamp: string;
  idempotencyKey?: string;
}

const SENSITIVE_FIELD_SET = new Set<string>(SENSITIVE_DRAFT_FIELDS);

/**
 * Entfernt alle sensiblen Felder aus den Formulardaten, sodass nur
 * nicht-sensible Schritt-/Konfigurationsdaten persistiert werden.
 */
export function sanitizeDraftFormData(formData: CustomerFormData): SanitizedDraftFormData {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(formData)) {
    if (SENSITIVE_FIELD_SET.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized as SanitizedDraftFormData;
}

export function loadDraft(): CustomerDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.timestamp) return null;
    const age = Date.now() - new Date(parsed.timestamp).getTime();
    if (age > DRAFT_MAX_AGE_MS) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    // Defensiv: auch beim Laden alte/manipulierte Entwürfe von sensiblen
    // Feldern befreien, falls ein vor diesem Fix gespeicherter Entwurf
    // noch im Storage liegt.
    let scrubbed = false;
    if (parsed.formData && typeof parsed.formData === "object") {
      for (const field of SENSITIVE_DRAFT_FIELDS) {
        if (field in parsed.formData) {
          delete parsed.formData[field];
          scrubbed = true;
        }
      }
    }
    // WICHTIG: Beim Scrubben eines Legacy-Klartext-Entwurfs den bereinigten
    // Stand SOFORT zurückschreiben, damit die sensiblen Daten nicht weiter im
    // Klartext im Storage liegen (nur das In-Memory-Objekt zu säubern reicht
    // nicht).
    if (scrubbed) {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(parsed));
      } catch {
        // Schreiben fehlgeschlagen → lieber den potenziell sensiblen Entwurf
        // ganz entfernen als ihn im Klartext liegen zu lassen.
        try {
          localStorage.removeItem(DRAFT_KEY);
        } catch {
          /* ignore */
        }
      }
    }
    return parsed as CustomerDraft;
  } catch {
    localStorage.removeItem(DRAFT_KEY);
    return null;
  }
}

export function saveDraft(draft: {
  formData: CustomerFormData;
  currentStep: number;
  idempotencyKey?: string;
}): void {
  const payload: CustomerDraft = {
    formData: sanitizeDraftFormData(draft.formData),
    currentStep: draft.currentStep,
    timestamp: new Date().toISOString(),
    idempotencyKey: draft.idempotencyKey,
  };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
