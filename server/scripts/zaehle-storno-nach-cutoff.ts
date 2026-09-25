/**
 * Bestandszählung zu `6hcfH98Qh2hVXpmp` — Storno NACH dem Reset-Cutoff zu
 * einem Verbrauch DAVOR.
 *
 * ── Die Frage ───────────────────────────────────────────────────────────
 * `getExcluded45bConsumption` schließt einen Verbrauch vor dem Reset-Cutoff
 * aus (Glied b: `transactionDate < cutoffDate`), sein späteres Storno aber
 * nicht. Das Storno bleibt im `rawNet` stehen und senkt den Verbrauch ein
 * zweites Mal. Gemessen an einer Fixture: `consumedNet` 100,00 statt 200,00 €,
 * `availableCents` 962,00 statt 862,00 € — auf `main` und auf #190 identisch.
 *
 * Alriks Entscheidung (Variante A, 25.09.2026): **ein Storno folgt der
 * Ausschluss-Entscheidung seiner Originalbuchung.** Damit ist jede hier
 * gezählte Zeile heute ein zu hoch ausgewiesener Betrag.
 *
 * Dieses Skript zählt, wie oft die Konstellation im Bestand vorkommt.
 *
 * ── Warum der Anker über die SSoT kommt ─────────────────────────────────
 * Der Cutoff wird NICHT aus `budget_allocations` nachgebaut, sondern über
 * `readResetAnchor` gelesen — dieselbe Funktion, die der Reader benutzt. Ein
 * Nachbau wäre der Zweitbegriff, vor dem CLAUDE.md warnt, und er würde genau
 * dort abweichen, wo es zählt (Supersession, `{year}`-Modus, Stichtags-Gate).
 *
 * ── Was das Skript über seine eigene Lücke sagt ─────────────────────────
 * `reversed_transaction_id` ist nullable. Ein Storno ohne diese Verknüpfung
 * lässt sich der Originalbuchung nicht sicher zuordnen. Solche Zeilen werden
 * **getrennt ausgewiesen**, nicht stillschweigend weggelassen und nicht
 * mitgezählt — sonst wäre die Zahl eine Teilmenge im Gewand der Gesamtzahl.
 *
 * ── Rein lesend ─────────────────────────────────────────────────────────
 * Nur `db.select`. Kein Aufruf, der einen Schreibpfad auslöst —
 * `readResetAnchor` liest, `getBudgetSummary` (mit `syncCarryoverAndExpiry`
 * als Nebenwirkung) wird bewusst NICHT benutzt.
 *
 * Aufruf:
 *   PGOPTIONS='-c default_transaction_read_only=on' \
 *     tsx server/scripts/zaehle-storno-nach-cutoff.ts
 *   … [stichtag]      Default: heute
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations, budgetTransactions, customers } from "@shared/schema";
import { readResetAnchor } from "../storage/budget/allocation-storage";
import { formatEuroDE } from "@shared/utils/money";
import { todayISO } from "@shared/utils/datetime";

const BUDGET_TYPE = "entlastungsbetrag_45b";

export interface Fall {
  customerId: number;
  name: string;
  cutoff: string;
  stornoId: number;
  stornoDatum: string;
  originalId: number;
  originalDatum: string;
  betragCents: number;
}

export interface Zaehlung {
  kundenGesamt: number;
  kundenMitAnker: number;
  faelle: Fall[];
  stornosOhneVerknuepfung: number;
  kundenOhneVerknuepfung: number;
}

/**
 * Die Zaehlung selbst — getrennt von der Ausgabe, damit die Selbstprobe sie
 * aufrufen kann. Ein Mess-Skript, dessen Ergebnis nur als Text existiert,
 * laesst sich nicht gegenpruefen; genau daran haengt aber, ob die Zahl, die
 * Alrik bekommt, etwas bedeutet.
 */
