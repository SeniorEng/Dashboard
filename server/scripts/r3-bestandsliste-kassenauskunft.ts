/**
 * R3 — die Bestandsliste für Alrik (Stammticket `6hXp9qMrXH2WGVVG`).
 *
 * ── Wozu ────────────────────────────────────────────────────────────────
 * Entscheidungstabelle v2 (24.09.2026) kennt nur noch eine rote Karte: die
 * **vorhandenen** Startwerte tragen keine Angabe, zu welchem Anlass sie
 * gesetzt wurden. Für jeden betroffenen Kunden braucht es von Alrik zwei
 * Zahlen zum Monat des vorhandenen Startwerts:
 *
 *   · **Rest Übertrag Vorjahr** — was aus dem Vorjahr zu diesem Stichtag
 *     noch übrig war
 *   · **Rest laufendes Jahr** — was vom laufenden Jahr zu diesem Stichtag
 *     noch übrig war
 *
 * Dieses Skript liefert die Vorlage: je Kunde den Stichtag, was HEUTE im
 * System steht, und zwei leere Spalten.
 *
 * ── Warum es nichts nachrechnet ─────────────────────────────────────────
 * Dieselbe Lehre wie bei `diff-45b-verdraengung.ts`: `allocatedCents` ist
 * `totalCalculated + initialBalanceTotal + carryoverTotal (+ manual_adjustment)`,
 * und `totalCalculated` — die virtuelle Monatsaufstockung — hat keine Zeile in
 * `budget_allocations`. Wer über die Tabelle summiert, übersieht bei jedem
 * Kunden mit Aufstockung den größten Posten.
 *
 * Deshalb ruft das Skript `calculateAllocatedCents` auf. Die Zeilenwerte
 * daneben (Übertrag, Startwert) kommen aus der Tabelle, weil genau sie die
 * Größen sind, die Alrik gegen die Kassenauskunft hält.
 *
 * ── Rein lesend ─────────────────────────────────────────────────────────
 * Kein INSERT/UPDATE/DELETE. Gegen die Prod-Kopie oder Prod ausführbar.
 *
 *     tsx server/scripts/r3-bestandsliste-kassenauskunft.ts
 *     tsx server/scripts/r3-bestandsliste-kassenauskunft.ts --csv
 *
 * `--csv` gibt die Liste als Semikolon-CSV aus (Excel-tauglich), damit Alrik
 * die zwei Spalten direkt ausfüllen kann.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations, customers } from "@shared/schema";
import { calculateAllocatedCents } from "../storage/budget/allocation-storage";
import { formatEuroDE } from "@shared/utils/money";

const BUDGET_TYPE = "entlastungsbetrag_45b";

function monatsErster(jahr: number, monat: number): string {
  return `${jahr}-${String(monat).padStart(2, "0")}-01`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const alsCsv = args.includes("--csv");

  // Kunden mit AKTIVER `initial_balance`-Zeile — dieselbe Menge wie im
  // Mess-Lauf, bewusst nicht die veraltete Achter-Liste aus dem Code.
  const startwerte = await db
    .select({
      customerId: budgetAllocations.customerId,
      id: budgetAllocations.id,
      year: budgetAllocations.year,
      month: budgetAllocations.month,
      amountCents: budgetAllocations.amountCents,
      validFrom: budgetAllocations.validFrom,
    })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      eq(budgetAllocations.source, "initial_balance"),
      isNull(budgetAllocations.deletedAt),
    ));

  const uebertraege = await db
    .select({
      customerId: budgetAllocations.customerId,
      id: budgetAllocations.id,
      year: budgetAllocations.year,
      amountCents: budgetAllocations.amountCents,
      validFrom: budgetAllocations.validFrom,
      expiresAt: budgetAllocations.expiresAt,
    })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
    ));

  const namen = new Map(
    (await db.select({ id: customers.id, name: customers.name }).from(customers))
      .map(k => [k.id, k.name] as const),
  );

  type Zeile = {
    kunde: number;
    name: string;
    stichtag: string;
    startwertCents: number;
    uebertragCents: number | null;
    uebertragGueltigBis: string | null;
    anspruchZumStichtagCents: number;
  };
  const zeilen: Zeile[] = [];

  for (const sw of startwerte) {
    if (sw.month == null) continue;
    const stichtag = monatsErster(sw.year, sw.month);

    /**
     * Nur Kunden, bei denen zum Stichtag ueberhaupt ein Uebertrag daneben
     * liegt — das ist die Lage, ueber die R3 entscheidet. Ein Startwert ohne
     * Uebertrag ist nach Modell v2 eindeutig „Rest laufendes Jahr" und
     * braucht keine Rueckfrage.
     */
    const ue = uebertraege.find(u =>
      u.customerId === sw.customerId
      && u.validFrom <= stichtag
      && (!u.expiresAt || u.expiresAt >= stichtag));
    if (!ue) continue;

    // Die SSoT, nicht nachgebaut.
    const anspruch = await calculateAllocatedCents(sw.customerId, BUDGET_TYPE, {
      asOfDate: stichtag,
    });

    zeilen.push({
      kunde: sw.customerId,
      name: namen.get(sw.customerId) ?? "?",
      stichtag,
      startwertCents: sw.amountCents,
      uebertragCents: ue.amountCents,
      uebertragGueltigBis: ue.expiresAt,
      anspruchZumStichtagCents: anspruch,
    });
  }

  zeilen.sort((a, b) => a.kunde - b.kunde);

  if (alsCsv) {
    console.log([
      "Kunde", "Name", "Stichtag (Monat des Startwerts)",
      "System: Uebertrag heute", "Uebertrag gueltig bis",
      "System: Startwert heute", "System: Anspruch gesamt",
      "ALRIK: Rest Uebertrag Vorjahr", "ALRIK: Rest laufendes Jahr",
    ].join(";"));
    for (const z of zeilen) {
      console.log([
        z.kunde, `"${z.name}"`, z.stichtag,
        (z.uebertragCents ?? 0) / 100, z.uebertragGueltigBis ?? "",
        z.startwertCents / 100, z.anspruchZumStichtagCents / 100,
        "", "",
      ].join(";"));
    }
    return;
  }

  console.log("");
  console.log("R3 — Bestandsliste fuer die Kassenauskunft (Stammticket 6hXp9qMrXH2WGVVG)");
  console.log("=".repeat(100));
  console.log("");
  console.log(`Kunden mit Startwert UND gueltigem Uebertrag zum Startwert-Monat: ${zeilen.length}`);
  console.log("");
  console.log("Gebraucht wird je Zeile von Alrik: was sagte die Kasse zum Stichtag?");
  console.log("  (a) Rest Uebertrag Vorjahr   (b) Rest laufendes Jahr");
  console.log("");
  console.log(
    "Kunde".padEnd(7)
    + "Stichtag".padEnd(13)
    + "Uebertrag heute".padStart(17)
    + "verfaellt".padStart(13)
    + "Startwert heute".padStart(17)
    + "Anspruch ges.".padStart(15)
    + "   (a) / (b)",
  );
  console.log("-".repeat(100));
  for (const z of zeilen) {
    console.log(
      String(z.kunde).padEnd(7)
      + z.stichtag.padEnd(13)
      + formatEuroDE(z.uebertragCents ?? 0).padStart(17)
      + (z.uebertragGueltigBis ?? "—").padStart(13)
      + formatEuroDE(z.startwertCents).padStart(17)
      + formatEuroDE(z.anspruchZumStichtagCents).padStart(15)
      + "   ____ / ____",
    );
  }
  console.log("-".repeat(100));
  console.log("");
  console.log("Lesehilfe:");
  console.log("  · „Uebertrag heute\"  = die carryover-Zeile, wie sie im System steht");
  console.log("  · „Startwert heute\"  = die initial_balance-Zeile zum genannten Monat");
  console.log("  · „Anspruch ges.\"    = calculateAllocatedCents zum Stichtag, inkl.");
  console.log("                         Monatsaufstockung (die KEINE Tabellenzeile hat)");
  console.log("");
  console.log("Die Summe aus Uebertrag und Startwert ist NICHT der Anspruch — dazwischen");
  console.log("liegt die Aufstockung. Wer die zwei Zeilen addiert und sich wundert, hat");
  console.log("den groessten Posten uebersehen.");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("R3-Bestandsliste fehlgeschlagen:", e);
    process.exit(1);
  });
