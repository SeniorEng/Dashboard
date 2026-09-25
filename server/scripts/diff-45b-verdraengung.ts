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
    // Nur ZAEHLEN reicht nicht: `+1` ist die dokumentierte Zieljahr-Semantik
    // (ein Uebertrag fuer Zieljahr T wird im Jahr T-1 materialisiert), alles
    // andere ist ein Datenbefund. `carryoverTargetYear`
    // (shared/domain/budget/halfyear-45b.ts) haelt ausdruecklich fest, dass
    // offen ist, welches der beiden Modelle dem Produktions-Roll entspricht.
    const verteilung = await db
      .select({
        delta: sql<number>`(${budgetAllocations.year} - EXTRACT(YEAR FROM ${budgetAllocations.validFrom}::date))::int`,
        anzahl: sql<number>`count(*)::int`,
      })
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.budgetType, BUDGET_TYPE),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
        sql`${budgetAllocations.year} <> EXTRACT(YEAR FROM ${budgetAllocations.validFrom}::date)`,
      ))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    for (const v of verteilung) {
      const deutung = v.delta === 1
        ? "dokumentierte Zieljahr-Semantik (Uebertrag fuer T, materialisiert in T-1)"
        : "NICHT durch die Zieljahr-Semantik erklaert — Datenbefund";
      console.log(`    year − Jahr(valid_from) = ${v.delta >= 0 ? "+" : ""}${v.delta}: `
        + `${v.anzahl} Zeile(n) — ${deutung}`);
    }
  }
  if (abweichend > 0) {
    console.log("  \u26a0 Die VD-5-Verengung KANN hier wirken. Ein Vergleich mit einem");
    console.log("    Mess-Lauf vor dem Fix ist dann nicht mehr aussagekraeftig.");
  } else {
    console.log("  Konsistent — die VD-5-Verengung ist auf diesem Bestand wirkungslos.");
  }
  /**
   * ── Drei Bestandsfragen VOR dem Scharfschalten ──────────────────────────
   * Alle drei waren bisher abgeleitet. Hier werden sie gemessen.
   */

  // (1) 0-EUR-Startwerte. Nach Alriks Entscheidung vom 22.09.2026 ist 0 eine
  // festgestellte Null, und mit `<=` verdraengt eine Inventur zum 01.01. einen
  // Uebertrag, der am selben Tag beginnt. Zusammen: der Uebertrag ist ganz weg.
  const nullStartwerte = await db
    .select({ customerId: budgetAllocations.customerId, validFrom: budgetAllocations.validFrom })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      eq(budgetAllocations.source, "initial_balance"),
      eq(budgetAllocations.amountCents, 0),
      isNull(budgetAllocations.deletedAt),
    ));
  console.log("");
  if (nullStartwerte.length === 0) {
    console.log("0-EUR-Startwerte: keine.");
  } else {
    console.log(`\u26a0 0-EUR-Startwerte: ${nullStartwerte.length} Zeile(n) bei `
      + `${new Set(nullStartwerte.map(z => z.customerId)).size} Kunde(n):`);
    for (const z of nullStartwerte.slice(0, 20)) {
      console.log(`    Kunde ${z.customerId}, ab ${z.validFrom}`);
    }
    console.log("  Dort heisst die Verdraengung nicht „Startwert statt Uebertrag\",");
    console.log("  sondern „nichts statt Uebertrag\" — vor einer Umbuchung einzeln ansehen.");
  }

  /**
   * (2) Startwert UND Uebertrag aus DEMSELBEN Anlage-Vorgang.
   *
   * `budget-initial-setup.ts` schreibt beide in EINER Transaktion (Wizard und
   * `POST /initial-budget`). Dort war „beides zusammen" vermutlich gemeint, und
   * der Flip aendert das Budget, ohne dass jemand eine Verdraengung eingegeben
   * haette.
   *
   * Erkennungsmerkmal ist der Zeitstempel auf Sekundengenauigkeit — eine
   * HEURISTIK, keine Transaktions-ID. Zwei unabhaengige Eingaben in derselben
   * Sekunde saehen gleich aus.
   *
   * **Deshalb die Gegenprobe daneben:** wie viele Startwert-Uebertrags-Paare
   * gibt es ueberhaupt, und wie viele davon treffen dieselbe Sekunde? Treffen
   * fast alle, ist die Heuristik belastbar. Treffen wenige, sagt sie wenig —
   * und dann darf die Liste nicht als „das sind die Faelle" gelesen werden.
   */
  const paare = await db
    .select({ customerId: budgetAllocations.customerId })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      isNull(budgetAllocations.deletedAt),
      sql`${budgetAllocations.source} IN ('initial_balance', 'carryover')`,
    ))
    .groupBy(budgetAllocations.customerId)
    .having(sql`count(DISTINCT ${budgetAllocations.source}) > 1`);

  const gleichzeitig = await db
    .select({
      customerId: budgetAllocations.customerId,
      zeitpunkt: sql<string>`date_trunc('second', ${budgetAllocations.createdAt})::text`,
      quellen: sql<string>`string_agg(DISTINCT ${budgetAllocations.source}, ',' ORDER BY ${budgetAllocations.source})`,
      betraege: sql<string>`string_agg(${budgetAllocations.amountCents}::text, ' + ')`,
    })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      isNull(budgetAllocations.deletedAt),
      sql`${budgetAllocations.source} IN ('initial_balance', 'carryover')`,
    ))
    .groupBy(budgetAllocations.customerId, sql`date_trunc('second', ${budgetAllocations.createdAt})`)
    .having(sql`count(DISTINCT ${budgetAllocations.source}) > 1`);

  const kundenMitPaar = paare.length;
  const kundenGleichzeitig = new Set(gleichzeitig.map(z => z.customerId)).size;
  console.log("");
  console.log(`Kunden mit Startwert UND Uebertrag: ${kundenMitPaar}`);
  console.log(`  davon aus derselben Sekunde (= ein Anlage-Vorgang): ${kundenGleichzeitig}`);
  if (kundenMitPaar > 0) {
    const quote = Math.round((kundenGleichzeitig / kundenMitPaar) * 100);
    console.log(`  Trefferquote der Heuristik: ${quote}%`);
    if (quote >= 80) {
      console.log("  → belastbar: fast alle Paare stammen aus einem Vorgang.");
    } else if (kundenGleichzeitig === 0) {
      console.log("  → die Heuristik findet NICHTS. Die Paare sind getrennt entstanden,");
      console.log("    oder der Zeitstempel taugt nicht als Merkmal. Nicht als „keine");
      console.log("    Faelle\" lesen.");
    } else {
      console.log("  → SCHWACH: die Liste unten ist eine Teilmenge, kein Befund.");
      console.log("    Die uebrigen Paare einzeln ansehen.");
    }
  }
  for (const z of gleichzeitig.slice(0, 25)) {
    console.log(`    Kunde ${z.customerId}  ${z.zeitpunkt}  [${z.quellen}]  ${z.betraege} ct`);
  }

  /**
   * (3) Umfang des Mischbestands nach dem Deploy.
   *
   * `ensureYearlyCarryover45b` schreibt mit `onConflictDoNothing`. Zeilen von
   * VOR dem Flip tragen den alten (hoeheren) Betrag und werden nicht
   * korrigiert; danach entstehende tragen den neuen.
   */
  const jetzt = new Date().getFullYear();
  const [{ folgejahr }] = await db
    .select({ folgejahr: sql<number>`count(*)::int` })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
      sql`${budgetAllocations.year} > ${jetzt}`,
    ));
  console.log("");
  console.log(`Bereits materialisierte Folgejahres-Uebertraege (year > ${jetzt}): ${folgejahr}`);
  if (folgejahr > 0) {
    console.log("  Diese Betraege korrigiert `ensureYearlyCarryover45b` NICHT nach");
    console.log("  (`onConflictDoNothing`) — nach dem Flip Mischbestand.");
  }

  console.log("");
  console.log(`Kunden mit aktiver initial_balance-Zeile: ${kunden.length}`);
  console.log(`Stichtage: ${stichtage.join(", ")}`);
  console.log("");

  let betroffen = 0;
  const geaendert = new Set<number>();
  const anspruchGeaendert = new Set<number>();
  const verfuegbarGeaendert = new Set<number>();
  let summeDifferenz = 0;
  let summeVerfuegbarkeit = 0;
  const kundenMitNegativemTopf = new Set<number>();
  const kundenMitBestandsTopf = new Set<number>();

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
      // Seit dem Flip ist die neue Regel der Standard. Die „heute"-Seite
      // rechnet die ALTE Regel deshalb AUSDRÜCKLICH (`false`) — ohne Angabe
      // verglichen beide Seiten dasselbe und jede Differenz wäre 0.
      const heute = await calculateAllocatedCents(
        customerId, BUDGET_TYPE, { asOfDate, resetDisplacesAllSources: false }, undefined, undefined, typeSettings,
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
        customerId, { asOfDate, resetDisplacesAllSources: false }, undefined, typeSettings,
      );
      const diagNeu = await read45bAllocationDiagnostics(
        customerId, { asOfDate, resetDisplacesAllSources: true }, undefined, typeSettings,
      );
      const floorVerschoben = diagHeute.accrualFloorDate !== diagNeu.accrualFloorDate;

      // Die Ausschlussliste je Regel — Cowork braucht sie für Schritt 3.
      // Verbrauch gegen eine ausgeschlossene Allocation ist ABSICHTLICH
      // neutralisiert (Symmetrie-Anker); wer ihn als fehlenden Abzug zählt,
      // findet eine Lücke, die eine Zusage ist.
      const exHeute = await getExcluded45bConsumption(customerId, asOfDate, db, typeSettings, { resetDisplacesAllSources: false });
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
        customerId, asOfDate, { typeSettings, resetDisplacesAllSources: false },
      )).availableCents;
      const verfNeu = (await netAvailable45bAt(
        customerId, asOfDate, { typeSettings, resetDisplacesAllSources: true },
      )).availableCents;

      /**
       * Probe auf Vorbedingung 1 — BEIDSEITIG.
       *
       * Die erste Fassung rechnete den Breakdown nur MIT Flag und meldete
       * „NEGATIVER TOPF, Zahlen nicht verwenden". Am Prod-Lauf vom 23.09.2026
       * hat sie bei Kunde 164 gegriffen — und konnte die entscheidende Frage
       * nicht beantworten: liegt es an der Verdraengung oder war es vorher
       * schon so?
       *
       * Eine Warnung, die das nicht unterscheidet, schickt die Messung zurueck
       * an den Anfang. Deshalb jetzt beide Seiten: nur ein Topf, der OHNE Flag
       * nicht negativ ist, geht auf die Verdraengung.
       */
      const bdOhne = await readBudget45bFifoBreakdown(customerId, asOfDate, { resetDisplacesAllSources: false });
      const bdMit = await readBudget45bFifoBreakdown(customerId, asOfDate, {
        resetDisplacesAllSources: true,
      });
      const negOhne = bdOhne.pots.filter(t => t.allocatedCents < 0);
      const negMit = bdMit.pots.filter(t => t.allocatedCents < 0);
      const negativeToepfe = negMit.map(t => `${t.potType}=${euro(t.allocatedCents)}`);
      // NEU durch die Verdraengung — das ist der Fall, der blockiert.
      const negativNeu = negMit.filter(
        t => !negOhne.some(o => o.potType === t.potType),
      ).map(t => `${t.potType}=${euro(t.allocatedCents)}`);

      const diff = neu - heute;
      const diffVerf = verfNeu - verfHeute;
      if (diff !== 0 || diffVerf !== 0 || negativeToepfe.length > 0
          || floorVerschoben || wiederAufgenommen.length > 0 || alle) {
        zeilenAus.push(
          `    ${asOfDate}  Anspruch ${euro(heute).padStart(10)} → ${euro(neu).padStart(10)}`
          + ` (${euro(diff).padStart(10)})`
          + `  | Verfügbar ${euro(verfHeute).padStart(10)} → ${euro(verfNeu).padStart(10)}`
          + ` (${euro(diffVerf).padStart(10)})`
          + (negativNeu.length > 0
              ? `  | ⛔ NEGATIVER TOPF DURCH DIE VERDRÄNGUNG: ${negativNeu.join(", ")}`
              : negativeToepfe.length > 0
                ? `  | ℹ negativer Topf, aber AUCH OHNE Flag (Bestand): ${negativeToepfe.join(", ")}`
                : "")
          + `  | zusätzlich ausgeschlossen: [${zusaetzlichAusgeschlossen.join(", ") || "—"}]`
          + (wiederAufgenommen.length > 0 ? `  | ⚠ WIEDER AUFGENOMMEN: [${wiederAufgenommen.join(", ")}]` : "")
          + `  | Verbrauch-Korrektur ${euro(exNeu.excludedConsumedNetCents - exHeute.excludedConsumedNetCents)}`
          + `  | accrualFloor ${diagHeute.accrualFloorDate ?? "—"}`
          + (floorVerschoben ? ` ⚠→ ${diagNeu.accrualFloorDate ?? "—"}` : "")
          + `  | resetCutoff ${diagNeu.resetAnchor?.cutoffDate ?? "—"}`,
        );
      }
      if (diff !== 0) { summeDifferenz += diff; anspruchGeaendert.add(customerId); }
      if (diffVerf !== 0) { summeVerfuegbarkeit += diffVerf; verfuegbarGeaendert.add(customerId); }
      if (diff !== 0 || diffVerf !== 0 || zusaetzlichAusgeschlossen.length > 0) geaendert.add(customerId);
      if (negativNeu.length > 0) kundenMitNegativemTopf.add(customerId);
      if (negativeToepfe.length > 0 && negativNeu.length === 0) kundenMitBestandsTopf.add(customerId);
    }

    if (zeilenAus.length > 0) {
      betroffen++;
      console.log(`Kunde ${customerId}`);
      zeilenAus.forEach(z => console.log(z));
    }
  }

  // Die Mengen zum direkten Abgleich mit der Erwartung (Flip-Messung, Alrik
  // 25.09.2026: geändert genau {89, 153, 159, 186}, bei 186 Verfügbarkeit
  // unverändert). „Geändert" = Anspruch, Verfügbarkeit oder Ausschlussliste.
  const liste = (m: Set<number>) => `{${[...m].sort((a, b) => a - b).join(", ")}}`;
  console.log("");
  console.log(`GEÄNDERT (Anspruch, Verfügbarkeit oder Ausschluss): ${liste(geaendert)}`);
  console.log(`  davon Anspruch geändert:      ${liste(anspruchGeaendert)}`);
  console.log(`  davon Verfügbarkeit geändert: ${liste(verfuegbarGeaendert)}`);
  console.log(`Kunden mit Differenz: ${betroffen} von ${kunden.length}`);
  console.log(`Summe der ANSPRUCHS-Differenzen über alle Stichtage: ${euro(summeDifferenz)} €`);
  console.log(`Summe der VERFÜGBARKEITS-Differenzen über alle Stichtage: ${euro(summeVerfuegbarkeit)} €`);
  console.log("");
  if (kundenMitBestandsTopf.size > 0) {
    console.log(`ℹ ${kundenMitBestandsTopf.size} Kunde(n) mit negativem Topf AUCH OHNE Flag: `
      + `${[...kundenMitBestandsTopf].join(", ")}`);
    console.log("  Bestandsproblem, nicht von der Verdrängung erzeugt. Haeufigste Ursache:");
    console.log("  eine NEGATIVE `manual_adjustment`-Zeile. `calculateAllocatedCents` addiert");
    console.log("  sie NACH `calculateAllocated45b`, `fifo-breakdown` rechnet");
    console.log("  `allocatedCur = A − allocatedCarry` — der Abzug landet damit vollstaendig");
    console.log("  im laufenden Topf. Eigener Befund, blockiert diese Messung NICHT.");
    console.log("");
  }
  if (kundenMitNegativemTopf.size === 0) {
    console.log("Kein negativer Topf DURCH DIE VERDRÄNGUNG — Vorbedingung 1 trägt auf diesem Bestand.");
  } else {
    console.log(`⚠ ${kundenMitNegativemTopf.size} Kunde(n) mit NEGATIVEM Topf: `
      + `${[...kundenMitNegativemTopf].join(", ")}`);
    console.log("  Vorbedingung 1 trägt hier NICHT — der Topf ist OHNE Flag nicht negativ.");
    console.log("  Die Zahlen oben nicht verwenden,");
    console.log("  bevor das erklärt ist — im Client verschwindet so ein Topf lautlos.");
  }
  console.log("");
  console.log("Hinweis: die Summe addiert MEHRERE Stichtage desselben Kunden und ist");
  console.log("deshalb KEIN Schadensbetrag — sie zeigt nur, wo die Regel greift.");
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
