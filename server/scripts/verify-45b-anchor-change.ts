/**
 * Task #860 — Read-only-Verifikationsreport: §45b-Onboarding-Baseline.
 *
 * Sicherheitsnetz für die Umstellung des §45b-Anker-Verhaltens (Task #860). Der
 * RUNTIME-Pfad (Lesepfad `calculateAllocated45b`, Carryover-Anlage
 * `ensureYearlyCarryover45b`, `/initial-budget`-Write) bodet einen automatisch
 * abgeleiteten Anker (`budget_start_date_origin = 'derived_pflegegrad'`) ab sofort
 * auf den 1.1. des LAUFENDEN Jahres (`floorAutoAnchor45bToCurrentYear`) statt aufs
 * rechtliche Vorjahres-Fenster (`clampDerived45bAnchor`). Das Vorjahr gilt beim
 * Onboarding als aufgebraucht — kein automatischer Vorjahres-Übertrag mehr.
 *
 * Dieser Report ÄNDERT NICHTS (nur `db.select`). Er listet jeden Kunden, dessen
 * automatisch abgeleiteter §45b-Anker sich durch die Umstellung verschiebt, und
 * beziffert die daraus folgende Differenz der bis HEUTE automatisch
 * aufgestockten §45b-Monate (× 131 €). Manuelle Anker (`'manual'`) und Altbestand
 * (NULL) werden NICHT gebodet und tauchen daher nicht als „betroffen" auf.
 *
 * FORWARD-ONLY: Es findet KEINE Datenmigration statt. Bestehende
 * `budget_allocations`-Zeilen werden nicht angefasst; nur künftige Recomputes
 * lesen den gebodeten Anker. Der Report macht sichtbar, bei welchen Kunden sich
 * die berechnete §45b-Verfügbarkeit dadurch ändert.
 *
 * Aufruf:
 *   tsx server/scripts/verify-45b-anchor-change.ts            # alle betroffenen Kunden
 *   tsx server/scripts/verify-45b-anchor-change.ts --all      # auch unveränderte derived-Anker
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customers,
  customerBudgetPreferences,
  customerBudgetTypeSettings,
} from "@shared/schema";
import {
  clampDerived45bAnchor,
  floorAutoAnchor45bToCurrentYear,
  BUDGET_45B_MAX_MONTHLY_CENTS,
} from "@shared/domain/budgets";
import { parseLocalDate, currentYearAndMonth } from "@shared/utils/datetime";

const BUDGET_TYPE = "entlastungsbetrag_45b" as const;

/** Volle, bis (curYear, curMonth) inkl. anrechenbare Monate ab einem Anker. */
function accruedMonths(anchor: string, curYear: number, curMonth: number): number {
  const d = parseLocalDate(anchor);
  const months = (curYear - d.getFullYear()) * 12 + (curMonth - (d.getMonth() + 1)) + 1;
  return Math.max(0, months);
}

async function is45bEnabled(customerId: number): Promise<boolean> {
  const rows = await db
    .select({ enabled: customerBudgetTypeSettings.enabled })
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      eq(customerBudgetTypeSettings.budgetType, BUDGET_TYPE),
      eq(customerBudgetTypeSettings.enabled, true),
      isNull(customerBudgetTypeSettings.validTo),
    ))
    .limit(1);
  return rows.length > 0;
}

async function main() {
  const showAll = process.argv.includes("--all");
  const { year: curYear, month: curMonth } = currentYearAndMonth();

  console.log(`\n=== §45b-Anker-Umstellung · Read-only-Verifikationsreport (Task #860) ===`);
  console.log(`Stichtag: ${curYear}-${String(curMonth).padStart(2, "0")} · Modus: ${showAll ? "ALLE derived-Anker" : "nur betroffene"}\n`);

  // Nur automatisch abgeleitete Anker werden gebodet — manuelle/NULL bleiben.
  const rows = await db
    .select({
      customerId: customerBudgetPreferences.customerId,
      name: customers.name,
      budgetStartDate: customerBudgetPreferences.budgetStartDate,
      origin: customerBudgetPreferences.budgetStartDateOrigin,
    })
    .from(customerBudgetPreferences)
    .innerJoin(customers, eq(customers.id, customerBudgetPreferences.customerId))
    .where(eq(customerBudgetPreferences.budgetStartDateOrigin, "derived_pflegegrad"))
    .orderBy(asc(customerBudgetPreferences.customerId));

  let affected = 0;
  let totalCentsDelta = 0;
  const euro = (c: number) => `${(c / 100).toFixed(2)} €`;

  for (const r of rows) {
    if (!r.budgetStartDate) continue;

    const oldAnchor = clampDerived45bAnchor(r.budgetStartDate, curYear, curMonth);
    const newAnchor = floorAutoAnchor45bToCurrentYear(r.budgetStartDate, curYear);
    const changed = oldAnchor !== newAnchor;

    if (!changed && !showAll) continue;

    const oldMonths = accruedMonths(oldAnchor, curYear, curMonth);
    const newMonths = accruedMonths(newAnchor, curYear, curMonth);
    const centsDelta = (newMonths - oldMonths) * BUDGET_45B_MAX_MONTHLY_CENTS;

    if (changed) {
      affected++;
      totalCentsDelta += centsDelta;
    }

    const enabled = await is45bEnabled(r.customerId);
    const flag = changed ? "Δ" : " ";
    const enabledMark = enabled ? "§45b aktiv" : "§45b inaktiv";

    console.log(
      `${flag} #${r.customerId} ${(r.name ?? "").slice(0, 28).padEnd(28)} ` +
      `roh ${r.budgetStartDate} · alt ${oldAnchor} (${oldMonths}M) → neu ${newAnchor} (${newMonths}M) · ` +
      `Δ Auto-Anspruch ${centsDelta >= 0 ? "+" : ""}${euro(centsDelta)} · ${enabledMark}`,
    );
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte derived-Anker:       ${rows.length}`);
  console.log(`Davon mit Anker-Verschiebung: ${affected}`);
  console.log(`Σ Auto-Anspruchs-Differenz:   ${totalCentsDelta >= 0 ? "+" : ""}${euro(totalCentsDelta)}`);
  if (affected === 0) {
    console.log(`\n✓ Kein Kunde betroffen — die Umstellung verändert keine berechnete §45b-Verfügbarkeit.`);
  } else {
    console.log(`\n⚠ ${affected} Kunde(n) betroffen. Negative Differenz = weniger automatischer §45b-Anspruch (Vorjahr gilt jetzt als aufgebraucht).`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
