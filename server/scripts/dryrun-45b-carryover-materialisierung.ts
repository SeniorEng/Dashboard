/**
 * EINMAL-WERKZEUG (Dry-Run, NUR LESEND) — wie viele Übertragszeilen entstehen,
 * wenn der `{year}`-Pool-Fix ausgerollt wird?
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────
 * Auflage aus Ticket 6hQGvwCFvvMC7j6G (Comment 6hQH4Qh4HMvRx6Jp), Punkt 1.
 *
 * `ensureYearlyCarryover45b` läuft als SEITENEFFEKT aus Lese- und
 * Buchungspfaden. Vor dem Fix fand es für 97 von 163 aktiven §45b-Kunden
 * (59,5 %, Prod-Messung 02.09.2026) nichts — der Übertrags-Shift zog
 * `allocStart` im `{year}`-Modus auf das laufende Jahr, und damit fielen die
 * Monatsaufstockungen aller früheren Jahre aus dem Pool.
 *
 * Nach dem Fix liefert der Pool wieder Werte. Der ERSTE Lesezugriff pro Kunde
 * legt dann mehrere Übertragszeilen an — und `processExpiredCarryover` schreibt
 * für die abgelaufenen davon je einen `write_off` mit RÜCKDATIERTEM
 * `transaction_date`. Ein Massen-Schreibvorgang, ausgelöst durch Lesen.
 *
 * Die Verfügbarkeit bewegt sich dabei nicht — das hält `AN-4`
 * (`tests/budget/45b-carryover-anker-schreibpfad.test.ts`, aus PR #132) fest.
 * Die ZAHL der Zeilen und der Blick auf abgeschlossene Perioden ändern sich
 * sehr wohl, und deshalb wird sie vor dem Ausrollen beziffert statt geschätzt.
 *
 * ── Kein Nachbau ─────────────────────────────────────────────────────────
 * Das Skript ruft `planCarryoverRolls45b` — DIESELBE Funktion, die
 * `ensureYearlyCarryover45b` zum Schreiben benutzt, nur ohne den Insert. Es
 * misst damit den Fix selbst, nicht ein Modell davon. Ein zweiter Rechenweg
 * wäre genau die Drift, aus der dieser Cluster entstanden ist (siehe die
 * Kunde-54-Episode: Nachrechnung 429,90 € gegen gemessene 211,95 €).
 *
 * ── Read-only ────────────────────────────────────────────────────────────
 * Kein `insert`/`update`/`delete`, kein `--apply`. Der Aufruf ist gegen eine
 * Prod-KOPIE gedacht; gegen Prod selbst wäre er zwar folgenlos, aber die
 * Arbeitsregel ist eindeutig.
 *
 * ── One-off-Disziplin (CLAUDE.md) ────────────────────────────────────────
 * Temporäres Werkzeug. Nach „ausgerollt + verifiziert" wird diese Datei
 * GELÖSCHT und durch ein Protokoll unter
 * `docs/corrections/<datum>_45b-year-pool.md` ersetzt. `planCarryoverRolls45b`
 * bleibt — das ist Produktionscode.
 *
 * Aufruf:
 *   DATABASE_URL=<prod-KOPIE> npx tsx server/scripts/dryrun-45b-carryover-materialisierung.ts
 *   … --json          maschinenlesbar
 *   … --limit=20      nur die N größten Kunden ausgeben (Default 20)
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations, customerBudgetTypeSettings, customers } from "@shared/schema";
import { planCarryoverRolls45b } from "../storage/budget/allocation-storage";
import { formatEuroDE } from "@shared/utils/money";
import { todayISO } from "@shared/utils/datetime";

const BT = "entlastungsbetrag_45b";

interface KundenPlan {
  customerId: number;
  zeilen: number;
  jahre: number[];
  summeCents: number;
  /** Zeilen, deren Frist zum Stichtag schon abgelaufen ist → je ein write_off. */
  bereitsVerfallen: number;
  hatCurYearUebertrag: boolean;
}

