/**
 * Task #959 — Read-only-Verifikationsreport: §45b-Verfall & Akkumulations-Cap.
 *
 * Sicherheitsnetz für das universelle §45b-Verfalls-/Übertrags-Modell (Task
 * #959). Der RUNTIME-Lesepfad (`calculateAllocated45b`) bodet die §45b-
 * Verfügbarkeit ab sofort auf das rechtlich relevante Fenster:
 *   - 1. Halbjahr (Mon ≤ 6): Vorjahr (als Übertrag, gedeckelt) + laufendes Jahr,
 *   - ab Juli:               nur das laufende Jahr.
 * Ein weit zurückliegender (manueller/Legacy-)Anker akkumuliert damit KEINE
 * jahrelang nicht-verfallenden Monatsbeträge mehr, und ein Vorjahres-Startwert
 * (`initial_balance`) wird nach Ablauf des Fensters nicht mehr mitgezählt.
 *
 * Dieser Report ÄNDERT NICHTS (nur `db.select` + reiner Lesepfad). Er listet je
 * §45b-aktivem Kunden:
 *   - die aktuell BERECHNETE §45b-Verfügbarkeit (Aggregat, Stichtag heute),
 *   - die rechtliche OBERGRENZE für das aktuelle Fenster,
 *   - und – falls die Berechnung die Obergrenze überschreitet – die wahrschein-
 *     liche Ursache, gruppiert nach Lücke 1–4:
 *       (1) Legacy/Manueller Anker mit Über-Akkumulation (Monate vor dem Fenster),
 *       (2) Vorjahres-Startwert (`initial_balance`) jenseits des Verfalls-Bodens,
 *       (4) abgelaufenes Jahr mit Restguthaben ohne materialisierten Carryover.
 * Lücke (3) – zu hoher Startwert/Übertrag bei der Anlage – wird ab sofort an der
 * `/initial-budget`-Route abgewiesen und taucht daher hier nicht mehr als Drift
 * neu angelegter Kunden auf.
 *
 * FORWARD-ONLY: Es findet KEINE Datenmigration statt. Bestehende
 * `budget_allocations`-Zeilen werden nicht angefasst; künftige Recomputes lesen
 * den gebodeten Anker und der nächste `syncCarryoverAndExpiry`-Lauf
 * materialisiert den Verfall als sichtbaren `write_off`.
 *
 * Aufruf:
 *   tsx server/scripts/verify-45b-consistency.ts          # nur Kunden mit Drift
 *   tsx server/scripts/verify-45b-consistency.ts --all     # alle §45b-Kunden
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customers,
  budgetAllocations,
  customerBudgetTypeSettings,
} from "@shared/schema";
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";
import {
  eligible45bCarryoverMonths,
  max45bCarryoverCents,
} from "@shared/domain/budget/carryover-eligibility";
import { todayISO, currentYearAndMonth } from "@shared/utils/datetime";
import { calculateAllocatedCents } from "../storage/budget/allocation-storage";
import { getEarliestCareLevelStart } from "../storage/customer-mgmt/care-level";

const BUDGET_TYPE = "entlastungsbetrag_45b" as const;
const euro = (c: number) => `${(c / 100).toFixed(2)} €`;

/**
 * Rechtliche Obergrenze der §45b-Verfügbarkeit für das aktuelle Fenster (Cent):
 *   - laufendes Jahr: Monate Januar..curMonth × Monatsaufstockung,
 *   - im 1. Halbjahr zusätzlich der gedeckelte Vorjahres-Übertrag
 *     (`eligible45bCarryoverMonths` × Monatsaufstockung).
 * `accrualAnchorISO` (frühester Pflegegrad-Beginn) deckelt beide Anteile auf die
 * tatsächlich berechtigten Monate.
 */
function legalCeilingCents(
  accrualAnchorISO: string | null,
  curYear: number,
  curMonth: number,
): number {
  let anchorYear = curYear;
  let anchorMonth = 1;
  if (accrualAnchorISO) {
    const [y, m] = accrualAnchorISO.split("-").map(Number);
    if (y && m) {
      anchorYear = y;
      anchorMonth = m;
    }
  }

  // Laufendes Jahr: ab max(Januar, Anker-Monat falls Anker im laufenden Jahr).
  const currentStartMonth = anchorYear >= curYear ? Math.max(1, anchorMonth) : 1;
  const currentMonths = anchorYear > curYear
    ? 0
    : Math.max(0, curMonth - currentStartMonth + 1);

  let ceiling = currentMonths * BUDGET_45B_MAX_MONTHLY_CENTS;

  // Vorjahres-Übertrag nur im 1. Halbjahr und nur, wenn der Anker das Vorjahr
  // (oder früher) erreicht.
  if (curMonth <= 6) {
    const eligibleMonths = eligible45bCarryoverMonths(accrualAnchorISO, curYear);
    ceiling += max45bCarryoverCents(eligibleMonths);
  }

  return ceiling;
}

