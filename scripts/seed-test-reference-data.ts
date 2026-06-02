// ---------------------------------------------------------------------------
// Test-Referenzdaten-Seed (Task #894)
//
// Eine frische Wegwerf-DB (scripts/with-ephemeral-db.ts) bekommt über die
// Startup-Hooks NUR die System-Services (`travel_km`, `customer_km`,
// `erstberatung`) sowie Pflegekassen/PKV-Provider. Die beiden NICHT-System-
// Basis-Leistungen `hauswirtschaft` und `alltagsbegleitung` existieren auf der
// gewachsenen Dev-DB als reale Stammdaten, werden aber NIRGENDS automatisch
// geseedet. Sehr viele Integrationstests (u.a. der Helper
// `tests/helpers/budget-booking.ts`) setzen diese beiden Leistungen aber als
// vorhanden voraus ("Service hauswirtschaft nicht gefunden").
//
// Dieses Skript seedet genau diese kanonische Basis idempotent in die
// jeweilige (über DATABASE_URL adressierte) DB — gespiegelt aus den realen
// Dev-DB-Werten inkl. der drei Budget-Töpfe pro Leistung. Es läuft im
// Orchestrator NACH dem Superadmin-Seed und VOR dem Server-Start.
//
// Wichtig: KEINE Produktiv-Logik anfassen — `ensureSystemServices()` bleibt
// unverändert, damit in Produktion keine Leistungen automatisch entstehen, die
// der Betreiber selbst pflegen soll.
//
// Zusätzlich (Task #894): Die gewachsene Dev-DB hat eine vom Betreiber gepflegte
// `company_settings`-Singleton-Zeile mit Firmenidentität (Name, Anschrift,
// Steuer-IDs, Bankverbindung). Auf einer frischen Wegwerf-DB legt
// `getCompanySettings()` zwar lazy eine LEERE Zeile an, aber ohne diese Felder
// schlägt der ZUGFeRD-Build hart fehl ("IBAN fehlt", `companyName` leer) und
// `invoices.zugferd_xml` bleibt NULL — die Rechnungs-/ZUGFeRD-Tests rot. Wir
// seeden daher idempotent eine kanonische Test-Firmenidentität (KEINE echten
// Secrets — reine Geschäftsstammdaten + Test-IBAN).
import { eq } from "drizzle-orm";
import { serviceCatalogStorage } from "../server/storage/service-catalog";
import { storage } from "../server/storage";
import { db } from "../server/lib/db";
import { services } from "../shared/schema/services";

interface BaseServiceSeed {
  code: string;
  name: string;
  unitType: string;
  defaultPriceCents: number;
  vatRate: number;
  isBillable: boolean;
  employeeRateCents: number;
  minDurationMinutes: number;
  // Lohnart-/Budget-Kategorie: steuert die HW-/AB-Aufteilung der Budget-
  // Buchungen (server/storage/budget/appointment-cost-calculator.ts liest
  // services.lohnart_kategorie). Die Spalte ist notNull DEFAULT 'hauswirtschaft'
  // — ohne expliziten Wert würde die Alltagsbegleitung als Hauswirtschaft
  // verbucht (Task #894).
  lohnartKategorie: "hauswirtschaft" | "alltagsbegleitung";
  budgetPots: string[];
}

const BASE_SERVICES: BaseServiceSeed[] = [
  {
    code: "hauswirtschaft",
    name: "Hauswirtschaft",
    unitType: "hours",
    defaultPriceCents: 3800,
    vatRate: 19,
    isBillable: true,
    employeeRateCents: 1600,
    minDurationMinutes: 15,
    lohnartKategorie: "hauswirtschaft",
    budgetPots: ["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"],
  },
  {
    code: "alltagsbegleitung",
    name: "Alltagsbegleitung",
    unitType: "hours",
    defaultPriceCents: 4200,
    vatRate: 19,
    isBillable: true,
    employeeRateCents: 1800,
    minDurationMinutes: 15,
    lohnartKategorie: "alltagsbegleitung",
    budgetPots: ["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"],
  },
];

async function seedCompanySettings(): Promise<void> {
  const existing = await storage.getCompanySettings();
  if (existing.companyName && existing.iban) {
    console.log("[seed-ref-data] company_settings bereits gepflegt — übersprungen.");
    return;
  }
  // updatedByUserId referenziert users.id (nullable). Wir hängen die Seed-Zeile
  // an den zuvor geseedeten Superadmin, falls vorhanden.
  const { db } = await import("../server/lib/db");
  const { users } = await import("@shared/schema");
  const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
  const seederId = firstUser?.id ?? 0;
  await storage.updateCompanySettings(
    {
      companyName: "Seniorenengel Alltagsbegleitung Test GmbH",
      geschaeftsfuehrer: "Test Geschäftsführer",
      strasse: "Teststraße",
      hausnummer: "1",
      plz: "10117",
      stadt: "Berlin",
      telefon: "+49 30 0000000",
      email: "rechnung@test.local",
      ustId: "DE123456789",
      steuernummer: "12/345/67890",
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
      bankName: "Test-Bank",
    },
    seederId,
  );
  console.log("[seed-ref-data] company_settings Firmenidentität geseedet.");
}

async function main(): Promise<void> {
  for (const def of BASE_SERVICES) {
    const existing = await serviceCatalogStorage.getServiceByCode(def.code);
    if (existing) {
      console.log(`[seed-ref-data] Service ${def.code} existiert bereits (id ${existing.id}) — übersprungen.`);
      continue;
    }
    const created = await serviceCatalogStorage.createService({
      code: def.code,
      name: def.name,
      unitType: def.unitType,
      defaultPriceCents: def.defaultPriceCents,
      vatRate: def.vatRate,
      isBillable: def.isBillable,
      employeeRateCents: def.employeeRateCents,
      minDurationMinutes: def.minDurationMinutes,
      lohnartKategorie: def.lohnartKategorie,
      isActive: true,
      sortOrder: 0,
      budgetPots: def.budgetPots,
    });
    // createService() persistiert `lohnartKategorie` NICHT (die Spalte fehlt im
    // Insert-Mapping → DB fällt auf den Schema-Default 'hauswirtschaft' zurück).
    // Die Budget-Minuten-Kategorisierung
    // (server/storage/budget/appointment-cost-calculator.ts) keyt aber genau auf
    // services.lohnart_kategorie; ohne korrekten Wert würde die Alltagsbegleitung
    // als Hauswirtschaft verbucht. Wir spiegeln daher die reale Dev-DB-Kategorie
    // per direktem Update nach (Task #894 — reines Seed-Setup, keine
    // Produktiv-Logik-Änderung).
    if (created.lohnartKategorie !== def.lohnartKategorie) {
      await db.update(services)
        .set({ lohnartKategorie: def.lohnartKategorie })
        .where(eq(services.id, created.id));
    }
    console.log(`[seed-ref-data] Service ${def.code} angelegt (id ${created.id}, ${def.budgetPots.length} Töpfe, lohnart=${def.lohnartKategorie}).`);
  }
  await seedCompanySettings();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[seed-ref-data] Fehler: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
