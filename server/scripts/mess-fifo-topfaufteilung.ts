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
 *     diff /tmp/vorher.csv /tmp/nachher.csv
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
  for (const id of kunden) {
    const b = await readBudget45bFifoBreakdown(id, stichtag);
    const c = b.pots.find(p => p.potType === "carryover");
    const l = b.pots.find(p => p.potType === "current_year");
    if (!c || !l) continue;
    if (c.consumedCents < 0 || l.consumedCents < 0) negativeToepfe++;

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

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Messung fehlgeschlagen:", e);
    process.exit(1);
  });
