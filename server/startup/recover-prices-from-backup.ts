/**
 * Task #1334 — Wiederherstellung der beim Preis-Cutover-Publish verlorenen
 * Produktiv-Preise in der konsolidierten `prices`-SSoT.
 *
 * Hintergrund: Beim Cutover-Publish (#1325/#1326) hat der Replit-Schema-Diff die
 * drei Alt-Preis-Tabellen (`service_rates`, `customer_contract_rates`,
 * `customer_service_prices`) in PRODUKTION gedroppt, BEVOR die Befüll-Migration
 * `populate-prices-from-legacy-1329` lief. Diese lief dadurch als No-Op
 * (changed=0) und ist im Ledger als „applied" verbucht — sie läuft nie wieder.
 * Ergebnis: die Prod-Tabelle `prices` ist leer, alle kundenspezifischen Preise
 * fehlen live, inkl. des 0-Cent-Overrides „keine Anfahrt".
 *
 * Diese Migration stellt genau die 4 aktiven Zeilen aus dem 07:46-Vollbackup
 * (`tmp/db-backups/prod-2026-06-17T07-46-19Z-pre-pricing-cutover.dump`) wieder
 * her. Sie ERSETZT den toten No-Op-Pfad von #1329 (der bleibt als applied
 * verbucht) und macht die vorgeschlagenen #1331 (publish to activate) und #1328
 * (preventive guard) gegenstandslos.
 *
 * Eigenschaften (analog zu #1329, aber reine Insert-Migration mit FIXEN
 * Backup-Konstanten — die Alt-Tabellen sind in Prod weg und werden NICHT
 * gelesen, NICHT neu angelegt, NICHTS gedroppt):
 *   - Ledger-gegated (einmaliger Lauf über `budget_migrations`, eigener stabiler
 *     Name `recover-prices-from-backup`), NICHT flag-gegated — additiver
 *     Daten-Transport, kein Sign-off nötig.
 *   - Entitäten zur Laufzeit auflösen: Vertrag → Kunde via `customer_contracts`,
 *     Kategorie/Code → Service-ID via `services.code`. Fehlt eine referenzierte
 *     Entität (z. B. in dev/test), wird die Zeile geloggt und ÜBERSPRUNGEN
 *     (sauberer No-Op außerhalb Prod), statt zu crashen.
 *   - Idempotent: Dedup über den vollständigen Natural Key inkl. `origin`;
 *     respektiert den partiellen Unique-Index `prices_active_validfrom_uniq`
 *     (Soft-Delete-vor-Insert) — Wiederverwendung von `applyPricePopulation`
 *     aus #1329. Mehrfachlauf = No-Op.
 *   - Verifikation als Soll-Wert-Assertion: nach dem Insert wird die per-origin-
 *     Zählung geloggt und die konsolidierte `priceFor`-Auflösung gegen die
 *     bekannten Soll-Werte geprüft (205/Anfahrt=0, 39/Hauswirtschaft=3800,
 *     39/Alltagsbegleitung=4200). Jede Abweichung → harter Fehlschlag, der die
 *     Guarded-Transaktion zurückrollt (kein Ledger-Eintrag, Retry beim nächsten
 *     Boot, kein Serving mit falschen Preisen).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "../lib/db";
import { log } from "../lib/log";
import { prices, services as servicesTable } from "@shared/schema";
import { loadCustomerPriceContext } from "../storage/pricing/price-for";
import {
  applyPricePopulation,
  type TargetPriceRow,
} from "./populate-prices-from-legacy";
import {
  runGuardedBudgetMigration,
  type BudgetMigrationSummary,
} from "./budget-migration-runner";

export const RECOVER_PRICES_MIGRATION_NAME = "recover-prices-from-backup";

type RecoveryOrigin = "customer_service_prices" | "customer_contract_rates";

/**
 * Eine wiederherzustellende Preiszeile aus dem Backup. Der Kunde wird ENTWEDER
 * direkt (`customerId`, für `customer_service_prices`) ODER über den Vertrag
 * (`contractId`, für `customer_contract_rates`) zur Laufzeit aufgelöst. Der
 * Service wird über `serviceCode` → `services.code` aufgelöst.
 */
export interface PriceRecoverySpec {
  origin: RecoveryOrigin;
  /** Direkt gegebener Kunde (customer_service_prices). */
  customerId?: number;
  /** Vertrag → Kunde zur Laufzeit auflösen (customer_contract_rates). */
  contractId?: number;
  /** Service-Code (z. B. "travel_km", "hauswirtschaft", "alltagsbegleitung"). */
  serviceCode: string;
  cents: number;
  validFrom: string;
  validTo: string | null;
  /** Menschenlesbares Label fürs Log. */
  label: string;
}

/** Eine Soll-Wert-Assertion gegen die konsolidierte `priceFor`-Auflösung. */
export interface PriceRecoveryVerification {
  customerId: number;
  serviceCode: string;
  date: string;
  expectedCents: number;
}

