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
  const ursachen = args.includes("--ursachen");
  const diagIdx = args.indexOf("--diagnose");
  const diagKunde = diagIdx >= 0 ? Number(args[diagIdx + 1]) : null;
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

  if (diagKunde != null) { await diagnose(diagKunde, stichtag, namen); return; }
  if (ursachen) { await ursachenAufteilung(kunden, stichtag); return; }
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
  const aenderungen: Array<{
    id: number; dUeRest: number; dUeVerbr: number; dLfRest: number; dLfVerbr: number;
  }> = [];
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
    const d = {
      id,
      dUeRest: c.remainingCents - a.uebertragRest,
      dUeVerbr: c.consumedCents - a.uebertragVerbraucht,
      dLfRest: l.remainingCents - a.laufendRest,
      dLfVerbr: l.consumedCents - a.laufendVerbraucht,
    };
    if (d.dUeRest || d.dUeVerbr || d.dLfRest || d.dLfVerbr) aenderungen.push(d);
  }

  const summeRest = aenderungen.reduce((n, a) => n + a.dLfRest, 0);
  const groesste = [...aenderungen].sort((a, b) => Math.abs(b.dLfRest) - Math.abs(a.dLfRest)).slice(0, 5);

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
    console.log("  " + "Kunde".padEnd(7) + "Name".padEnd(22)
      + "Δ Übertr.Rest".padStart(15) + "Δ Übertr.Verbr".padStart(16)
      + "Δ Lauf.Rest".padStart(14) + "Δ Lauf.Verbr".padStart(15));
    console.log("  " + "-".repeat(84));
    for (const g of groesste) {
      console.log(
        "  " + String(g.id).padEnd(7)
        + (namen.get(g.id) ?? "?").slice(0, 20).padEnd(22)
        + formatEuroDE(g.dUeRest).padStart(15)
        + formatEuroDE(g.dUeVerbr).padStart(16)
        + formatEuroDE(g.dLfRest).padStart(14)
        + formatEuroDE(g.dLfVerbr).padStart(15),
      );
    }
  }
  console.log("");
  console.log("  Lesart — JE TOPF lesen, nicht über Kreuz:");
  console.log("    · Übertrag:  Verbrauch fällt, Rest steigt   (der Schnitt nimmt Buchungen heraus)");
  console.log("    · Laufend:   Verbrauch steigt, Rest fällt   (die Gegenbewegung)");
  console.log("");
  console.log("  A / C / V ändern sich NICHT — nur ihre Aufteilung auf die zwei Töpfe.");
  console.log("");
  console.log("  |Δ Lauf.Rest| kann KLEINER sein als |Δ Übertr.Verbr.|: `freeCarry` ist bei V");
  console.log("  gedeckelt — der Übertrags-Topf kann nie mehr frei zeigen als der Kunde");
  console.log("  insgesamt hat. An einem konstruierten Fall gemessen: 16.500 gegen 157.200.");
  console.log("  Kein Fehler, sondern die Deckelung.");
  console.log("");
}

/**
 * Woher kommt die Verschiebung — as-of-Schnitt oder Reset-Schnitt?
 *
 * Klassifiziert die Buchungen, die der Schnitt herausnimmt. **Kein Nachbau der
 * Formel** — gezaehlt wird nur, welche Transaktion in welche der beiden
 * Kategorien faellt:
 *
 *   as-of   : `transactionDate > asOfDate`   (FS-5, spaetere Buchungen)
 *   Reset   : `transactionDate < cutoffDate` (Startwert-Stichtag)
 *
 * Fuer Modell v2 zaehlt vor allem der zweite: der as-of-Schnitt betrifft
 * Stichtagssichten in die Vergangenheit, der Reset-Schnitt die Inventur selbst.
 */