export async function ermittleFaelle(stichtag: string): Promise<Zaehlung> {

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

  const faelle: Fall[] = [];
  let kundenMitAnker = 0;
  let stornosOhneVerknuepfung = 0;
  const kundenOhneVerknuepfung = new Set<number>();

  for (const customerId of kunden) {
    const anker = await readResetAnchor(customerId, stichtag);
    if (!anker) continue;
    kundenMitAnker++;

    // Alle Stornos AB dem Cutoff (der Cutoff selbst zählt zum neuen Bestand).
    const stornos = await db.select({
      id: budgetTransactions.id,
      datum: budgetTransactions.transactionDate,
      betrag: budgetTransactions.amountCents,
      originalId: budgetTransactions.reversedTransactionId,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, BUDGET_TYPE),
      eq(budgetTransactions.transactionType, "reversal"),
      sql`${budgetTransactions.transactionDate} >= ${anker.cutoffDate}`,
      sql`${budgetTransactions.transactionDate} <= ${stichtag}`,
    ));
    if (stornos.length === 0) continue;

    const ohne = stornos.filter(s => s.originalId == null);
    if (ohne.length > 0) {
      stornosOhneVerknuepfung += ohne.length;
      kundenOhneVerknuepfung.add(customerId);
    }

    const mitIds = stornos.filter(s => s.originalId != null);
    if (mitIds.length === 0) continue;

    const originale = await db.select({
      id: budgetTransactions.id,
      datum: budgetTransactions.transactionDate,
    }).from(budgetTransactions).where(
      inArray(budgetTransactions.id, mitIds.map(s => s.originalId as number)),
    );
    const datumVon = new Map(originale.map(o => [o.id, o.datum] as const));

    for (const s of mitIds) {
      const originalDatum = datumVon.get(s.originalId as number);
      // Die Konstellation: Original VOR dem Cutoff, Storno ab dem Cutoff.
      if (originalDatum == null || originalDatum >= anker.cutoffDate) continue;
      faelle.push({
        customerId,
        name: namen.get(customerId) ?? `#${customerId}`,
        cutoff: anker.cutoffDate,
        stornoId: s.id,
        stornoDatum: s.datum,
        originalId: s.originalId as number,
        originalDatum,
        betragCents: Math.abs(s.betrag),
      });
    }
  }

  return {
    kundenGesamt: kunden.length,
    kundenMitAnker,
    faelle,
    stornosOhneVerknuepfung,
    kundenOhneVerknuepfung: kundenOhneVerknuepfung.size,
  };
}

async function main(): Promise<void> {
  const stichtag = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? todayISO();
  const {
    kundenGesamt, kundenMitAnker, faelle,
    stornosOhneVerknuepfung, kundenOhneVerknuepfung,
  } = await ermittleFaelle(stichtag);

  const betroffeneKunden = new Set(faelle.map(f => f.customerId));
  const summe = faelle.reduce((s, f) => s + f.betragCents, 0);

  console.log("");
  console.log(`STORNO NACH DEM RESET-CUTOFF zu einem Verbrauch DAVOR — Stichtag ${stichtag}`);
  console.log("=".repeat(86));
  console.log("");
  console.log(`  ANTWORT: ${betroffeneKunden.size} Kunden betroffen, `
    + `${formatEuroDE(summe)} EUR zu viel ausgewiesen (${faelle.length} Buchungen).`);
  console.log("");
  console.log("-".repeat(86));
  console.log(`  Kunden mit aktiver §45b-Zuweisung        ${String(kundenGesamt).padStart(5)}`);
  console.log(`  davon mit Reset-Anker zum Stichtag       ${String(kundenMitAnker).padStart(5)}`);
  console.log(`  davon mit der Konstellation              ${String(betroffeneKunden.size).padStart(5)}`);
  console.log("");

  if (faelle.length > 0) {
    const groesste = [...faelle].sort((a, b) => b.betragCents - a.betragCents).slice(0, 5);
    console.log("  Die fünf größten Fälle:");
    console.log("");
    for (const f of groesste) {
      console.log(`    ${String(f.customerId).padStart(4)}  ${f.name.padEnd(28).slice(0, 28)}`
        + `  ${formatEuroDE(f.betragCents).padStart(11)} EUR`);
      console.log(`          Cutoff ${f.cutoff} · Verbrauch #${f.originalId} vom ${f.originalDatum}`
        + ` · Storno #${f.stornoId} vom ${f.stornoDatum}`);
    }
    console.log("");
  }

  console.log("-".repeat(86));
  console.log("  LÜCKE DIESER ZÄHLUNG — nicht weggelassen, sondern ausgewiesen:");
  console.log("");
  if (stornosOhneVerknuepfung === 0) {
    console.log("    Keine. Jedes geprüfte Storno trägt `reversed_transaction_id`.");
  } else {
    console.log(`    ${stornosOhneVerknuepfung} Storno-Zeilen bei ${kundenOhneVerknuepfung} Kunden`);
    console.log("    tragen KEIN `reversed_transaction_id`. Ihre Originalbuchung ist nicht");
    console.log("    sicher bestimmbar; sie sind in der Antwort oben NICHT enthalten.");
    console.log("    Die Zahl oben ist damit eine UNTERGRENZE.");
  }
  console.log("");
  console.log("  Gezählt wird der Storno-Betrag (brutto). Er ist das, was heute zu viel");
  console.log("  im Topf steht — der Reader zieht ihn ein zweites Mal ab, obwohl die");
  console.log("  Originalbuchung bereits ausgeschlossen ist.");
  console.log("");

  process.exit(0);
}

// Nur als CLI ausfuehren — sonst startet der Import in der Selbstprobe den
// vollen Lauf gegen die Test-DB.
if (process.argv[1]?.includes("zaehle-storno-nach-cutoff")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