/**
 * Die exakt 4 aktiven Zeilen aus dem 07:46-Backup (alle scope=customer,
 * deleted_at NULL). Die soft-gelöschten csp-Zeilen (1 ct / 0,01 €) sind bewusst
 * NICHT enthalten.
 */
export const PROD_RECOVERY_SPECS: readonly PriceRecoverySpec[] = [
  {
    origin: "customer_service_prices",
    customerId: 205,
    serviceCode: "travel_km",
    cents: 0,
    validFrom: "2026-06-01",
    validTo: null,
    label: "Kunde 205 Anfahrtskilometer 0 ct (0-Override keine Anfahrt)",
  },
  {
    origin: "customer_service_prices",
    customerId: 39,
    serviceCode: "hauswirtschaft",
    cents: 3800,
    validFrom: "2026-03-19",
    validTo: "2026-05-26",
    label: "Kunde 39 Hauswirtschaft 3800 ct (2026-03-19…2026-05-26)",
  },
  {
    origin: "customer_contract_rates",
    contractId: 9,
    serviceCode: "hauswirtschaft",
    cents: 3800,
    validFrom: "2025-05-13",
    validTo: null,
    label: "Vertrag 9 → Kunde 39 Hauswirtschaft 3800 ct (ab 2025-05-13)",
  },
  {
    origin: "customer_contract_rates",
    contractId: 9,
    serviceCode: "alltagsbegleitung",
    cents: 4200,
    validFrom: "2025-05-13",
    validTo: null,
    label: "Vertrag 9 → Kunde 39 Alltagsbegleitung 4200 ct (ab 2025-05-13)",
  },
];

/** Soll-Werte für die Paritäts-Assertion (aus dem Backup abgeleitet). */
export const PROD_RECOVERY_VERIFICATIONS: readonly PriceRecoveryVerification[] = [
  { customerId: 205, serviceCode: "travel_km", date: "2026-06-01", expectedCents: 0 },
  { customerId: 39, serviceCode: "hauswirtschaft", date: "2026-04-01", expectedCents: 3800 },
  { customerId: 39, serviceCode: "alltagsbegleitung", date: "2026-04-01", expectedCents: 4200 },
];

interface VerificationDeviation {
  customerId: number;
  serviceCode: string;
  date: string;
  expectedCents: number;
  actualCents: number | null;
  actualScope: string | null;
}

export class PriceRecoveryVerificationError extends Error {
  constructor(public readonly deviations: VerificationDeviation[]) {
    super(
      `Preis-Wiederherstellung abgebrochen: die konsolidierte priceFor-Auflösung weicht an ` +
        `${deviations.length} Soll-Wert-Punkt(en) ab. Der Server serviced NICHT mit falschen ` +
        `Preisen (Rollback, kein Ledger-Eintrag, Retry beim nächsten Boot):\n` +
        deviations
          .map(
            (d) =>
              `  Kunde #${d.customerId} ${d.serviceCode} @ ${d.date}: ` +
              `soll=${d.expectedCents} ct → ist=${d.actualCents ?? "—"} ct (scope=${d.actualScope ?? "—"})`,
          )
          .join("\n"),
    );
    this.name = "PriceRecoveryVerificationError";
  }
}

/** Service-ID per `services.code` auflösen (oder null, wenn unbekannt). */
async function resolveServiceIdByCode(exec: Tx, code: string): Promise<number | null> {
  const rows = await exec
    .select({ id: servicesTable.id })
    .from(servicesTable)
    .where(eq(servicesTable.code, code))
    .limit(1);
  return rows.length > 0 ? Number(rows[0].id) : null;
}

/** Kunden-ID eines Vertrags auflösen (oder null, wenn der Vertrag fehlt). */
async function resolveCustomerIdByContract(exec: Tx, contractId: number): Promise<number | null> {
  const res = await exec.execute(
    sql`SELECT customer_id FROM customer_contracts WHERE id = ${contractId} LIMIT 1`,
  );
  const rows =
    (res as unknown as { rows?: Array<{ customer_id: number }> }).rows ?? [];
  return rows.length > 0 ? Number(rows[0].customer_id) : null;
}

/** Prüft, ob ein Kunde existiert (für die No-Op-Gating der Verifikation). */
async function customerExists(exec: Tx, customerId: number): Promise<boolean> {
  const res = await exec.execute(
    sql`SELECT 1 FROM customers WHERE id = ${customerId} LIMIT 1`,
  );
  return ((res as { rows?: unknown[] }).rows?.length ?? 0) > 0;
}

/**
 * Die eigentliche Migration (läuft innerhalb der Guarded-Transaktion):
 * Spezifikationen zu kanonischen Zielzeilen auflösen → Insert (idempotent) →
 * Soll-Wert-Verifikation. Die Zielzeilen/Soll-Werte sind parametrisierbar
 * (Default = Prod-Konstanten), damit der Test sie gegen geseedete Entitäten
 * fahren kann.
 */