async function main() {
  const showAll = process.argv.includes("--all");
  const today = todayISO();
  const { year: curYear, month: curMonth } = currentYearAndMonth();
  const expiryFloorYear = curMonth <= 6 ? curYear - 1 : curYear;

  console.log(`\n=== §45b-Verfall & Cap · Read-only-Verifikationsreport (Task #959) ===`);
  console.log(`Stichtag: ${today} · Fenster-Boden-Jahr: ${expiryFloorYear} · Modus: ${showAll ? "ALLE §45b-Kunden" : "nur Drift"}\n`);

  const enabledRows = await db
    .selectDistinct({ customerId: customerBudgetTypeSettings.customerId })
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.budgetType, BUDGET_TYPE),
      eq(customerBudgetTypeSettings.enabled, true),
      isNull(customerBudgetTypeSettings.validTo),
    ))
    .orderBy(asc(customerBudgetTypeSettings.customerId));

  let drift = 0;
  let totalOverageCents = 0;
  const gapCounts = { gap1: 0, gap2: 0, gap4: 0 };

  for (const { customerId } of enabledRows) {
    const [cust] = await db
      .select({ name: customers.name })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);

    const allocs = await db
      .select({
        source: budgetAllocations.source,
        year: budgetAllocations.year,
        amountCents: budgetAllocations.amountCents,
      })
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, BUDGET_TYPE),
        isNull(budgetAllocations.deletedAt),
      ));

    const anchor = await getEarliestCareLevelStart(customerId).catch(() => null);
    const computed = await calculateAllocatedCents(customerId, BUDGET_TYPE, { asOfDate: today });
    const ceiling = legalCeilingCents(anchor, curYear, curMonth);
    const overage = computed - ceiling;
    const hasDrift = overage > 0;

    if (!hasDrift && !showAll) continue;

    // Ursachen-Diagnose (nur Hinweise; die Berechnung selbst ist bereits gebodet).
    const reasons: string[] = [];
    const carryoverYears = allocs.filter(a => a.source === "carryover").map(a => a.year);
    const latestCarryoverYear = carryoverYears.length ? Math.max(...carryoverYears) : null;
    const ibFloorYear = Math.max(expiryFloorYear, latestCarryoverYear ?? 0);

    const staleIb = allocs.filter(a => a.source === "initial_balance" && a.year < ibFloorYear);
    if (staleIb.length > 0) {
      reasons.push(`(2) ${staleIb.length} Vorjahres-Startwert(e) < Boden ${ibFloorYear}`);
      if (hasDrift) gapCounts.gap2++;
    }

    const elapsedYearsWithLeftover = allocs
      .filter(a => (a.source === "initial_balance" || a.source === "monthly" || a.source === "monthly_auto")
        && a.year < curYear)
      .map(a => a.year);
    const missingCarryoverYears = [...new Set(elapsedYearsWithLeftover)]
      .filter(y => !carryoverYears.includes(y + 1));
    if (missingCarryoverYears.length > 0) {
      reasons.push(`(4) Jahr(e) ohne Carryover: ${missingCarryoverYears.join(", ")}`);
      if (hasDrift) gapCounts.gap4++;
    }

    if (hasDrift && reasons.length === 0) {
      reasons.push(`(1) Legacy/Manueller Anker — Über-Akkumulation vor dem Fenster`);
      gapCounts.gap1++;
    }

    if (hasDrift) {
      drift++;
      totalOverageCents += overage;
    }

    const flag = hasDrift ? "Δ" : " ";
    console.log(
      `${flag} #${customerId} ${(cust?.name ?? "").slice(0, 26).padEnd(26)} ` +
      `Anker ${anchor ?? "—"} · berechnet ${euro(computed)} · Obergrenze ${euro(ceiling)} · ` +
      `Δ ${overage >= 0 ? "+" : ""}${euro(overage)}` +
      (reasons.length ? ` · ${reasons.join("; ")}` : ""),
    );
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte §45b-Kunden:        ${enabledRows.length}`);
  console.log(`Davon mit Über-Verfügbarkeit: ${drift}`);
  console.log(`  Lücke (1) Legacy/Manuell:   ${gapCounts.gap1}`);
  console.log(`  Lücke (2) Vorjahres-IB:     ${gapCounts.gap2}`);
  console.log(`  Lücke (4) fehlender Carryover: ${gapCounts.gap4}`);
  console.log(`Σ Über-Verfügbarkeit:        ${totalOverageCents >= 0 ? "+" : ""}${euro(totalOverageCents)}`);
  if (drift === 0) {
    console.log(`\n✓ Kein Kunde zeigt mehr §45b als rechtlich möglich.`);
  } else {
    console.log(`\n⚠ ${drift} Kunde(n) über der Obergrenze. Ein Recompute + syncCarryoverAndExpiry-Lauf materialisiert den Verfall als write_off.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
