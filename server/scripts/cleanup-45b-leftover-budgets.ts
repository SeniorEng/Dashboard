/**
 * Task #961 — Datenfix: Fehlende §45b-Carryover-/Verfalls-Zeilen materialisieren.
 *
 * Hintergrund: Der RUNTIME-Lesepfad (`calculateAllocated45b`, Task #959) bodet
 * und deckelt §45b (Entlastungsbetrag) bereits korrekt, sodass kein Kunde mehr
 * §45b ANGEZEIGT bekommt, als rechtlich möglich ist. Für Bestandskunden fehlen
 * in der Datenbank aber oft noch die TATSÄCHLICHEN Datensätze des neuen Modells:
 *   - der jahresweise (forward-only) Übertrag (`source='carryover'`, validFrom
 *     1.1., expiresAt 30.06. des Folgejahres),
 *   - die SICHTBARE Verfalls-Buchung (`transactionType='write_off'`) für bereits
 *     abgelaufene Fenster (GoBD: „Verfall = sichtbarer write_off").
 *
 * Genau diese beiden Zeilen erzeugt der reguläre Auto-Pfad
 * `syncCarryoverAndExpiry` (= `ensureYearlyCarryover45b` + `processExpiredCarryover`)
 * idempotent. Dieses Remediation-Skript ruft ihn einmalig für alle §45b-aktiven
 * Kunden auf, damit die gespeicherten Daten zum gebodeten Lesepfad passen und
 * Audits/Exporte mit der Anzeige übereinstimmen.
 *
 * IDEMPOTENZ: `ensureYearlyCarryover45b` dedupliziert über alle (auch
 * soft-gelöschte) Carryover-Zeilen, `processExpiredCarryover` schützt write_offs
 * über die partielle UNIQUE `(customer_id, allocation_id) WHERE
 * transaction_type='write_off'`. Ein zweiter Lauf legt daher nichts Neues an.
 *
 * DRY-RUN: Ohne `--apply` läuft die Materialisierung in einer Transaktion, die
 * am Ende bewusst zurückgerollt wird — der Report zeigt also exakt, WAS ein
 * scharfer Lauf anlegen WÜRDE, ohne etwas zu schreiben.
 *
 * SICHERHEIT: Hard-Stop bei `NODE_ENV=production` und bei einem DB-Host, der
 * nach Produktion aussieht (analog `cleanup-test-data.ts`). Das Skript wird NIE
 * automatisch ausgeführt — nur manuell durch einen Operator.
 *
 * Aufruf:
 *   tsx server/scripts/cleanup-45b-leftover-budgets.ts            # Dry-Run, nur betroffene Kunden
 *   tsx server/scripts/cleanup-45b-leftover-budgets.ts --all      # Dry-Run, alle §45b-Kunden listen
 *   tsx server/scripts/cleanup-45b-leftover-budgets.ts --apply    # schreibend
 *   tsx server/scripts/cleanup-45b-leftover-budgets.ts --customer=208 --apply
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customers,
  budgetAllocations,
  budgetTransactions,
  customerBudgetTypeSettings,
} from "@shared/schema";
import { todayISO } from "@shared/utils/datetime";
import type { DbClient } from "../storage/budget/types";
import {
  calculateAllocatedCents,
  syncCarryoverAndExpiry,
} from "../storage/budget/allocation-storage";

const BUDGET_TYPE = "entlastungsbetrag_45b" as const;
const euro = (c: number) => `${(c / 100).toFixed(2)} €`;

/** Sentinel, der die Dry-Run-Transaktion sauber zurückrollt. */
class DryRunRollback extends Error {
  constructor() {
    super("dry-run rollback (kein Fehler)");
  }
}

interface CustomerSnapshot {
  carryoverRows: number;
  writeOffRows: number;
  allocatedCents: number;
}

interface CustomerResult {
  customerId: number;
  name: string;
  before: CustomerSnapshot;
  after: CustomerSnapshot;
}

function parseCustomerId(): number | null {
  const arg = process.argv.find((a) => a.startsWith("--customer="));
  if (!arg) return null;
  const n = Number(arg.split("=")[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function safetyChecks(apply: boolean): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("ABBRUCH: NODE_ENV=production. Dieses Skript darf nie auf Produktion laufen.");
  }
  const url = process.env.DATABASE_URL || "";
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/@([^:/?#]+)/);
    host = (m ? m[1] : "").toLowerCase();
  }
  if (host && /(^|[.-])prod([.-]|$)|production/.test(host)) {
    throw new Error(`ABBRUCH: DB-Host '${host}' sieht nach Produktion aus. Dieses Skript darf nie auf Produktion laufen.`);
  }
  console.log(`Sicherheits-Checks ok. DB-Host: ${host || "(unbekannt)"} · Modus: ${apply ? "APPLY (schreibend)" : "DRY-RUN"}`);
}

async function snapshot(d: DbClient, customerId: number, today: string): Promise<CustomerSnapshot> {
  const [carry] = await d
    .select({ n: sql<number>`count(*)::int` })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
    ));
  const [wo] = await d
    .select({ n: sql<number>`count(*)::int` })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, BUDGET_TYPE),
      eq(budgetTransactions.transactionType, "write_off"),
    ));
  const allocatedCents = await calculateAllocatedCents(customerId, BUDGET_TYPE, { asOfDate: today }, d);
  return {
    carryoverRows: Number(carry?.n ?? 0),
    writeOffRows: Number(wo?.n ?? 0),
    allocatedCents,
  };
}

