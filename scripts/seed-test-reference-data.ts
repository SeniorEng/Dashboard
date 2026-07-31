// ---------------------------------------------------------------------------
// Test-Referenzdaten-Seed (Task #894, angepasst in Phase 3.4)
//
// Der Dienstleistungskatalog ist seit Phase 3.4 konfigurationsgesteuert
// (`shared/config/services.ts`). Eine frische Wegwerf-DB
// (scripts/with-ephemeral-db.ts) bekommt damit ALLE realen Leistungen
// (hauswirtschaft, alltagsbegleitung, travel_km, customer_km, erstberatung)
// inkl. ihrer Budget-Töpfe automatisch über den Startup-Hook
// `serviceCatalogStorage.syncServiceCatalog()`. Die frühere Sonder-Seed-Liste
// `BASE_SERVICES` ist damit ERSETZT und hier aufgelöst — die einzige Quelle ist
// die Konfig.
//
// Was hier verbleibt (Task #894): Die gewachsene Dev-DB hat eine vom Betreiber
// gepflegte `company_settings`-Singleton-Zeile mit Firmenidentität (Name,
// Anschrift, Steuer-IDs, Bankverbindung). Auf einer frischen Wegwerf-DB legt
// `getCompanySettings()` zwar lazy eine LEERE Zeile an, aber ohne diese Felder
// schlägt der ZUGFeRD-Build hart fehl ("IBAN fehlt", `companyName` leer) und
// `invoices.zugferd_xml` bleibt NULL — die Rechnungs-/ZUGFeRD-Tests rot. Wir
// seeden daher idempotent eine kanonische Test-Firmenidentität (KEINE echten
// Secrets — reine Geschäftsstammdaten + Test-IBAN). Läuft im Orchestrator NACH
// dem Superadmin-Seed und VOR dem Server-Start.
// MUSS der erste Import bleiben: prüft die Ziel-DB, bevor server/storage
// ausgewertet wird (scripts/lib/assert-write-target.ts).
import "./lib/assert-write-target";
import { storage } from "../server/storage";

async function seedCompanySettings(): Promise<void> {
  const existing = await storage.getCompanySettings();
  if (existing.companyName && existing.iban) {
    console.log("[seed-ref-data] company_settings bereits gepflegt — übersprungen.");
    return;
  }
  // updatedByUserId referenziert users.id (nullable). Wir hängen die Seed-Zeile
  // an den zuvor geseedeten Superadmin, falls vorhanden. Existiert (noch) KEIN
  // User — z.B. im CI-Job `template-cache-verify`, der mangels Login-Secrets
  // den Superadmin-Seed überspringt —, MUSS die Spalte NULL bleiben. Ein
  // Fallback auf 0 würde die users-FK verletzen und den ganzen Seed mit exit 1
  // abbrechen (Task #1250).
  const { db } = await import("../server/lib/db");
  const { users } = await import("@shared/schema");
  const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
  const seederId = firstUser?.id ?? null;
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
  await seedCompanySettings();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[seed-ref-data] Fehler: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
