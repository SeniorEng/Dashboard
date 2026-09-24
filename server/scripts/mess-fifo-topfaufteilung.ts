/**
 * Schritt B zu PR #190 — Vorher/Nachher der §45b-Topfaufteilung.
 *
 * ── Wie der Vergleich zustande kommt ────────────────────────────────────
 * Es gibt **kein Flag**, das die alte und die neue Rechnung nebeneinander
 * stellen könnte (anders als bei der Verdrängung). Deshalb rechnet dieses
 * Skript NICHTS nach: es ruft `readBudget45bFifoBreakdown` auf und gibt die
 * Zahlen aus.
 *
 * Der Vergleich entsteht durch **zwei Läufe**:
 *
 *     git checkout main
 *     PGOPTIONS='-c default_transaction_read_only=on' \
 *       tsx server/scripts/mess-fifo-topfaufteilung.ts --csv > /tmp/vorher.csv
 *
 *     git checkout fix/fifo-negativer-verbrauch
 *     PGOPTIONS='-c default_transaction_read_only=on' \
 *       tsx server/scripts/mess-fifo-topfaufteilung.ts --csv > /tmp/nachher.csv
 *
 * und im zweiten Lauf `--vergleich /tmp/vorher.csv` statt `--csv`. Das Skript
 * liest die alte Ausgabe ein und stellt die Auswertung selbst zusammen:
 * geaenderte Kunden von wie vielen, Summe der Verschiebung, die fuenf
 * groessten Faelle mit Namen.
 *
 * Ein Nachbau der alten Formel wäre der Zweitbegriff, vor dem CLAUDE.md warnt —
 * und er würde genau dort abweichen, wo es weh tut.
 *
 * ── Rein lesend ─────────────────────────────────────────────────────────
 * Kein INSERT/UPDATE/DELETE. `PGOPTIONS` setzt die Lesesperre auf
 * Verbindungsebene, damit „nur lesend" nicht nur eine Zusage ist.
 *
 * ⚠ ABER: `readBudget45bFifoBreakdown` ruft **keinen** Schreibpfad — anders als
 * `getBudgetSummary`, das `syncCarryoverAndExpiry` als Nebenwirkung fährt
 * (Wirkungskarte, Abschnitt 1). Deshalb ist der Aufruf hier unbedenklich; wer
 * das Skript um eine Übersichts-Zahl erweitert, hebt diese Eigenschaft auf.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations, customers } from "@shared/schema";
import { readBudget45bFifoBreakdown } from "../storage/budget/fifo-breakdown";
import { formatEuroDE } from "@shared/utils/money";
import { todayISO } from "@shared/utils/datetime";

const BUDGET_TYPE = "entlastungsbetrag_45b";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const alsCsv = args.includes("--csv");
  const vergleichIdx = args.indexOf("--vergleich");
  const vergleichsDatei = vergleichIdx >= 0 ? args[vergleichIdx + 1] : null;
  const stichtag = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? todayISO();

  /**
   * Die Population: Kunden mit mindestens einer aktiven §45b-Zuweisung.
   * Bewusst breiter als „mit Startwert" — der Schnitt wirkt über den
   * Reset-Anker, und den kann auch ein Kunde haben, dessen Startwert außerhalb
   * dieser Auswahl liegt.
   */
  const zeilen = await db
    .select({ customerId: budgetAllocations.customerId })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      isNull(budgetAllocations.deletedAt),
    ));
  const kunden = [...new Set(zeilen.map(z => z.customerId))].sort((a, b) => a - b);

  const namen = new Map(
    (await db.select({ id: customers.id, name: customers.name }).from(customers))
      .map(k => [k.id, k.name] as const),
  );

  if (alsCsv) console.log("kunde;name;uebertrag_alloc;uebertrag_consumed;uebertrag_rest;laufend_alloc;laufend_consumed;laufend_rest");
  else {
    console.log("");
    console.log(`§45b-Topfaufteilung zum ${stichtag} — ${kunden.length} Kunden mit aktiver Zuweisung`);
    console.log("=".repeat(104));
    console.log(
      "Kunde".padEnd(7) + "Name".padEnd(24)
      + "Uebertrag: alloc / verbr / Rest".padStart(34)
      + "Laufend: alloc / verbr / Rest".padStart(34),
    );
    console.log("-".repeat(104));
  }

  let negativeToepfe = 0;
  const neu = new Map<number, Zahlen>();
  for (const id of kunden) {
    const b = await readBudget45bFifoBreakdown(id, stichtag);
    const c = b.pots.find(p => p.potType === "carryover");
    const l = b.pots.find(p => p.potType === "current_year");
    if (!c || !l) continue;
    if (c.consumedCents < 0 || l.consumedCents < 0) negativeToepfe++;
    neu.set(id, {
      uebertragVerbraucht: c.consumedCents, uebertragRest: c.remainingCents,
      laufendVerbraucht: l.consumedCents, laufendRest: l.remainingCents,
    });
    if (vergleichsDatei) continue;

    if (alsCsv) {
      console.log([
        id, `"${namen.get(id) ?? "?"}"`,
        c.allocatedCents, c.consumedCents, c.remainingCents,
        l.allocatedCents, l.consumedCents, l.remainingCents,
      ].join(";"));
    } else {
      console.log(
        String(id).padEnd(7) + (namen.get(id) ?? "?").slice(0, 22).padEnd(24)
        + `${formatEuroDE(c.allocatedCents)} / ${formatEuroDE(c.consumedCents)} / ${formatEuroDE(c.remainingCents)}`.padStart(34)
        + `${formatEuroDE(l.allocatedCents)} / ${formatEuroDE(l.consumedCents)} / ${formatEuroDE(l.remainingCents)}`.padStart(34),
      );
    }
  }

  if (vergleichsDatei) {
    await vergleiche(vergleichsDatei, kunden, stichtag, namen);
    return;
  }

  if (!alsCsv) {
    console.log("-".repeat(104));
    console.log("");
    console.log(`Toepfe mit NEGATIVEM Verbrauch: ${negativeToepfe}`);
    console.log("");
    console.log("Auf `main` ist diese Zahl der Fehler-Bestand. Auf dem Fix-Branch muss sie 0 sein.");
    console.log("Die eigentliche Verschiebung zeigt erst der `diff` der beiden --csv-Laeufe:");
    console.log("  · `uebertrag_consumed` steigt dort, wo vor dem Stichtag gegen den");
    console.log("    Uebertrag gebucht wurde und der Schnitt es bisher uebersah");
    console.log("  · `laufend_rest` FAELLT entsprechend — das ist die Korrektur nach unten,");
    console.log("    also in der Richtung, in der bisher zu viel frei gemeldet wurde");
    console.log("");
  }
}