/**
 * Materialisiert Carryover + Verfall für EINEN Kunden und liefert Vorher/Nachher.
 * Im Dry-Run wird die Transaktion am Ende zurückgerollt, sodass nichts
 * geschrieben wird — die After-Werte spiegeln aber, was ein Apply anlegen würde.
 */
async function processCustomer(
  customerId: number,
  name: string,
  today: string,
  apply: boolean,
): Promise<CustomerResult> {
  let captured: { before: CustomerSnapshot; after: CustomerSnapshot } | null = null;

  const run = async (tx: DbClient) => {
    const before = await snapshot(tx, customerId, today);
    await syncCarryoverAndExpiry(customerId, tx);
    const after = await snapshot(tx, customerId, today);
    captured = { before, after };
    if (!apply) throw new DryRunRollback();
  };

  try {
    await db.transaction(run);
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }

  if (!captured) {
    throw new Error(`Interner Fehler: keine Messwerte für Kunde #${customerId}.`);
  }
  const { before, after } = captured;
  return { customerId, name, before, after };
}

function changed(r: CustomerResult): boolean {
  return (
    r.after.carryoverRows !== r.before.carryoverRows ||
    r.after.writeOffRows !== r.before.writeOffRows ||
    r.after.allocatedCents !== r.before.allocatedCents
  );
}

async function main() {
  const apply = process.argv.includes("--apply");
  const showAll = process.argv.includes("--all");
  const onlyCustomer = parseCustomerId();
  const today = todayISO();

  await safetyChecks(apply);

  console.log(`\n=== §45b-Leftover-Bereinigung · Carryover/Verfall materialisieren (Task #961) ===`);
  console.log(`Stichtag: ${today} · Modus: ${apply ? "APPLY" : "DRY-RUN"}${onlyCustomer ? ` · nur Kunde #${onlyCustomer}` : ""}\n`);

  let targetCustomers: { customerId: number; name: string }[];

  if (onlyCustomer) {
    const [cust] = await db
      .select({ name: customers.name })
      .from(customers)
      .where(eq(customers.id, onlyCustomer))
      .limit(1);
    targetCustomers = [{ customerId: onlyCustomer, name: cust?.name ?? "" }];
  } else {
    const enabledRows = await db
      .selectDistinct({ customerId: customerBudgetTypeSettings.customerId })
      .from(customerBudgetTypeSettings)
      .where(and(
        eq(customerBudgetTypeSettings.budgetType, BUDGET_TYPE),
        eq(customerBudgetTypeSettings.enabled, true),
        isNull(customerBudgetTypeSettings.validTo),
      ))
      .orderBy(asc(customerBudgetTypeSettings.customerId));

    const names = new Map<number, string>();
    if (enabledRows.length > 0) {
      const nameRows = await db
        .select({ id: customers.id, name: customers.name })
        .from(customers);
      for (const n of nameRows) names.set(n.id, n.name);
    }
    targetCustomers = enabledRows.map(({ customerId }) => ({
      customerId,
      name: names.get(customerId) ?? "",
    }));
  }

  let affected = 0;
  let carryoverCreated = 0;
  let writeOffCreated = 0;
  let allocatedDeltaCents = 0;

  for (const { customerId, name } of targetCustomers) {
    const r = await processCustomer(customerId, name, today, apply);
    const didChange = changed(r);

    if (didChange) {
      affected++;
      carryoverCreated += r.after.carryoverRows - r.before.carryoverRows;
      writeOffCreated += r.after.writeOffRows - r.before.writeOffRows;
      allocatedDeltaCents += r.after.allocatedCents - r.before.allocatedCents;
    }

    if (!didChange && !showAll) continue;

    const flag = didChange ? (apply ? "✓" : "Δ") : " ";
    const dCarry = r.after.carryoverRows - r.before.carryoverRows;
    const dWo = r.after.writeOffRows - r.before.writeOffRows;
    const dAlloc = r.after.allocatedCents - r.before.allocatedCents;
    console.log(
      `${flag} #${customerId} ${(name || "").slice(0, 26).padEnd(26)} ` +
      `Carryover ${r.before.carryoverRows}→${r.after.carryoverRows} (${dCarry >= 0 ? "+" : ""}${dCarry}) · ` +
      `Write-off ${r.before.writeOffRows}→${r.after.writeOffRows} (${dWo >= 0 ? "+" : ""}${dWo}) · ` +
      `§45b ${euro(r.before.allocatedCents)}→${euro(r.after.allocatedCents)} (${dAlloc >= 0 ? "+" : ""}${euro(dAlloc)})`,
    );
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte §45b-Kunden:          ${targetCustomers.length}`);
  console.log(`Davon mit Materialisierung:    ${affected}`);
  console.log(`${apply ? "Angelegte" : "Würde anlegen:"} Carryover-Zeilen:  ${carryoverCreated >= 0 ? "+" : ""}${carryoverCreated}`);
  console.log(`${apply ? "Angelegte" : "Würde anlegen:"} Write-off-Zeilen:  ${writeOffCreated >= 0 ? "+" : ""}${writeOffCreated}`);
  console.log(`Σ Differenz angezeigtes §45b:  ${allocatedDeltaCents >= 0 ? "+" : ""}${euro(allocatedDeltaCents)}`);

  if (affected === 0) {
    console.log(`\n✓ Nichts zu tun — alle §45b-Carryover-/Verfalls-Zeilen sind bereits materialisiert (idempotent).`);
  } else if (apply) {
    console.log(`\n✓ Materialisierung abgeschlossen. Ein erneuter Lauf ändert nichts (idempotent).`);
  } else {
    console.log(`\n⚠ ${affected} Kunde(n) hätten fehlende Zeilen. Mit --apply scharf ausführen.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof DryRunRollback) {
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  });
