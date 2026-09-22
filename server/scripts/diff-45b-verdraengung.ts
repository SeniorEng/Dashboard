/**
 * P1 `6hXp9qMrXH2WGVVG`, Schritt 2 — Wirkung der Startwert-Verdrängung messen.
 *
 * ── Warum dieses Skript nichts nachrechnet ──────────────────────────────
 * Ein erster Anlauf hat `allocatedCents` in SQL nachgebaut und lieferte
 * negative SOLL-Werte. Der blinde Fleck ist strukturell, nicht handwerklich:
 *
 *   allocatedCents = totalCalculated + initialBalanceTotal + carryoverTotal
 *                    (+ manual_adjustment)
 *
 * `totalCalculated` ist die **virtuelle Monatsaufstockung** — zur Laufzeit aus
 * dem §45b-Anker gerechnet, **ohne jede Zeile in `budget_allocations`**. Wer
 * über die Tabelle summiert, übersieht bei jedem Kunden mit Aufstockung den
 * größten Posten. Dazu `manual_adjustment` als vierte Quelle, deren Filter je
 * nach Aufrufmodus zwischen `year` und `valid_from` wechselt, und die
 * IB-Supersession, die Startwerte quer zum Zeitfenster entfernt.
 *
 * Dieses Skript ruft deshalb **dieselbe Funktion zweimal** auf — einmal mit
 * heutiger Regel, einmal mit `resetDisplacesAllSources` — und weist die
 * Differenz aus. Per Konstruktion deckungsgleich mit dem, was die App anzeigt.
 *
 * ── Warum `accrualFloorDate` mit ausgegeben wird ────────────────────────
 * Die Verdrängung hängt in `carryoverCounted`, und das Prädikat speist DREI
 * Verbraucher: `carryoverTotal` (gewollt), `supersededIbYears` und
 * `latestValidCarryoverYear` — den `allocStart`-Shift. Der dritte kann in die
 * GEGENRICHTUNG wirken: weniger Shift heißt mehr aufgestockte Monate, also ein
 * höherer Anspruch. Ohne `accrualFloorDate` in der Ausgabe wäre eine Differenz
 * nicht von dieser Nebenwirkung zu unterscheiden.
 *
 * ── Rein lesend ────────────────────────────────────────────────────────
 * Nur `db.select` und reine Read-Funktionen. Schreibt nichts, auch keine
 * Hilfstabellen.
 *
 * Aufruf:
 *   tsx server/scripts/diff-45b-verdraengung.ts
 *   tsx server/scripts/diff-45b-verdraengung.ts --all          # auch Kunden ohne Differenz
 *   tsx server/scripts/diff-45b-verdraengung.ts 2026-06-15 2026-07-15
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations } from "@shared/schema";
import {
  calculateAllocatedCents,
  getExcluded45bConsumption,
} from "../storage/budget/allocation-storage";
import { readBudgetTypeSettings } from "../storage/budget/preferences-storage";
import { todayISO } from "@shared/utils/datetime";

const BUDGET_TYPE = "entlastungsbetrag_45b";

function euro(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  const args = process.argv.slice(2);
  const alle = args.includes("--all");
  const stichtage = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (stichtage.length === 0) stichtage.push("2026-06-15", "2026-07-15", todayISO());

  // Alle Kunden mit AKTIVER `initial_balance`-Zeile. Bewusst nicht die
  // Achter-Liste aus dem Code-Kommentar (`57, 89, 94, …`) — die ist veraltet
  // und beschreibt ohnehin Kunden MIT Reset, nicht Kunden MIT Schaden.
  const zeilen = await db
    .select({ customerId: budgetAllocations.customerId })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      eq(budgetAllocations.source, "initial_balance"),
      isNull(budgetAllocations.deletedAt),
    ));
  const kunden = [...new Set(zeilen.map(z => z.customerId))].sort((a, b) => a - b);

  console.log(`Kunden mit aktiver initial_balance-Zeile: ${kunden.length}`);
  console.log(`Stichtage: ${stichtage.join(", ")}`);
  console.log("");

  let betroffen = 0;
  let summeDifferenz = 0;

  for (const customerId of kunden) {
    const typeSettings = await readBudgetTypeSettings(
      customerId, { kind: "forDate", asOfDate: todayISO() },
    );

    const zeilenAus: string[] = [];
    for (const asOfDate of stichtage) {
      const heute = await calculateAllocatedCents(customerId, BUDGET_TYPE, { asOfDate });
      const neu = await calculateAllocatedCents(
        customerId, BUDGET_TYPE, { asOfDate, resetDisplacesAllSources: true },
      );

      // Die Ausschlussliste je Regel — Cowork braucht sie für Schritt 3.
      // Verbrauch gegen eine ausgeschlossene Allocation ist ABSICHTLICH
      // neutralisiert (Symmetrie-Anker); wer ihn als fehlenden Abzug zählt,
      // findet eine Lücke, die eine Zusage ist.
      const exHeute = await getExcluded45bConsumption(customerId, asOfDate, db, typeSettings);
      const exNeu = await getExcluded45bConsumption(
        customerId, asOfDate, db, typeSettings, { resetDisplacesAllSources: true },
      );
      const zusaetzlichAusgeschlossen = exNeu.excludedSpecialAllocationIds
        .filter(id => !exHeute.excludedSpecialAllocationIds.includes(id));

      const diff = neu - heute;
      if (diff !== 0 || alle) {
        zeilenAus.push(
          `    ${asOfDate}  heute ${euro(heute).padStart(10)}  neu ${euro(neu).padStart(10)}`
          + `  Differenz ${euro(diff).padStart(10)}`
          + `  | zusätzlich ausgeschlossen: [${zusaetzlichAusgeschlossen.join(", ") || "—"}]`
          + `  | Verbrauch-Korrektur ${euro(exNeu.excludedConsumedNetCents - exHeute.excludedConsumedNetCents)}`,
        );
      }
      if (diff !== 0) summeDifferenz += diff;
    }

    if (zeilenAus.length > 0) {
      betroffen++;
      console.log(`Kunde ${customerId}`);
      zeilenAus.forEach(z => console.log(z));
    }
  }

  console.log("");
  console.log(`Kunden mit Differenz: ${betroffen} von ${kunden.length}`);
  console.log(`Summe der Differenzen über alle Stichtage: ${euro(summeDifferenz)} €`);
  console.log("");
  console.log("Hinweis: die Summe addiert MEHRERE Stichtage desselben Kunden und ist");
  console.log("deshalb KEIN Schadensbetrag — sie zeigt nur, wo die Regel greift.");
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
