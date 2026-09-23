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
 * ── Drei Groessen, nicht zwei ───────────────────────────────────────────
 * Schritt 2 verlangt Anspruch, Verbrauch UND **Verfuegbarkeit**. Die ersten
 * beiden standen hier von Anfang an; die dritte fehlte.
 *
 * Sie laesst sich NICHT aus den beiden anderen ableiten: `availableCents`
 * kommt aus `netAvailable45bAt` und traegt Floor, Holds und die
 * Exklusions-Korrektur, die `Anspruch − Verbrauch` nicht kennt. Wer sie
 * nachrechnet, baut den Reader nach — genau der Fehler, an dem der erste
 * Mess-Anlauf gescheitert ist, nur eine Ebene hoeher.
 *
 * Dazu die Probe auf Vorbedingung 1: `readBudget45bFifoBreakdown` mit
 * scharfem Flag darf auf echten Daten **keinen negativen Topf** liefern. Im
 * Test ist das `SQ-1`; hier ist es die Kontrolle am Bestand, denn ein
 * negativer Topf verschwindet im Client ueber `p.allocatedCents > 0`.
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
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations } from "@shared/schema";
import {
  calculateAllocatedCents,
  getExcluded45bConsumption,
  read45bAllocationDiagnostics,
} from "../storage/budget/allocation-storage";
import { readBudgetTypeSettings } from "../storage/budget/preferences-storage";
import { netAvailable45bAt } from "../storage/budget/net-available-45b";
import { readBudget45bFifoBreakdown } from "../storage/budget/fifo-breakdown";
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

  /**
   * Die Annahme, auf der die VD-5-Verengung ruht — hier geprueft, nicht
   * vorausgesetzt.
   *
   * Verdraengt wird nur, wenn `validFrom` UND `year` vor dem Reset liegen.
   * Auf konsistenten Daten (`year === Jahr(valid_from)`) ist die zweite
   * Bedingung wirkungslos, die Verengung aendert also nichts. Weicht auch nur
   * EINE Zeile ab, kann sie wirken — und dann ist ein Vergleich mit einem
   * frueheren Mess-Lauf nicht mehr aussagekraeftig.
   *
   * Das steht hier, weil genau diese Sorte Annahme bei VD-5 versagt hat: die
   * Entwarnung war hergeleitet und falsch. Eine Herleitung, die man billig
   * pruefen kann, gehoert geprueft.
   */
  const [{ abweichend }] = await db
    .select({ abweichend: sql<number>`count(*)::int` })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
      sql`${budgetAllocations.year} <> EXTRACT(YEAR FROM ${budgetAllocations.validFrom}::date)`,
    ));
  console.log(`Uebertraege mit year <> Jahr(valid_from): ${abweichend}`);
  if (abweichend > 0) {
    console.log("  \u26a0 Die VD-5-Verengung KANN hier wirken. Ein Vergleich mit einem");
    console.log("    Mess-Lauf vor dem Fix ist dann nicht mehr aussagekraeftig.");
  } else {
    console.log("  Konsistent — die VD-5-Verengung ist auf diesem Bestand wirkungslos.");
  }
  console.log("");
  console.log(`Kunden mit aktiver initial_balance-Zeile: ${kunden.length}`);
  console.log(`Stichtage: ${stichtage.join(", ")}`);
  console.log("");

  let betroffen = 0;
  let summeDifferenz = 0;
  let summeVerfuegbarkeit = 0;
  const kundenMitNegativemTopf = new Set<number>();

  for (const customerId of kunden) {
    const zeilenAus: string[] = [];
    for (const asOfDate of stichtage) {
      /**
       * Die Typ-Einstellungen JE STICHTAG aufloesen, nicht einmal fuer heute.
       *
       * Die erste Fassung rief `readBudgetTypeSettings(..., todayISO())` einmal
       * vor der Schleife — und `calculateAllocatedCents` ohne `_typeSettings`
       * loest intern ebenfalls mit `todayISO()` auf. Zwei der drei
       * Vorgabe-Stichtage liegen in der VERGANGENHEIT; fuer jeden Kunden mit
       * einem Phasenwechsel seither waeren die absoluten Spalten dann NICHT
       * die Zahlen, die die App damals gezeigt hat — der Docblock behauptet
       * aber genau das.
       *
       * Die Differenz waere gueltig geblieben (beide Seiten dieselben
       * Settings), die absoluten Spalten nicht. Und zitiert werden am Ende
       * die absoluten. Das ist die `todayISO()`-vs-`asOf`-Falle aus CLAUDE.md,
       * diesmal im Messgeraet (Gate 2 zu #163, S5).
       */
      const typeSettings = await readBudgetTypeSettings(
        customerId, { kind: "forDate", asOfDate },
      );
      const heute = await calculateAllocatedCents(
        customerId, BUDGET_TYPE, { asOfDate }, undefined, undefined, typeSettings,
      );
      const neu = await calculateAllocatedCents(
        customerId, BUDGET_TYPE, { asOfDate, resetDisplacesAllSources: true },
        undefined, undefined, typeSettings,
      );

      // S4 — die Nebenwirkung, die der Docblock oben begruendet, jetzt auch
      // WIRKLICH sichtbar: verschiebt das Flag ueber `latestValidCarryoverYear`
      // den `allocStart`, aendert sich `accrualFloorDate`. Ohne diese Spalte
      // ist eine Differenz nicht von der Nebenwirkung zu unterscheiden.
      const diagHeute = await read45bAllocationDiagnostics(
        customerId, { asOfDate }, undefined, typeSettings,
      );
      const diagNeu = await read45bAllocationDiagnostics(
        customerId, { asOfDate, resetDisplacesAllSources: true }, undefined, typeSettings,
      );
      const floorVerschoben = diagHeute.accrualFloorDate !== diagNeu.accrualFloorDate;

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
      // N3 — auch die GEGENRICHTUNG. Nach der Herleitung kann eine ID die
      // Liste unter dem Flag nicht verlassen; die Herleitung steht aber auf
      // der Annahme `carryover.year === Jahr(carryover.validFrom)`. Kippt sie,
      // soll es die Messung sehen und nicht stillschweigend uebergehen.
      const wiederAufgenommen = exHeute.excludedSpecialAllocationIds
        .filter(id => !exNeu.excludedSpecialAllocationIds.includes(id));

      // Die dritte Groesse: was am Ende auf der Karte steht.
      const verfHeute = (await netAvailable45bAt(
        customerId, asOfDate, { typeSettings },
      )).availableCents;
      const verfNeu = (await netAvailable45bAt(
        customerId, asOfDate, { typeSettings, resetDisplacesAllSources: true },
      )).availableCents;

      // Probe auf Vorbedingung 1 am echten Bestand: kein negativer Topf.
      const breakdown = await readBudget45bFifoBreakdown(customerId, asOfDate, {
        resetDisplacesAllSources: true,
      });
      const negativeToepfe = breakdown.pots
        .filter(t => t.allocatedCents < 0)
        .map(t => `${t.potType}=${euro(t.allocatedCents)}`);

      const diff = neu - heute;
      const diffVerf = verfNeu - verfHeute;
      if (diff !== 0 || diffVerf !== 0 || negativeToepfe.length > 0
          || floorVerschoben || wiederAufgenommen.length > 0 || alle) {
        zeilenAus.push(
          `    ${asOfDate}  Anspruch ${euro(heute).padStart(10)} → ${euro(neu).padStart(10)}`
          + ` (${euro(diff).padStart(10)})`
          + `  | Verfügbar ${euro(verfHeute).padStart(10)} → ${euro(verfNeu).padStart(10)}`
          + ` (${euro(diffVerf).padStart(10)})`
          + (negativeToepfe.length > 0
              ? `  | ⚠ NEGATIVER TOPF: ${negativeToepfe.join(", ")}`
              : "")
          + `  | zusätzlich ausgeschlossen: [${zusaetzlichAusgeschlossen.join(", ") || "—"}]`
          + (wiederAufgenommen.length > 0 ? `  | ⚠ WIEDER AUFGENOMMEN: [${wiederAufgenommen.join(", ")}]` : "")
          + `  | Verbrauch-Korrektur ${euro(exNeu.excludedConsumedNetCents - exHeute.excludedConsumedNetCents)}`
          + `  | accrualFloor ${diagHeute.accrualFloorDate ?? "—"}`
          + (floorVerschoben ? ` ⚠→ ${diagNeu.accrualFloorDate ?? "—"}` : "")
          + `  | resetCutoff ${diagNeu.resetAnchor?.cutoffDate ?? "—"}`,
        );
      }
      if (diff !== 0) summeDifferenz += diff;
      if (diffVerf !== 0) summeVerfuegbarkeit += diffVerf;
      if (negativeToepfe.length > 0) kundenMitNegativemTopf.add(customerId);
    }

    if (zeilenAus.length > 0) {
      betroffen++;
      console.log(`Kunde ${customerId}`);
      zeilenAus.forEach(z => console.log(z));
    }
  }

  console.log("");
  console.log(`Kunden mit Differenz: ${betroffen} von ${kunden.length}`);
  console.log(`Summe der ANSPRUCHS-Differenzen über alle Stichtage: ${euro(summeDifferenz)} €`);
  console.log(`Summe der VERFÜGBARKEITS-Differenzen über alle Stichtage: ${euro(summeVerfuegbarkeit)} €`);
  console.log("");
  if (kundenMitNegativemTopf.size === 0) {
    console.log("Kein negativer Topf bei scharfem Flag — Vorbedingung 1 trägt auf diesem Bestand.");
  } else {
    console.log(`⚠ ${kundenMitNegativemTopf.size} Kunde(n) mit NEGATIVEM Topf: `
      + `${[...kundenMitNegativemTopf].join(", ")}`);
    console.log("  Vorbedingung 1 trägt hier NICHT. Die Zahlen oben nicht verwenden,");
    console.log("  bevor das erklärt ist — im Client verschwindet so ein Topf lautlos.");
  }
  console.log("");
  console.log("Hinweis: die Summe addiert MEHRERE Stichtage desselben Kunden und ist");
  console.log("deshalb KEIN Schadensbetrag — sie zeigt nur, wo die Regel greift.");
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
