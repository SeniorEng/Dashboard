import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DRAFT_KEY,
  SENSITIVE_DRAFT_FIELDS,
  sanitizeDraftFormData,
  saveDraft,
  loadDraft,
  clearDraft,
} from "@/features/customers/lib/customer-draft";
import type { CustomerFormData } from "@/features/customers/components/wizard/customer-types";

function createSensitiveFormData(): CustomerFormData {
  return {
    billingType: "pflegekasse_gesetzlich",
    vorname: "Erika",
    nachname: "Mustermann",
    geburtsdatum: "1940-03-12",
    email: "erika@example.com",
    telefon: "+49 170 1234567",
    festnetz: "+49 30 1234567",
    strasse: "Musterstraße",
    nr: "12a",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: "3",
    pflegegradSeit: "2022-01-01",
    primaryEmployeeId: "5",
    backupEmployeeId: "",
    backupEmployeeId2: "",
    vorerkrankungen: "Diabetes, Demenz",
    haustierVorhanden: true,
    haustierDetails: "Katze",
    personenbefoerderungGewuenscht: false,
    insuranceProviderId: "7",
    versichertennummer: "A123456789",
    beihilfeBerechtigt: false,
    contacts: [
      {
        vorname: "Max",
        nachname: "Mustermann",
        contactType: "angehoeriger",
        festnetz: "+49 30 7654321",
        mobilnummer: "+49 170 7654321",
        email: "max@example.com",
        notes: "Sohn, Schlüssel vorhanden",
        isPrimary: true,
      },
    ],
    budgetTypeSettings: [],
    entlastungsbetrag45b: "131",
    verhinderungspflege39: "0",
    pflegesachleistungen36: "0",
    contractDate: "2026-05-30",
    contractStart: "2026-06-01",
    vereinbarteLeistungen: "Hauswirtschaft",
    contractHours: "4",
    contractPeriod: "weekly",
    documentDeliveryMethod: "email",
    receivesMonthlyInvoice: false,
    acceptsPrivatePayment: false,
    rechnungAnKunde: false,
    vorjahrVerbraucht45b: "",
    uebertrag45b: "0",
  };
}

// Minimaler localStorage-Stub für die node-Umgebung.
class LocalStorageStub {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

describe("customer draft sensitive field exclusion", () => {
  let originalLocalStorage: typeof globalThis.localStorage | undefined;

  beforeEach(() => {
    originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = new LocalStorageStub();
  });

  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  });

  const SENSITIVE_VALUES = [
    "Erika",
    "Mustermann",
    "1940-03-12",
    "erika@example.com",
    "1234567",
    "Musterstraße",
    "10115",
    "Berlin",
    "Diabetes",
    "Demenz",
    "A123456789",
    "Max",
    "Schlüssel",
  ];

  it("strips every sensitive key from sanitized form data", () => {
    const sanitized = sanitizeDraftFormData(createSensitiveFormData());
    for (const field of SENSITIVE_DRAFT_FIELDS) {
      expect(sanitized).not.toHaveProperty(field);
    }
  });

  it("keeps non-sensitive step/configuration fields for restore", () => {
    const sanitized = sanitizeDraftFormData(createSensitiveFormData());
    expect(sanitized.billingType).toBe("pflegekasse_gesetzlich");
    expect(sanitized.primaryEmployeeId).toBe("5");
    expect(sanitized.documentDeliveryMethod).toBe("email");
    expect(sanitized.contractStart).toBe("2026-06-01");
    expect(sanitized.entlastungsbetrag45b).toBe("131");
  });

  it("never writes sensitive plaintext into the persisted draft string", () => {
    saveDraft({ formData: createSensitiveFormData(), currentStep: 3, idempotencyKey: "idem-1" });
    const raw = globalThis.localStorage.getItem(DRAFT_KEY);
    expect(raw).toBeTruthy();
    for (const value of SENSITIVE_VALUES) {
      expect(raw!.includes(value)).toBe(false);
    }
  });

  it("loadDraft scrubs sensitive fields from a legacy plaintext draft", () => {
    // Simuliere einen vor diesem Fix gespeicherten Entwurf mit Klartext.
    globalThis.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        formData: createSensitiveFormData(),
        currentStep: 2,
        timestamp: new Date().toISOString(),
        idempotencyKey: "idem-legacy",
      }),
    );
    const loaded = loadDraft();
    expect(loaded).not.toBeNull();
    for (const field of SENSITIVE_DRAFT_FIELDS) {
      expect(loaded!.formData).not.toHaveProperty(field);
    }
    expect(loaded!.formData.billingType).toBe("pflegekasse_gesetzlich");
    expect(loaded!.idempotencyKey).toBe("idem-legacy");
  });

  it("loadDraft rewrites the stored legacy draft so no plaintext remains at rest", () => {
    globalThis.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        formData: createSensitiveFormData(),
        currentStep: 2,
        timestamp: new Date().toISOString(),
        idempotencyKey: "idem-legacy",
      }),
    );
    // Vor dem Laden steht der Klartext noch im Storage.
    expect(globalThis.localStorage.getItem(DRAFT_KEY)!).toContain("Mustermann");

    loadDraft();

    // Nach dem Laden darf kein sensibler Klartext mehr im Storage liegen.
    const rawAfter = globalThis.localStorage.getItem(DRAFT_KEY);
    expect(rawAfter).toBeTruthy();
    for (const value of SENSITIVE_VALUES) {
      expect(rawAfter!.includes(value)).toBe(false);
    }
  });

  it("clearDraft removes the persisted draft", () => {
    saveDraft({ formData: createSensitiveFormData(), currentStep: 1 });
    expect(globalThis.localStorage.getItem(DRAFT_KEY)).toBeTruthy();
    clearDraft();
    expect(globalThis.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});