async function main(): Promise<void> {
  const heute = todayISO();
  const alsJson = process.argv.includes("--json");
  const limitArg = process.argv.find(a => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 20;

  // Kandidaten: §45b in mindestens einer Phase aktiviert. Datumsunabhängig —
  // dieselbe Frage, die der Schreibpfad seit #132 stellt.
  const aktive = await db
    .selectDistinct({ customerId: customerBudgetTypeSettings.customerId })
    .from(customerBudgetTypeSettings)
    .innerJoin(customers, eq(customers.id, customerBudgetTypeSettings.customerId))
    .where(and(
      eq(customerBudgetTypeSettings.budgetType, BT),
      eq(customerBudgetTypeSettings.enabled, true),
      isNull(customers.deletedAt),
    ));

  // Wer hat heute schon eine Übertragszeile im laufenden Jahr? Das ist die
  // Gruppe, für die der Fix überhaupt etwas ändert (die 97).
  const curYear = Number(heute.slice(0, 4));
  const mitCurYear = new Set(
    (await db.selectDistinct({ customerId: budgetAllocations.customerId })
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.budgetType, BT),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
        sql`EXTRACT(YEAR FROM ${budgetAllocations.validFrom})::int = ${curYear}`,
      ))).map(r => r.customerId),
  );

  const plaene: KundenPlan[] = [];
  for (const { customerId } of aktive) {
    // DERSELBE Aufruf, den der Schreibpfad macht — nur ohne Insert.
    const geplant = await planCarryoverRolls45b(customerId);
    if (geplant.length === 0) continue;
    plaene.push({
      customerId,
      zeilen: geplant.length,
      jahre: geplant.map(g => g.targetYear).sort(),
      summeCents: geplant.reduce((s, g) => s + g.amountCents, 0),
      bereitsVerfallen: geplant.filter(g => g.expiresAt < heute).length,
      hatCurYearUebertrag: mitCurYear.has(customerId),
    });
  }

  plaene.sort((a, b) => b.zeilen - a.zeilen || b.summeCents - a.summeCents);

  const summe = {
    stichtag: heute,
    aktive45bKunden: aktive.length,
    kundenMitCurYearUebertrag: mitCurYear.size,
    kundenMitNeuenZeilen: plaene.length,
    neueUebertragsZeilen: plaene.reduce((s, p) => s + p.zeilen, 0),
    // Jede bereits abgelaufene Zeile zieht beim naechsten Sync einen
    // rueckdatierten write_off nach sich — das ist der eigentliche Grund
    // dieser Messung.
    erwarteteWriteOffs: plaene.reduce((s, p) => s + p.bereitsVerfallen, 0),
    summeCents: plaene.reduce((s, p) => s + p.summeCents, 0),
    maxZeilenProKunde: plaene.length > 0 ? plaene[0].zeilen : 0,
  };

  if (alsJson) {
    console.log(JSON.stringify({ summe, kunden: plaene }, null, 2));
    return;
  }

  console.log(`\n§45b — Materialisierung nach dem {year}-Pool-Fix (Dry-Run, Stichtag ${heute})\n`);
  console.log(`Aktive §45b-Kunden                : ${summe.aktive45bKunden}`);
  console.log(`davon mit curYear-Uebertragszeile : ${summe.kundenMitCurYearUebertrag}`);
  console.log(`Kunden mit NEUEN Zeilen           : ${summe.kundenMitNeuenZeilen}`);
  console.log(`Neue Uebertragszeilen gesamt      : ${summe.neueUebertragsZeilen}`);
  console.log(`davon schon verfallen -> write_off: ${summe.erwarteteWriteOffs}   <- rueckdatierte Buchungen`);
  console.log(`Maximum pro Kunde                 : ${summe.maxZeilenProKunde} Zeilen`);
  console.log(`Summe der neuen Uebertraege       : ${formatEuroDE(summe.summeCents)}`);

  if (plaene.length > 0) {
    console.log(`\nGroesste ${Math.min(limit, plaene.length)} Kunden:\n`);
    console.log("Kunde".padEnd(8), "Zeilen".padStart(7), "verfallen".padStart(10),
                "Summe".padStart(14), "  Zieljahre");
    for (const p of plaene.slice(0, limit)) {
      console.log(
        String(p.customerId).padEnd(8),
        String(p.zeilen).padStart(7),
        String(p.bereitsVerfallen).padStart(10),
        formatEuroDE(p.summeCents).padStart(14),
        "  " + p.jahre.join(", ") + (p.hatCurYearUebertrag ? "  [hatte curYear-Uebertrag]" : ""),
      );
    }
  }

  console.log(
    "\nHINWEIS: Die VERFUEGBARKEIT aendert sich durch diese Zeilen nicht (AN-4 in\n" +
    "tests/budget/45b-carryover-anker-schreibpfad.test.ts). Gemessen wird die ZAHL\n" +
    "der Zeilen und der Anteil rueckdatierter write_offs — das ist die Auflage aus\n" +
    "Ticket 6hQGvwCFvvMC7j6G.\n",
  );
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[45b-dryrun] Fehlgeschlagen:", err);
  process.exit(1);
});
