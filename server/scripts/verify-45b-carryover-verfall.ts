/**
 * Task #1392 — Read-only-Verifikationsreport: §45b-Carryover-Verfall.
 *
 * Sicherheitsnetz für den §45b-Carryover-Verfall-Root-Fix (Task #1392). Der
 * RUNTIME-Lesepfad (`calculateAllocated45b`) + Auto-Pfad
 * (`ensureYearlyCarryover45b`) wurden um zwei Wurzeln korrigiert:
 *   Bug 1 (Chaining): Ein bereits hereingerollter Übertrag (Quelljahr Y) darf
 *     NICHT erneut in den Folgejahres-Übertrag wandern — sein Restguthaben
 *     verfällt zu SEINER eigenen Frist (30.06.(Y+1)). Nur das im Jahr selbst
 *     entstandene Guthaben rollt weiter.
 *   Bug 2 (Kopplung Startwert↔Übertrag): Ein abgelaufener/staler Übertrag darf
 *     keinen gültigen Startwert (`initial_balance`) verdrängen; Übertrag +
 *     Startwert desselben Quelljahrs zählen genau EINMAL (gezielte
 *     IB-Supersession, NICHT pauschal über das späteste Übertrags-Jahr).
 *
 * Dieser Report ÄNDERT NICHTS (nur `db.select` + reiner Verfügbarkeits-SSoT
 * `readUnifiedBudgetAvailability` / `calculateAllocatedCents`). Er listet je
 * §45b-aktivem Kunden die auffälligen Fingerabdrücke der beiden Bugs sowie die
 * Reste, die ein Operator per GoBD-Storno aufräumen muss (Storno bestehender
 * staler Carryover-Zeilen ist BEWUSST out-of-scope dieses Fixes):
 *   (A) NEGATIVE angezeigte §45b-Verfügbarkeit (das Original-Symptom, z.B.
 *       „−2.012 €"). Mit dem Fix darf das nicht mehr auftreten.
 *   (B) ABGELAUFENE, aber noch aktive Carryover-Zeile (`expiresAt < heute`,
 *       `deleted_at IS NULL`) OHNE zugehörigen `write_off` — staler Übertrag,
 *       der per `syncCarryoverAndExpiry` ausgebucht bzw. per Storno bereinigt
 *       werden muss.
 *   (C) CHAINING-Verdacht: aktive Carryover-Zeilen für ≥2 aufeinanderfolgende
 *       Zieljahre — ein Hinweis auf den alten Weiterroll-Pfad.
 *
 * FORWARD-ONLY: keine Datenmigration. Ein Recompute + `syncCarryoverAndExpiry`
 * materialisiert den Verfall als sichtbaren `write_off`; bereits fälschlich
 * weitergerollte Zeilen bleiben für den Operator-Storno sichtbar.
 *
 * Aufruf:
 *   tsx server/scripts/verify-45b-carryover-verfall.ts          # nur Auffällige
 *   tsx server/scripts/verify-45b-carryover-verfall.ts --all     # alle §45b-Kunden
 */
import { and, asc, eq, isNull, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customers,
  budgetAllocations,
  budgetTransactions,
  customerBudgetTypeSettings,
} from "@shared/schema";
import { todayISO } from "@shared/utils/datetime";
import { calculateAllocatedCents } from "../storage/budget/allocation-storage";
import { readUnifiedBudgetAvailability } from "../storage/budget/unified-reader";

const BUDGET_TYPE = "entlastungsbetrag_45b" as const;
const euro = (c: number) => `${(c / 100).toFixed(2)} €`;

