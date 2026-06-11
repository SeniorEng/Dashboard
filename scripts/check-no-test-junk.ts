// ---------------------------------------------------------------------------
// Nachhaltigkeits-Guard: keine Test-„Müll"-Stammdaten in der DB (BUG-18)
//
// Liest GENAU dieselben Test-Pattern-Filter wie der Purge-Service
// (`server/services/test-data-cleanup.ts`) und zählt verbliebene
// Test-Services und Test-Dokumenttypen. Exit 1, wenn welche gefunden werden —
// gedacht als CI-/Orchestrator-Schritt NACH Integration + e2e gegen dieselbe
// (wegwerf-)DB, damit ein neuer Müll-Backlog niemals unbemerkt anwächst.
//
// SICHERHEIT: In Production ein NON-FATAL No-op (exit 0). Der Guard ist ein
// Disziplin-Werkzeug für Dev/CI; er darf eine Prod-Pipeline niemals brechen.
// Der eigentliche Prod-Purge läuft ausschließlich manuell über die geprüfte,
// freigegebene Scope-Liste (siehe Ticket).
// ---------------------------------------------------------------------------
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../server/lib/db";
import { services, documentTypes, customerServicePrices } from "@shared/schema";
import {
  SERVICE_TEST_FILTER,
  DOCUMENT_TYPE_TEST_FILTER,
} from "../server/services/test-data-cleanup";

const MAX_SAMPLE = 25;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.log(
      "[check-no-test-junk] Production erkannt — Guard ist hier ein No-op (exit 0).",
    );
    process.exit(0);
  }

  // Nur AKTIVE Müll-Stammdaten zählen: von echten Kunden referenzierter Müll
  // wird vom Purge GoBD-/FK-sicher auf `is_active=false` deaktiviert (bewusst
  // erhalten, nicht löschbar, in keiner Kunden-Picklist mehr sichtbar). Der
  // Guard darf daher nur den AKTIONIERBAREN (aktiven) Müll anschlagen, sonst
  // bliebe er auf einer Shared-Dev-DB dauerhaft rot ohne Fix-Möglichkeit. Eine
  // frische CI-Wegwerf-DB enthält keinen deaktivierten Müll → Verhalten identisch.
  const junkServices = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(and(SERVICE_TEST_FILTER, eq(services.isActive, true)));

  const junkDocTypes = await db
    .select({ id: documentTypes.id, name: documentTypes.name })
    .from(documentTypes)
    .where(and(DOCUMENT_TYPE_TEST_FILTER, eq(documentTypes.isActive, true)));

  let junkCspCount = 0;
  if (junkServices.length > 0) {
    const rows = await db
      .select({ id: customerServicePrices.id })
      .from(customerServicePrices)
      .where(
        inArray(
          customerServicePrices.serviceId,
          junkServices.map((s) => s.id),
        ),
      );
    junkCspCount = rows.length;
  }

  console.log(
    `[check-no-test-junk] Services=${junkServices.length}, Dokumenttypen=${junkDocTypes.length}, ` +
      `customer_service_prices an Müll-Services=${junkCspCount}`,
  );
  if (junkServices.length > 0) {
    console.log(
      "  Services:",
      junkServices
        .slice(0, MAX_SAMPLE)
        .map((s) => `#${s.id} ${s.name}`)
        .join(", "),
    );
  }
  if (junkDocTypes.length > 0) {
    console.log(
      "  Dokumenttypen:",
      junkDocTypes
        .slice(0, MAX_SAMPLE)
        .map((d) => `#${d.id} ${d.name}`)
        .join(", "),
    );
  }

  const total = junkServices.length + junkDocTypes.length;
  if (total > 0) {
    console.error(
      `[check-no-test-junk] FEHLGESCHLAGEN: ${total} Test-Müll-Stammdaten gefunden. ` +
        "Bitte mit `npm run cleanup:test-data` aufräumen bzw. Test-Cleanup-Disziplin prüfen.",
    );
    process.exit(1);
  }

  console.log("[check-no-test-junk] OK — keine Test-Müll-Stammdaten gefunden.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[check-no-test-junk] Unerwarteter Fehler:", err);
  process.exit(2);
});
