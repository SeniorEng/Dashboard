/**
 * EINMAL-WERKZEUG (Analyse, NUR LESEND) — verfällt §45b-Anspruch still, weil
 * `floorAutoAnchor45bToCurrentYear` jeden Automatik-Übertrag vor `curYear`
 * blockiert?
 *
 * ── Die Frage ────────────────────────────────────────────────────────────
 * Der Anker-Floor (Task #860/#1204) erdet den aus der Pflegegrad-Historie
 * abgeleiteten Anker auf den 01.01. des LAUFENDEN Jahres — „das Vorjahr gilt
 * als aufgebraucht". Für einen frisch angelegten Kunden ist das richtig: aus
 * seiner Pflegegrad-Historie sollen keine Ansprüche rückwirkend materialisiert
 * werden, die nie bestanden.
 *
 * Für einen Bestandskunden im zweiten Jahr bedeutet derselbe Floor aber, dass
 * `ensureYearlyCarryover45b` NIE ein Quelljahr zu bearbeiten bekommt
 * (`yearsToProcess` filtert `y >= curYear`). Ein Übertrag entsteht dann nur
 * noch, wenn ein Mensch ihn anlegt. Gemessen an `engeldesk_ref` (02.09.2026)
 * tragen 87 von 99 Übertragszeilen für 2026 eine `created_by_user_id` — was zu
 * genau diesem Bild passt, es aber nicht beweist.
 *
 * Dieses Skript beantwortet die Geldfrage: WIE VIEL Anspruch ist dadurch
 * verfallen?
 *
 * ── Rechnet NICHT selbst ─────────────────────────────────────────────────
 * Es ruft `evaluate45bHalfYear` (`shared/domain/budget/halfyear-45b.ts`) —
 * dieselbe Funktion, die der Halbjahres-Dry-Run fährt, verriegelt durch 14
 * Vertragsfälle. Der einzige Unterschied zum Produktionspfad ist EIN Parameter:
 * `floorPgAnchor` ist dort die Identität (Rückschau), im Produktionspfad die
 * Erdung auf das laufende Jahr. Genau diese Differenz ist der Prüfgegenstand.
 *
 * Ein eigener Rechenweg wäre hier besonders gefährlich: aus den Zahlen sollen
 * Kundengespräche folgen. Siehe die Kunde-54-Episode, wo eine Nachrechnung
 * 429,90 € gegen gemessene 211,95 € ergab.
 *
 * ── SELBSTPRÜFUNG: Datenabdeckung ────────────────────────────────────────
 * Das Skript BRICHT AB, wenn die Datenbank für das Quelljahr keine
 * Bewegungsdaten hat. Grund: ein erster Lauf gegen die pseudonymisierte Kopie
 * `engeldesk_ref` meldete 74 betroffene Kunden und 64.837,30 € „verlorenen"
 * Anspruch — vollständig ein Artefakt. Die Kopie enthält keine Transaktionen
 * vor 2026, der Rückschau-Anspruch wurde also gegen einen Verbrauch von null
 * gerechnet. Vier der fünf größten Fälle zeigten exakt 12 × 131 € bei null
 * Verbrauch: die Signatur eines leeren Datensatzes, nicht eines Verfalls.
 *
 * Eine Zahl, die aus fehlenden Daten entsteht, sieht aus wie ein Befund. Der
 * Abbruch ist deshalb kein Komfort, sondern der Kern des Werkzeugs.
 *
 * ── Read-only ────────────────────────────────────────────────────────────
 * Kein `insert`/`update`/`delete`, kein `--apply`. Für den Lauf gegen Prod
 * zusätzlich `PGOPTIONS=-c default_transaction_read_only=on` setzen (Muster
 * aus der Kunde-54-Messung): Postgres lehnt dann jedes Schreiben ab, auch bei
 * einem Fehler im Skript.
 *
 * ── One-off-Disziplin (CLAUDE.md) ────────────────────────────────────────
 * Temporäres Werkzeug. Nach der Entscheidung (gewollte Feature-Grenze vs.
 * stiller Verfall) wird diese Datei GELÖSCHT und durch ein Protokoll unter
 * `docs/corrections/<datum>_45b-anker-floor.md` ersetzt.
 *
 * Aufruf:
 *   DATABASE_URL=<prod> PGOPTIONS="-c default_transaction_read_only=on" \
 *     npx tsx server/scripts/analyse-45b-anker-floor-verfall.ts
 *   … --source-year=2025   Quelljahr (Default: Vorjahr)
 *   … --json               maschinenlesbar
 *   … --top=5              wie viele Kunden einzeln (Default 5)
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import {
  budgetAllocations, budgetTransactions, customerBudgetTypeSettings, customers,
} from "@shared/schema";
import { getEarliestCareLevelStart } from "../storage/customer-mgmt/care-level";
import {
  evaluate45bHalfYear, type AllocRow, type SettingRow, type TxRow,
} from "@shared/domain/budget/halfyear-45b";
import { carryoverExpiresAtFor } from "@shared/domain/budget/expiry-45b";
import { formatEuroDE } from "@shared/utils/money";
import { todayISO } from "@shared/utils/datetime";

const BT = "entlastungsbetrag_45b";

interface Befund {
  customerId: number;
  sollUebertragCents: number;
  persistiertCents: number;
  verlorenCents: number;
  quelljahrAnspruchCents: number;
}

function argInt(name: string, fallback: number): number {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  if (!a) return fallback;
  const n = Number(a.split("=")[1]);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Bricht ab, wenn für das Quelljahr keine Bewegungsdaten vorliegen.
 *
 * Ohne diesen Riegel liefert das Skript den vollen Jahresanspruch als
 * „verloren" — plausibel aussehend und komplett falsch.
 */