async function main() {
  const showAll = process.argv.includes("--all");
  const today = todayISO();

  console.log(`\n=== §45b-Carryover-Verfall · Read-only-Verifikationsreport (Task #1392) ===`);
  console.log(`Stichtag: ${today} · Modus: ${showAll ? "ALLE §45b-Kunden" : "nur Auffällige"}\n`);

  const enabledRows = await db
    .selectDistinct({ customerId: customerBudgetTypeSettings.customerId })
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.budgetType, BUDGET_TYPE),
      eq(customerBudgetTypeSettings.enabled, true),
      isNull(customerBudgetTypeSettings.validTo),
    ))
    .orderBy(asc(customerBudgetTypeSettings.customerId));

  let flagged = 0;
  const counts = { negative: 0, staleCarryover: 0, chaining: 0 };

  for (const { customerId } of enabledRows) {
    const [cust] = await db
      .select({ name: customers.name })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);

    const carryovers = await db
      .select({
        id: budgetAllocations.id,
        year: budgetAllocations.year,
        amountCents: budgetAllocations.amountCents,
        expiresAt: budgetAllocations.expiresAt,
      })
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, BUDGET_TYPE),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
      ));

    const reasons: string[] = [];

    // (A) Original-Symptom: negative angezeigte Verfügbarkeit. Reiner SSoT-Read.
    let availableCents = 0;
    try {
      const unified = await readUnifiedBudgetAvailability(customerId, today);
      availableCents = unified.pots.entlastungsbetrag_45b.availableCents;
      // availableCents ist per `max(0, …)` gebodet; die ungebodete Differenz
      // (allocated − consumedNet) macht den eigentlichen Drift sichtbar.
      const allocated = unified.pots.entlastungsbetrag_45b.allocatedCents;
      const consumedNet = unified.pots.entlastungsbetrag_45b.consumedNetCents;
      const rawAvailable = allocated - consumedNet;
      if (rawAvailable < 0) {
        reasons.push(`(A) negative §45b-Verfügbarkeit roh ${euro(rawAvailable)} (allocated ${euro(allocated)} − consumedNet ${euro(consumedNet)})`);
        counts.negative++;
      }
    } catch (err) {
      reasons.push(`(A?) Verfügbarkeit nicht lesbar: ${(err as Error).message}`);
    }

    // (B) Abgelaufene, aber noch aktive Carryover-Zeile ohne write_off.
    const expiredCarryovers = carryovers.filter(
      a => a.expiresAt != null && a.expiresAt < today,
    );
    if (expiredCarryovers.length > 0) {
      const ids = expiredCarryovers.map(a => a.id);
      const writeOffRows = await db
        .select({ allocationId: budgetTransactions.allocationId })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.customerId, customerId),
          eq(budgetTransactions.budgetType, BUDGET_TYPE),
          eq(budgetTransactions.transactionType, "write_off"),
          inArray(budgetTransactions.allocationId, ids),
        ));
      const writtenOff = new Set(writeOffRows.map(r => r.allocationId));
      const stale = expiredCarryovers.filter(a => !writtenOff.has(a.id));
      if (stale.length > 0) {
        const sum = stale.reduce((s, a) => s + a.amountCents, 0);
        reasons.push(
          `(B) ${stale.length} abgelaufene(r) Übertrag ohne write_off (Σ ${euro(sum)}, Jahre ${stale.map(a => a.year).join(",")})`,
        );
        counts.staleCarryover++;
      }
    }

    // (C) Chaining-Verdacht: aktive Carryover für ≥2 aufeinanderfolgende Jahre.
    const years = [...new Set(carryovers.map(a => a.year))].sort((x, y) => x - y);
    const consecutive = years.some((y, i) => i > 0 && y === years[i - 1] + 1);
    if (consecutive) {
      reasons.push(`(C) Chaining-Verdacht: Carryover für aufeinanderfolgende Jahre ${years.join(",")}`);
      counts.chaining++;
    }

    if (reasons.length === 0 && !showAll) continue;

    // Aggregat-Plausibilität (gebodet, nur Anzeige).
    const computed = await calculateAllocatedCents(customerId, BUDGET_TYPE, { asOfDate: today }).catch(() => -1);

    const flag = reasons.length > 0 ? "⚠" : " ";
    if (reasons.length > 0) flagged++;
    console.log(
      `${flag} #${customerId} ${(cust?.name ?? "").slice(0, 26).padEnd(26)} ` +
      `allocated ${euro(computed)} · verfügbar ${euro(availableCents)}` +
      (reasons.length ? ` · ${reasons.join("; ")}` : ""),
    );
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte §45b-Kunden:            ${enabledRows.length}`);
  console.log(`Davon auffällig:                 ${flagged}`);
  console.log(`  (A) negative Verfügbarkeit:    ${counts.negative}`);
  console.log(`  (B) staler Übertrag (Storno):  ${counts.staleCarryover}`);
  console.log(`  (C) Chaining-Verdacht:         ${counts.chaining}`);
  if (flagged === 0) {
    console.log(`\n✓ Kein Kunde zeigt §45b-Carryover-Verfall-Drift.`);
  } else {
    console.log(`\n⚠ ${flagged} Kunde(n) auffällig. (A) sollte mit dem Fix verschwinden; (B)/(C) sind bestehende Reste für den Operator-Storno (out-of-scope #1392).`);
  }
}

// Task-Memory „startup-import-fires-script-main": Entrypoint guarden, damit ein
// versehentlicher Import dieses Skripts in einen Runtime-Pfad nicht main()
// (inkl. process.exit) beim Boot feuert.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