async function ursachenAufteilung(kunden: number[], stichtag: string): Promise<void> {
  const { and: und, eq: ist, isNull: istNull, inArray, sql: roh, gt, lt } = await import("drizzle-orm");
  const { budgetTransactions } = await import("@shared/schema");
  const { readResetAnchor } = await import("../storage/budget/allocation-storage");

  let summeAsOf = 0, kundenAsOf = 0;
  let summeResetDamals = 0, kundenResetDamals = 0;
  let summeResetNachtraeglich = 0, kundenResetNachtraeglich = 0;

  for (const id of kunden) {
    const ueIds = (await db.select({ id: budgetAllocations.id })
      .from(budgetAllocations)
      .where(und(
        ist(budgetAllocations.customerId, id),
        ist(budgetAllocations.budgetType, BUDGET_TYPE),
        ist(budgetAllocations.source, "carryover"),
        istNull(budgetAllocations.deletedAt),
      ))).map(z => z.id);
    if (ueIds.length === 0) continue;

    const anker = await readResetAnchor(id, stichtag);

    /**
     * NETTO, nicht brutto (Gate 2 zu #190, N3).
     *
     * Die erste Fassung summierte nur `consumption`/`write_off`. Die
     * gemessene Verschiebung ist aber netto — der Reader zieht Stornos ab.
     * Eine Brutto-Ursachenzahl neben einer Netto-Verschiebung liest sich wie
     * dieselbe Groesse und ist es nicht; sie kann die Verschiebung sogar
     * UEBERSTEIGEN, und dann sieht der Befund nach einem Widerspruch aus, wo
     * nur zwei verschiedene Begriffe nebeneinanderstehen.
     */
    const nettoSumme = async (...zeitFilter: unknown[]) => {
      const [verbrauch] = await db.select({
        total: roh<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(und(
        inArray(budgetTransactions.allocationId, ueIds),
        roh`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`,
        ...(zeitFilter as never[]),
      ));
      const [storno] = await db.select({
        total: roh<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(und(
        inArray(budgetTransactions.allocationId, ueIds),
        ist(budgetTransactions.transactionType, "reversal"),
        ...(zeitFilter as never[]),
      ));
      return Math.max(0, Number(verbrauch?.total ?? 0) - Number(storno?.total ?? 0));
    };

    // (a) as-of-Anteil: Buchungen NACH dem Stichtag.
    const a = await nettoSumme(gt(budgetTransactions.transactionDate, stichtag));
    if (a > 0) { summeAsOf += a; kundenAsOf++; }

    if (!anker) continue;

    /**
     * (b) / (c) — WANN wurde der Startwert eingetragen?
     *
     * Nur ein Startwert, der zum Stichtag schon EXISTIERTE, kann damals real
     * auf dem Schirm gestanden haben. Ein nachtraeglich eingetragener
     * veraendert die Vergangenheits-SICHT, nicht das, was jemand damals sah.
     *
     * `created_at` ist `NOT NULL DEFAULT now()` — gemessen, immer gefuellt.
     * (Die frueheren „0 Treffer" betrafen die Sekunden-Heuristik als
     * VORGANGS-Merkmal, nicht die Spalte als Eintragsdatum.)
     *
     * ⚠ Was `created_at` NICHT sagt: ob die Zeile seither geaendert wurde.
     * `upsertInitialBalanceAllocation` aktualisiert in-place, ohne das Datum
     * anzufassen. Ein Startwert, der damals mit anderem Betrag existierte,
     * zaehlt hier als „damals" — richtig fuer die Frage „stand etwas auf dem
     * Schirm", zu grob fuer „stand DIESE Zahl dort".
     */
    const [startwert] = await db.select({
      createdAt: budgetAllocations.createdAt,
    }).from(budgetAllocations).where(und(
      ist(budgetAllocations.customerId, id),
      ist(budgetAllocations.budgetType, BUDGET_TYPE),
      ist(budgetAllocations.source, "initial_balance"),
      ist(budgetAllocations.year, anker.year),
      ist(budgetAllocations.month, anker.month),
      istNull(budgetAllocations.deletedAt),
    ));

    const r = await nettoSumme(lt(budgetTransactions.transactionDate, anker.cutoffDate));
    if (r <= 0) continue;

    const eingetragen = startwert?.createdAt
      ? new Date(startwert.createdAt).toISOString().slice(0, 10)
      : null;
    if (eingetragen != null && eingetragen <= stichtag) {
      summeResetDamals += r; kundenResetDamals++;
    } else {
      summeResetNachtraeglich += r; kundenResetNachtraeglich++;
    }
  }

  console.log("");
  console.log(`URSACHEN der Verschiebung zum ${stichtag}`);
  console.log("=".repeat(78));
  // Die ANTWORT vor die Zahlen (Gate 2 zu #190, N3): wer die Tabelle zuerst
  // sieht, hat die Summe schon gebildet, bevor er liest, dass er sie nicht
  // bilden darf.
  console.log("");
  console.log(`  ANTWORT: von den drei Anteilen kann NUR (b) damals real auf dem`);
  console.log(`  Schirm gestanden haben — ${formatEuroDE(summeResetDamals)} bei ${kundenResetDamals} Kunden.`);
  console.log("");
  console.log("-".repeat(78));
  console.log(`  (a) as-of-Schnitt — Buchung NACH dem Stichtag`);
  console.log(`      ${formatEuroDE(summeAsOf).padStart(14)}  bei ${kundenAsOf} Kunden`);
  console.log("");
  console.log(`  (b) Reset-Schnitt, Startwert existierte SCHON zum Stichtag`);
  console.log(`      ${formatEuroDE(summeResetDamals).padStart(14)}  bei ${kundenResetDamals} Kunden`);
  console.log("");
  console.log(`  (c) Reset-Schnitt, Startwert NACHTRAEGLICH eingetragen`);
  console.log(`      ${formatEuroDE(summeResetNachtraeglich).padStart(14)}  bei ${kundenResetNachtraeglich} Kunden`);
  console.log("");
  console.log("  NUR (b) kann damals real auf dem Schirm gestanden haben.");
  console.log("  (a) und (c) veraendern die Vergangenheits-SICHT, nicht das, was");
  console.log("  jemand damals gesehen hat. Wer alle drei zusammenzaehlt und das");
  console.log("  Ergebnis als „so viel stand falsch auf dem Schirm\" liest, macht");
  console.log("  aus einer Teilmenge eine Gesamtzahl — zeitlich statt raeumlich.");
  console.log("");
  console.log("  EINSCHRAENKUNGEN — was diese drei Zahlen NICHT sind:");
  console.log("");
  console.log("  1. Sie sind NETTO (Verbrauch minus Storno), damit sie mit der");
  console.log("     gemessenen Verschiebung dieselbe Groesse sind. Bis 25.09.2026");
  console.log("     waren sie brutto und konnten die Verschiebung uebersteigen.");
  console.log("");
  console.log("  2. Die Grundmenge ist WEITER als der Schnitt: gezaehlt wird ueber");
  console.log("     ALLE Uebertragszeilen des Kunden, geschnitten wird nur ueber die");
  console.log("     nicht verdraengten. Solange das Verdraengungs-Flag AUS ist, sind");
  console.log("     beide Mengen identisch und die Zahlen exakt. Mit eingeschaltetem");
  console.log("     Flag werden sie zur OBERGRENZE.");
  console.log("");
  console.log("  3. Zu (b): `created_at` sagt, wann die ZEILE entstand, nicht ob ihr");
  console.log("     Betrag seither geaendert wurde (In-Place-Upsert). Richtig fuer");
  console.log("     „stand etwas auf dem Schirm\", zu grob fuer „stand DIESE Zahl\".");
  console.log("");
}

/**
 * Ein Einzelfall von Hand nachvollziehbar: Zeilen, Buchungen, Werte.
 */
async function diagnose(id: number, stichtag: string, namen: Map<number, string>): Promise<void> {
  const { and: und, eq: ist, isNull: istNull } = await import("drizzle-orm");
  const { budgetTransactions } = await import("@shared/schema");
  const { readResetAnchor } = await import("../storage/budget/allocation-storage");

  const zeilen = await db.select({
    id: budgetAllocations.id, source: budgetAllocations.source,
    year: budgetAllocations.year, month: budgetAllocations.month,
    amountCents: budgetAllocations.amountCents,
    validFrom: budgetAllocations.validFrom, expiresAt: budgetAllocations.expiresAt,
  }).from(budgetAllocations).where(und(
    ist(budgetAllocations.customerId, id),
    ist(budgetAllocations.budgetType, BUDGET_TYPE),
    istNull(budgetAllocations.deletedAt),
  ));

  const tx = await db.select({
    date: budgetTransactions.transactionDate, typ: budgetTransactions.transactionType,
    amountCents: budgetTransactions.amountCents, alloc: budgetTransactions.allocationId,
  }).from(budgetTransactions).where(und(
    ist(budgetTransactions.customerId, id),
    ist(budgetTransactions.budgetType, BUDGET_TYPE),
  ));

  const anker = await readResetAnchor(id, stichtag);
  const b = await readBudget45bFifoBreakdown(id, stichtag);

  console.log("");
  console.log(`DIAGNOSE Kunde ${id} (${namen.get(id) ?? "?"}) zum ${stichtag}`);
  console.log("=".repeat(84));
  console.log(`Reset-Anker: ${anker ? anker.cutoffDate : "— keiner —"}`);
  console.log("");
  console.log("Zuweisungen:");
  for (const z of zeilen.sort((a, b2) => a.validFrom.localeCompare(b2.validFrom))) {
    console.log(`  #${String(z.id).padEnd(6)} ${z.source.padEnd(16)} ${formatEuroDE(z.amountCents).padStart(13)}`
      + `  ab ${z.validFrom}  bis ${z.expiresAt ?? "—"}  (year ${z.year}, month ${z.month ?? "—"})`);
  }
  console.log("");
  console.log("Buchungen:");
  for (const t of tx.sort((a, b2) => a.date.localeCompare(b2.date))) {
    const lage = t.date > stichtag ? "NACH Stichtag (as-of-Schnitt)"
      : (anker && t.date < anker.cutoffDate) ? "vor dem Reset (Reset-Schnitt)" : "zaehlt";
    console.log(`  ${t.date}  ${t.typ.padEnd(12)} ${formatEuroDE(t.amountCents).padStart(13)}`
      + `  alloc=${String(t.alloc ?? "NULL").padEnd(7)} ${lage}`);
  }
  console.log("");
  console.log("Ergebnis (dieser Code-Stand):");
  for (const t of b.pots) {
    console.log(`  ${t.potType.padEnd(13)} alloc ${formatEuroDE(t.allocatedCents).padStart(13)}`
      + `  verbr ${formatEuroDE(t.consumedCents).padStart(13)}  rest ${formatEuroDE(t.remainingCents).padStart(13)}`);
  }
  console.log(`  GESAMT        A ${formatEuroDE(b.totalAllocatedCents)}  C ${formatEuroDE(b.totalConsumedCents)}  V ${formatEuroDE(b.totalAvailableCents)}`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Messung fehlgeschlagen:", e);
    process.exit(1);
  });