export async function recoverPricesFromBackup(
  tx: Tx,
  specs: readonly PriceRecoverySpec[] = PROD_RECOVERY_SPECS,
  verifications: readonly PriceRecoveryVerification[] = PROD_RECOVERY_VERIFICATIONS,
): Promise<BudgetMigrationSummary> {
  const targetRows: TargetPriceRow[] = [];
  let skipped = 0;
  let ordinal = 0;

  for (const spec of specs) {
    const serviceId = await resolveServiceIdByCode(tx, spec.serviceCode);
    if (serviceId == null) {
      log(
        `[recover-prices] WARN übersprungen (Service-Code „${spec.serviceCode}" nicht gefunden): ${spec.label}.`,
        "startup",
      );
      skipped++;
      continue;
    }

    let customerId: number | null;
    if (spec.contractId != null) {
      customerId = await resolveCustomerIdByContract(tx, spec.contractId);
      if (customerId == null) {
        log(
          `[recover-prices] WARN übersprungen (Vertrag #${spec.contractId} nicht gefunden): ${spec.label}.`,
          "startup",
        );
        skipped++;
        continue;
      }
    } else if (spec.customerId != null) {
      if (!(await customerExists(tx, spec.customerId))) {
        log(
          `[recover-prices] WARN übersprungen (Kunde #${spec.customerId} nicht gefunden): ${spec.label}.`,
          "startup",
        );
        skipped++;
        continue;
      }
      customerId = spec.customerId;
    } else {
      log(
        `[recover-prices] WARN übersprungen (weder customerId noch contractId gesetzt): ${spec.label}.`,
        "startup",
      );
      skipped++;
      continue;
    }

    targetRows.push({
      scope: "customer",
      origin: spec.origin,
      customerId,
      serviceId,
      cents: spec.cents,
      validFrom: spec.validFrom,
      validTo: spec.validTo,
      ordinal: ordinal++,
    });
  }

  const inserted = await applyPricePopulation(tx, targetRows);

  // Per-origin-Zählung loggen (Pre-Publish-Verifikation). `service_rates` wird
  // bewusst mitgeloggt (Soll=0 aktive Zeilen — keine Standardpreise im Backup),
  // damit alle drei Alt-Tabellen-Origins explizit abgedeckt sind.
  for (const origin of [
    "service_rates",
    "customer_service_prices",
    "customer_contract_rates",
  ] as const) {
    const res = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(prices)
      .where(and(eq(prices.origin, origin), isNull(prices.deletedAt)));
    log(
      `[recover-prices] Pre-Publish-Verifikation origin=${origin}: prices(aktiv)=${Number(res[0]?.c ?? 0)}.`,
      "startup",
    );
  }

  // Soll-Wert-Assertion: konsolidierte priceFor-Auflösung muss die bekannten
  // Backup-Werte ergeben. Nicht vorhandene Kunden (dev/test) werden übersprungen
  // (sauberer No-Op), statt fälschlich als Abweichung gewertet zu werden.
  const deviations: VerificationDeviation[] = [];
  for (const v of verifications) {
    if (!(await customerExists(tx, v.customerId))) {
      log(
        `[recover-prices] Soll-Wert-Check übersprungen (Kunde #${v.customerId} nicht vorhanden): ` +
          `${v.serviceCode} @ ${v.date}.`,
        "startup",
      );
      continue;
    }
    const ctx = await loadCustomerPriceContext(v.customerId, tx);
    const resolution = ctx.resolveByCode(v.serviceCode, v.date);
    const actualCents = resolution?.cents ?? null;
    const ok = actualCents === v.expectedCents;
    log(
      `[recover-prices] Soll-Wert-Check Kunde #${v.customerId} ${v.serviceCode} @ ${v.date}: ` +
        `soll=${v.expectedCents} ct, ist=${actualCents ?? "—"} ct (scope=${resolution?.scope ?? "—"}) ` +
        `[${ok ? "OK" : "ABWEICHUNG"}].`,
      "startup",
    );
    if (!ok) {
      deviations.push({
        customerId: v.customerId,
        serviceCode: v.serviceCode,
        date: v.date,
        expectedCents: v.expectedCents,
        actualCents,
        actualScope: resolution?.scope ?? null,
      });
    }
  }

  if (deviations.length > 0) {
    throw new PriceRecoveryVerificationError(deviations);
  }

  return {
    changed: inserted,
    note: `eingefügt=${inserted}, aufgelöst=${targetRows.length}, übersprungen=${skipped}`,
  };
}

/**
 * Entry-Point für die Startup-Sequenz: führt die Wiederherstellung
 * Ledger-gegated (aber NICHT flag-gegated) über den Guarded-Runner aus. Kein
 * GoBD-Bypass und kein Conservation-Check nötig — `prices` ist weder
 * Trigger-geschützt noch Teil der Budget-Erhaltungs-Invariante.
 */
export async function runRecoverPricesFromBackup(): Promise<void> {
  await runGuardedBudgetMigration({
    name: RECOVER_PRICES_MIGRATION_NAME,
    version: "1",
    gobdBypass: false,
    conservationCheck: false,
    migrate: recoverPricesFromBackup,
  });
}