async function pruefeDatenabdeckung(quelljahr: number): Promise<void> {
  const [tx] = await db.select({ n: sql<number>`count(*)::int` })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.budgetType, BT),
      sql`${budgetTransactions.transactionDate} BETWEEN ${`${quelljahr}-01-01`} AND ${`${quelljahr}-12-31`}`,
    ));

  const n = Number(tx?.n ?? 0);
  if (n > 0) {
    console.log(`[abdeckung] ${n} §45b-Transaktionen in ${quelljahr} — Datenlage plausibel.\n`);
    return;
  }

  const [spanne] = await db.select({
    von: sql<string>`MIN(${budgetTransactions.transactionDate})::text`,
    bis: sql<string>`MAX(${budgetTransactions.transactionDate})::text`,
    gesamt: sql<number>`count(*)::int`,
  }).from(budgetTransactions).where(eq(budgetTransactions.budgetType, BT));

  console.error(
    `\nABBRUCH: keine §45b-Transaktionen im Quelljahr ${quelljahr}.\n\n` +
    `  vorhandene Spanne: ${spanne?.von ?? "—"} .. ${spanne?.bis ?? "—"} (${spanne?.gesamt ?? 0} Zeilen)\n\n` +
    `Ohne Verbrauchsdaten des Quelljahres rechnet die Auswertung den vollen\n` +
    `Jahresanspruch als "verloren" — eine Zahl, die aussieht wie ein Befund und\n` +
    `keiner ist. Genau so ist der Lauf gegen die pseudonymisierte Kopie\n` +
    `engeldesk_ref am 02.09.2026 auf 64.837,30 EUR gekommen.\n\n` +
    `Gegen eine Datenbank MIT ${quelljahr}er Bewegungsdaten laufen lassen\n` +
    `(Prod oder eine Kopie, die das Vorjahr enthaelt).\n`,
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const heute = todayISO();
  const quelljahr = argInt("source-year", Number(heute.slice(0, 4)) - 1);
  const zieljahr = quelljahr + 1;
  const frist = carryoverExpiresAtFor(zieljahr);
  const top = argInt("top", 5);
  const alsJson = process.argv.includes("--json");

  await pruefeDatenabdeckung(quelljahr);

  const aktive = await db.selectDistinct({ id: customerBudgetTypeSettings.customerId })
    .from(customerBudgetTypeSettings)
    .innerJoin(customers, eq(customers.id, customerBudgetTypeSettings.customerId))
    .where(and(
      eq(customerBudgetTypeSettings.budgetType, BT),
      eq(customerBudgetTypeSettings.enabled, true),
      isNull(customers.deletedAt),
    ));

  const befunde: Befund[] = [];
  let bewertet = 0, uebersprungen = 0, gerettet = 0;

  for (const { id } of aktive) {
    const [allocs, txs, settings, pgStart] = await Promise.all([
      db.select().from(budgetAllocations).where(and(
        eq(budgetAllocations.customerId, id),
        eq(budgetAllocations.budgetType, BT),
        isNull(budgetAllocations.deletedAt))),
      db.select().from(budgetTransactions).where(and(
        eq(budgetTransactions.customerId, id),
        eq(budgetTransactions.budgetType, BT))),
      db.select().from(customerBudgetTypeSettings).where(and(
        eq(customerBudgetTypeSettings.customerId, id),
        eq(customerBudgetTypeSettings.budgetType, BT)))
        .orderBy(asc(customerBudgetTypeSettings.validFrom)),
      getEarliestCareLevelStart(id, db),
    ]);

    // Stichtag = Frist des Zieljahres: bis dahin haette der Uebertrag genutzt
    // werden koennen. Danach ist er ohnehin verfallen.
    const r = evaluate45bHalfYear({
      asOfIso: frist,
      sourceYear: quelljahr,
      pgStartIso: pgStart ?? null,
      settings: settings as unknown as SettingRow[],
      allocations: allocs as unknown as AllocRow[],
      transactions: txs.map<TxRow>(t => ({
        date: t.transactionDate,
        type: t.transactionType as TxRow["type"],
        amountCents: t.amountCents,
        allocationId: t.allocationId,
      })),
      carryoverKeying: "window",
    });

    if (r.ineligible || r.notEvaluable) { uebersprungen++; continue; }
    bewertet++;

    const persistiert = allocs
      .filter(a => a.source === "carryover" && Number(a.validFrom.slice(0, 4)) === zieljahr)
      .reduce((s, a) => s + a.amountCents, 0);

    if (r.carryoverOutSollCents <= 0) continue;
    if (persistiert > 0) gerettet++;

    const verloren = Math.max(0, r.carryoverOutSollCents - persistiert);
    if (verloren <= 0) continue;

    befunde.push({
      customerId: id,
      sollUebertragCents: r.carryoverOutSollCents,
      persistiertCents: persistiert,
      verlorenCents: verloren,
      quelljahrAnspruchCents: r.sourceYearEntitlementCents,
    });
  }

  befunde.sort((a, b) => b.verlorenCents - a.verlorenCents);
  const summeVerloren = befunde.reduce((s, b) => s + b.verlorenCents, 0);

  const ergebnis = {
    quelljahr, zieljahr, frist, stichtag: heute,
    aktive45bKunden: aktive.length,
    bewertet,
    uebersprungen,
    mitUnverbrauchtemAnspruch: befunde.length + gerettet,
    davonGerettet: gerettet,
    davonVerfallen: befunde.length,
    verlorenGesamtCents: summeVerloren,
    verlorenGesamtEuro: formatEuroDE(summeVerloren),
    ampel: befunde.length === 0
      ? "GEWOLLT — kein unverbrauchter Anspruch ohne Uebertrag"
      : "STILLER VERFALL — Anspruch ohne Uebertrag verfallen",
  };

  if (alsJson) {
    console.log(JSON.stringify({ ergebnis, betroffene: befunde.slice(0, top) }, null, 2));
    return;
  }

  console.log(`\n§45b — stiller Anspruchsverfall durch den Anker-Floor?`);
  console.log(`Quelljahr ${quelljahr} -> Zieljahr ${zieljahr}, Frist ${frist}\n`);
  console.log(`Aktive §45b-Kunden                    : ${ergebnis.aktive45bKunden}`);
  console.log(`davon bewertbar                       : ${ergebnis.bewertet}`);
  console.log(`  (uebersprungen: ineligible/ausserhalb: ${ergebnis.uebersprungen})`);
  console.log(`Mit unverbrauchtem ${quelljahr}er Anspruch  : ${ergebnis.mitUnverbrauchtemAnspruch}`);
  console.log(`  davon MIT ${zieljahr}er Uebertrag (gerettet): ${ergebnis.davonGerettet}`);
  console.log(`  davon OHNE Uebertrag (verfallen)     : ${ergebnis.davonVerfallen}`);
  console.log(`\nVerlorener Anspruch gesamt            : ${ergebnis.verlorenGesamtEuro}`);
  console.log(`\nAMPEL: ${ergebnis.ampel}\n`);

  if (befunde.length > 0) {
    console.log(`Groesste ${Math.min(top, befunde.length)} betroffene Kunden:\n`);
    console.log("Kunde".padEnd(8), "Anspruch".padStart(13), "Soll-Uebertrag".padStart(16),
                "persistiert".padStart(13), "VERLOREN".padStart(13));
    for (const b of befunde.slice(0, top)) {
      console.log(
        String(b.customerId).padEnd(8),
        formatEuroDE(b.quelljahrAnspruchCents).padStart(13),
        formatEuroDE(b.sollUebertragCents).padStart(16),
        formatEuroDE(b.persistiertCents).padStart(13),
        formatEuroDE(b.verlorenCents).padStart(13),
      );
    }
    console.log(
      `\nHINWEIS: "verloren" = Soll-Uebertrag minus tatsaechlich persistiertem.\n` +
      `Der Betrag stand dem Kunden im 1. Halbjahr ${zieljahr} nicht zur Verfuegung.\n` +
      `Vor einem Kundengespraech den Einzelfall pruefen — die Zahl ist eine\n` +
      `Rueckschau-Rechnung, kein Kontoauszug.\n`,
    );
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[45b-anker-floor] Fehlgeschlagen:", err);
  process.exit(1);
});
