/**
 * Task #724 — Audit-Skript: listet bestehende Pflegekasse-Kunden mit
 * Pflegegrad ≥ 2, die KEINE aktiven Budget-Typ-Einstellungen haben
 * (`customer_budget_type_settings.validTo IS NULL`). Solche Kunden sind
 * vor der Einführung der Response-Markierung lautlos halb-konfiguriert
 * angelegt worden (oder wurden per API ohne Folge-Call zur Budget-
 * Initialisierung erstellt) — sie können keine §45b-/§45a-/§39-§42a-
 * Buchungen sehen.
 *
 * Read-only: das Skript schreibt nichts. Ausführung:
 *   tsx scripts/audit-customers-without-budget-init.ts
 *
 * Output: TSV-Zeilen `customerId\tname\tbillingType\tpflegegrad\tcreatedAt`
 * plus Summary-Zeile.
 */
import { db } from "../server/lib/db";
import { customers } from "../shared/schema";
import { customerBudgetTypeSettings } from "../shared/schema";
import { and, eq, isNull, inArray, gte } from "drizzle-orm";

async function main() {
  const candidates = await db
    .select({
      id: customers.id,
      name: customers.name,
      billingType: customers.billingType,
      pflegegrad: customers.pflegegrad,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .where(and(
      isNull(customers.deletedAt),
      inArray(customers.billingType, ["pflegekasse_gesetzlich", "pflegekasse_privat"]),
      gte(customers.pflegegrad, 2),
    ));

  if (candidates.length === 0) {
    console.log("Keine Kandidaten gefunden — alle Pflegekasse-Kunden ab PG 2 haben Budget-Settings (oder es gibt keine).");
    return;
  }

  const ids = candidates.map(c => c.id);
  const withActiveSettings = await db
    .selectDistinct({ customerId: customerBudgetTypeSettings.customerId })
    .from(customerBudgetTypeSettings)
    .where(and(
      inArray(customerBudgetTypeSettings.customerId, ids),
      isNull(customerBudgetTypeSettings.validTo),
      eq(customerBudgetTypeSettings.enabled, true),
    ));

  const configured = new Set(withActiveSettings.map(r => r.customerId));
  const missing = candidates.filter(c => !configured.has(c.id));

  console.log("customerId\tname\tbillingType\tpflegegrad\tcreatedAt");
  for (const c of missing) {
    console.log(`${c.id}\t${c.name}\t${c.billingType}\t${c.pflegegrad}\t${c.createdAt?.toISOString?.() ?? c.createdAt}`);
  }
  console.log(`---`);
  console.log(`Gesamt geprüft: ${candidates.length} | Ohne aktive Budget-Settings: ${missing.length}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("[audit] fehlgeschlagen:", err);
    process.exit(1);
  });
