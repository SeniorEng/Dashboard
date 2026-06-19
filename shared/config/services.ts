/**
 * Service-Katalog — EINZIGE Quelle der echten Dienstleistungen (Phase 3.4).
 *
 * Ein neuer oder geänderter Service entsteht AUSSCHLIESSLICH durch eine
 * Code-Änderung an dieser Datei (mit Review) — niemals über UI oder API.
 * Beim Start gleicht `serviceCatalogStorage.syncServiceCatalog()` die DB gegen
 * diese Konfiguration ab; eine Abweichung Konfig↔DB ist ein Startfehler.
 *
 * Ersetzungs-Regel: ersetzt die frühere `SYSTEM_SERVICE_DEFINITIONS`-Inline-
 * Liste (server/storage/service-catalog.ts) UND die `BASE_SERVICES`-Seed-Liste
 * (scripts/seed-test-reference-data.ts). Beide sind aufgelöst — hier ist die
 * einzige Quelle.
 *
 * NICHT im Scope: Preislogik (der Standardpreis zieht nur als Katalog-Attribut
 * um, er wird nicht neu berechnet); Kunden-Sonderpreise bleiben unberührt.
 */

export const SERVICE_BUDGET_POTS = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
] as const;
export type ServiceBudgetPotType = (typeof SERVICE_BUDGET_POTS)[number];

export interface ServiceCatalogEntry {
  /** Eindeutiger, stabiler Code — Identität des Services über alle Umgebungen. */
  code: string;
  name: string;
  description: string | null;
  unitType: "hours" | "kilometers" | "flat";
  /** Standardpreis als Katalog-Attribut (Integer-Cents). */
  defaultPriceCents: number;
  vatRate: number;
  minDurationMinutes: number | null;
  isBillable: boolean;
  isSystem: boolean;
  employeeRateCents: number;
  lohnartKategorie: "hauswirtschaft" | "alltagsbegleitung";
  sortOrder: number;
  isDefault: boolean;
  budgetPots: ServiceBudgetPotType[];
}

export const SERVICE_CATALOG: ServiceCatalogEntry[] = [
  {
    code: "hauswirtschaft",
    name: "Hauswirtschaft",
    description: null,
    unitType: "hours",
    defaultPriceCents: 3800,
    vatRate: 19,
    minDurationMinutes: 15,
    isBillable: true,
    isSystem: false,
    employeeRateCents: 1600,
    lohnartKategorie: "hauswirtschaft",
    sortOrder: 0,
    isDefault: false,
    budgetPots: ["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"],
  },
  {
    code: "alltagsbegleitung",
    name: "Alltagsbegleitung",
    description: null,
    unitType: "hours",
    defaultPriceCents: 4200,
    vatRate: 19,
    minDurationMinutes: 15,
    isBillable: true,
    isSystem: false,
    employeeRateCents: 1800,
    lohnartKategorie: "alltagsbegleitung",
    sortOrder: 0,
    isDefault: false,
    budgetPots: ["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"],
  },
  {
    code: "travel_km",
    name: "Anfahrtskilometer",
    description: "Kilometer für die Anfahrt zum Kunden",
    unitType: "kilometers",
    defaultPriceCents: 35,
    vatRate: 19,
    minDurationMinutes: null,
    isBillable: true,
    isSystem: true,
    employeeRateCents: 30,
    lohnartKategorie: "hauswirtschaft",
    sortOrder: 90,
    isDefault: false,
    budgetPots: ["entlastungsbetrag_45b", "umwandlung_45a"],
  },
  {
    code: "customer_km",
    name: "Kundenkilometer",
    description: "Kilometer mit/für den Kunden gefahren",
    unitType: "kilometers",
    defaultPriceCents: 35,
    vatRate: 19,
    minDurationMinutes: null,
    isBillable: true,
    isSystem: true,
    employeeRateCents: 30,
    lohnartKategorie: "hauswirtschaft",
    sortOrder: 91,
    isDefault: false,
    budgetPots: ["entlastungsbetrag_45b", "umwandlung_45a"],
  },
  {
    code: "erstberatung",
    name: "Erstberatung",
    description: "Erstberatung für neue Kunden",
    unitType: "hours",
    defaultPriceCents: 0,
    vatRate: 19,
    minDurationMinutes: null,
    isBillable: false,
    isSystem: true,
    employeeRateCents: 1600,
    lohnartKategorie: "hauswirtschaft",
    sortOrder: 0,
    isDefault: false,
    budgetPots: [],
  },
];

/** Alle in der Konfig definierten Service-Codes (Identitäts-Set für den DB-Abgleich). */
export const SERVICE_CATALOG_CODES: string[] = SERVICE_CATALOG.map((s) => s.code);