type Zahlen = {
  uebertragVerbraucht: number; uebertragRest: number;
  laufendVerbraucht: number; laufendRest: number;
};

/**
 * Liest die `--csv`-Ausgabe des VORHER-Laufs und stellt die Auswertung auf.
 *
 * Bewusst kein Nachbau der alten Formel — die alten Zahlen kommen aus einem
 * echten Lauf auf `main`, nicht aus einer Rekonstruktion.
 */
async function vergleiche(
  datei: string,
  kunden: number[],
  stichtag: string,
  namen: Map<number, string>,
): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const alt = new Map<number, Zahlen>();
  for (const zeile of readFileSync(datei, "utf8").split("\n")) {
    const t = zeile.split(";");
    if (t.length < 8 || !/^\d+$/.test(t[0])) continue;
    alt.set(Number(t[0]), {
      uebertragVerbraucht: Number(t[3]), uebertragRest: Number(t[4]),
      laufendVerbraucht: Number(t[6]), laufendRest: Number(t[7]),
    });
  }

  const { readBudget45bFifoBreakdown: lies } = await import("../storage/budget/fifo-breakdown");
  const aenderungen: Array<{ id: number; dRest: number; dVerbrauch: number }> = [];
  let negativVorher = 0;
  for (const id of kunden) {
    const a = alt.get(id);
    if (!a) continue;
    const b = await lies(id, stichtag);
    const c = b.pots.find(p => p.potType === "carryover");
    const l = b.pots.find(p => p.potType === "current_year");
    if (!c || !l) continue;
    if (a.uebertragVerbraucht < 0 || a.laufendVerbraucht < 0) negativVorher++;
    /**
     * JE TOPF vergleichen, nicht die Summe.
     *
     * Die Selbstprobe hat es aufgedeckt: die SUMME der beiden Reste ist
     * invariant (`freeCarry + freeCur = V`), eine reine Umverteilung waere
     * damit unsichtbar gewesen — und genau eine Umverteilung ist der Fix.
     * Die erste Fassung meldete „0 von 1 geaendert" fuer einen Fall, der sich
     * nachweislich aendert.
     */
    const dLaufendRest = l.remainingCents - a.laufendRest;
    const dUebertragRest = c.remainingCents - a.uebertragRest;
    const dUebertragVerbrauch = c.consumedCents - a.uebertragVerbraucht;
    if (dLaufendRest !== 0 || dUebertragRest !== 0 || dUebertragVerbrauch !== 0) {
      aenderungen.push({ id, dRest: dLaufendRest, dVerbrauch: dUebertragVerbrauch });
    }
  }

  const summeRest = aenderungen.reduce((n, a) => n + a.dRest, 0);
  const groesste = [...aenderungen].sort((a, b) => Math.abs(b.dRest) - Math.abs(a.dRest)).slice(0, 5);

  console.log("");
  console.log(`VORHER/NACHHER — §45b-Topfaufteilung zum ${stichtag}`);
  console.log("=".repeat(88));
  console.log(`  Kunden mit Aenderung:        ${aenderungen.length} von ${alt.size} verglichenen`);
  console.log(`  Σ Verschiebung (Rest „laufendes Jahr"): ${formatEuroDE(summeRest)}`);
  console.log(`  Toepfe mit negativem Verbrauch VORHER: ${negativVorher}`);
  console.log("");
  if (groesste.length === 0) {
    console.log("  Keine Aenderung — auf diesem Bestand tritt der Fall nicht auf.");
  } else {
    console.log("  Die fuenf groessten Faelle:");
    console.log("  " + "Kunde".padEnd(7) + "Name".padEnd(28) + "Δ Rest".padStart(14) + "Δ Verbrauch".padStart(16));
    console.log("  " + "-".repeat(64));
    for (const g of groesste) {
      console.log(
        "  " + String(g.id).padEnd(7)
        + (namen.get(g.id) ?? "?").slice(0, 26).padEnd(28)
        + formatEuroDE(g.dRest).padStart(16)
        + formatEuroDE(g.dVerbrauch).padStart(18),
      );
    }
  }
  console.log("");
  console.log("  Lesart: Δ Rest laufend NEGATIV = der Topf meldet nach dem Fix WENIGER frei.");
  console.log("  Das ist die Korrekturrichtung — vorher war zu viel frei ausgewiesen.");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Messung fehlgeschlagen:", e);
    process.exit(1);
  });
