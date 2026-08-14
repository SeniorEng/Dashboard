/**
 * EINMAL-WERKZEUG (Dry-Run, NUR LESEND) — §45b-Übertrag: halbjahresscharfe
 * Gegenrechnung zur heutigen jahresscharfen Verrechnung.
 *
 * ── One-off-Disziplin (CLAUDE.md) ────────────────────────────────────────
 * Temporäres Werkzeug. Nach „angewendet + verifiziert" wird diese Datei samt
 * `lib/45b-halfyear-math.ts` und `lib/__fixtures__/**` GELÖSCHT und durch ein
 * Protokoll unter `docs/corrections/<datum>_45b-halbjahres-split.md` ersetzt.
 * Die SSoT-Teile in `shared/domain/budget/anchor-45b.ts` bleiben — sie sind
 * Produktionscode, kein Werkzeug.
 *
 * ── Was es misst ─────────────────────────────────────────────────────────
 * `allocation-storage.ts:1598` verrechnet Verbrauch gegen den hereingerollten
 * Übertrag OHNE Halbjahres-Unterscheidung, obwohl dieser mit Ablauf des 30.06.
 * verfällt. Verbrauch danach wird von einem bereits verfallenen Guthaben
 * absorbiert → eigener Jahrestopf zu wenig belastet → `unused` zu groß → zu
 * hoher Übertrag wird PERSISTIERT (:1603) → Verfügbarkeit zu hoch → über
 * `invoice-data.ts:702` höhere §45b-Rechnung an die Pflegekasse.
 *
 * ── Wo die Rechnung liegt ────────────────────────────────────────────────
 * NICHT hier. `evaluate45bHalfYear` in `lib/45b-halfyear-math.ts` ist die
 * gemeinsame Funktion, auf die ein kommender Produktions-Fix aufsetzen KANN —
 * dann zieht sie vorher nach `shared/domain/budget/` um (siehe Lebensdauer-
 * Absatz dort); sie setzt
 * ausschließlich exportierte Produktionsteile zusammen
 * (`shared/domain/budget/anchor-45b.ts`). Dieses Skript beschafft nur Daten und
 * formatiert. Frühere Fassungen rechneten selbst — daraus entstanden zehn
 * gemessene Defekte, die der Vertrag
 * (`lib/__fixtures__/45b-halfyear-cases.ts`) jetzt verriegelt.
 *
 * Die Pro-Allocation-Maps aus `computeFifoAvailability` bleiben unberührt (#33).
 *
 * ── Read-only ────────────────────────────────────────────────────────────
 * Kein Schreibpfad, kein `--apply`. Die Korrektur gestellter Rechnungen ist ein
 * GoBD-Vorgang (Storno + Neuausstellung), keine Skript-Operation.
 *
 * Aufruf:
 *   DATABASE_URL=<prod-KOPIE> npx tsx server/scripts/fix-45b-halfyear-split-dryrun.ts
 *   … --json
 */
import { activeInvoiceCondition } from "../lib/appointment-invoiced";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import {
  budgetAllocations, budgetTransactions, customerBudgetTypeSettings,
  invoiceLineItems, invoices,
} from "@shared/schema";
import { getEarliestCareLevelStart } from "../storage/customer-mgmt/care-level";
import { formatEuroDE } from "@shared/utils/money";
import { todayISO } from "@shared/utils/datetime";
import {
  evaluate45bHalfYear, splitShortfall,
  carryoverTargetYear,
  type AllocRow, type CarryoverKeying, type SettingRow, type SplitRow, type TxRow,
} from "./lib/45b-halfyear-math";

const BT = "entlastungsbetrag_45b";

interface Row {
  customerId: number;
  sourceYear: number;
  targetYear: number;
  phantomCents: number;
  shortfallCents: number;
  gestelltCents: number;
  entwurfCents: number;
  nichtZugeordnetCents: number;
}

/**
 * Ein Lauf in EINEM Schluessel-Modell. Aufgerufen wird die Funktion pro Modus;
 * die Rechenlogik ist identisch, nur die Zuordnung Uebertrag->Zieljahr nicht.
 */
async function lauf(keying: CarryoverKeying, asOfIso: string): Promise<Row[]> {

  // Kandidaten über das FENSTER, nicht über `year` — siehe
  // `carryoverTargetYear` in lib/45b-halfyear-math.ts. Auf Prod tragen 26
  // Zeilen die Legacy-Konvention `year = sourceYear`; eine `year`-basierte
  // Auswertung bildete dort gar keine Paare mehr.
  const carryovers = await db.select({
    customerId: budgetAllocations.customerId,
    validFrom: budgetAllocations.validFrom,
    year: budgetAllocations.year,
  }).from(budgetAllocations).where(and(
    eq(budgetAllocations.budgetType, BT),
    eq(budgetAllocations.source, "carryover"),
    isNull(budgetAllocations.deletedAt),
  ));

  const kandidaten = new Map<string, { customerId: number; targetYear: number }>();
  for (const c of carryovers) {
    // Kandidatenbildung im SELBEN Modell wie die Bewertung — sonst bewertet
    // der Lauf Jahre, die er gar nicht als Kandidat gebildet hat.
    const targetYear = carryoverTargetYear(
      { ...c, month: null, amountCents: 0, source: "carryover", expiresAt: null } as AllocRow,
      keying,
    );
    kandidaten.set(`${c.customerId}|${targetYear}`, { customerId: c.customerId, targetYear });
  }

  const out: Row[] = [];
  const ineligible = new Set<number>();
  const nichtBewertbar: Array<{ customerId: number; sourceYear: number }> = [];

  for (const { customerId, targetYear } of kandidaten.values()) {
    const sourceYear = targetYear - 1;

    const [allocs, txs, settings, pgStart] = await Promise.all([
      db.select().from(budgetAllocations).where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, BT),
        isNull(budgetAllocations.deletedAt),
      )),
      db.select().from(budgetTransactions).where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, BT),
      )),
      db.select().from(customerBudgetTypeSettings).where(and(
        eq(customerBudgetTypeSettings.customerId, customerId),
        eq(customerBudgetTypeSettings.budgetType, BT),
      )).orderBy(asc(customerBudgetTypeSettings.validFrom)),
      getEarliestCareLevelStart(customerId, db),
    ]);

    const r = evaluate45bHalfYear({
      asOfIso,
      sourceYear,
      pgStartIso: pgStart ?? null,
      settings: settings as unknown as SettingRow[],
      allocations: allocs as unknown as AllocRow[],
      transactions: txs.map<TxRow>(t => ({
        date: t.transactionDate,
        type: t.transactionType as TxRow["type"],
        amountCents: t.amountCents,
      })),
      carryoverKeying: keying,
    });

    if (r.ineligible) { ineligible.add(customerId); continue; }
    if (r.notEvaluable) { nichtBewertbar.push({ customerId, sourceYear }); continue; }
    if (r.phantomCents <= 0 && r.shortfallCents <= 0) continue;

    const jahresZeilen = txs.filter(t =>
      t.transactionDate >= `${targetYear}-01-01` && t.transactionDate <= `${targetYear}-12-31`
      && (t.transactionType === "consumption" || t.transactionType === "reversal"));
    const apptIds = jahresZeilen.map(t => t.appointmentId).filter((x): x is number => x != null);
    const gestellteTermine = new Set<number>();
    if (apptIds.length > 0) {
      const inv = await db.selectDistinct({ appointmentId: invoiceLineItems.appointmentId })
        .from(invoiceLineItems)
        .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
        .where(and(
          inArray(invoiceLineItems.appointmentId, apptIds),
          // KEIN budget_type-Filter: NULL = Bestands-Rechnung vor #759 (Schema:
          // kein Backfill, GoBD). Sonst würde eine gestellte Altrechnung als
          // „Entwurf, nach vorn korrigierbar" ausgewiesen — GoBD-gefährlich.
          isNotNull(invoices.issuedAt),
          // Aktiv = DIE EINE SSoT. `storniert_at` allein reichte hier nicht und
          // der Kommentar sagte das auch — der Code prüfte trotzdem nur das
          // Datum. An echten Daten gemessen: ALLE 114 Gutschriften tragen
          // `storniert_at = NULL` und hätten als aktiv gezählt. Folgenlos war
          // das bisher nur, weil `issued_at` sie zufällig ausschließt (Gutschriften
          // tragen keins) — eine Invariante, die nichts erzwingt.
          activeInvoiceCondition(),
        ));
      for (const x of inv) if (x.appointmentId != null) gestellteTermine.add(x.appointmentId);
    }

    const split = splitShortfall(
      jahresZeilen.map<SplitRow>(t => ({
        id: t.id, date: t.transactionDate,
        type: t.transactionType as SplitRow["type"],
        amountCents: t.amountCents, appointmentId: t.appointmentId,
      })),
      r.shortfallCents,
      gestellteTermine,
      asOfIso,
    );

    out.push({
      customerId, sourceYear, targetYear,
      phantomCents: r.phantomCents,
      shortfallCents: r.shortfallCents,
      gestelltCents: split.gestellt,
      entwurfCents: split.entwurf,
      nichtZugeordnetCents: split.nichtZugeordnet,
    });
  }

  out.sort((a, b) => b.shortfallCents - a.shortfallCents || b.phantomCents - a.phantomCents);
  return out;
}

const KEY = (r: Row) => `${r.customerId}|${r.targetYear}`;

/**
 * GEGENPROBE: beide Schluessel-Modelle nebeneinander, Differenz je Kunde.
 *
 * Die Produktion schluesselt den hereinrollenden Uebertrag ueber die SPALTE
 * `year` (`allocation-storage.ts:1569`). Das Werkzeug wurde auf das FENSTER
 * (`valid_from`) umgestellt. Bei den Legacy-Zeilen (`year = sourceYear`)
 * fallen beide auseinander: die Produktion sieht so eine Zeile beim Roll des
 * Quelljahres als Zufluss, das Fenster-Modell erst ein Jahr spaeter.
 *
 * Welches Modell dem tatsaechlichen Produktions-Roll entspricht, ist OFFEN.
 * Diese Ausgabe setzt deshalb keines als richtig — sie zeigt, WO und WIE STARK
 * sie auseinanderlaufen, damit die Frage an den Daten entschieden werden kann.
 */
async function gegenprobe(asOfIso: string): Promise<void> {
  const [wYear, wWindow] = [await lauf("year", asOfIso), await lauf("window", asOfIso)];
  const mYear = new Map(wYear.map(r => [KEY(r), r]));
  const mWindow = new Map(wWindow.map(r => [KEY(r), r]));
  const alle = [...new Set([...mYear.keys(), ...mWindow.keys()])].sort();

  console.log(`\n§45b — GEGENPROBE der Schluessel-Modelle, Stichtag ${asOfIso}\n`);
  console.log(`Modell "year"   (wie Produktion): ${wYear.length} Kunden-Jahre`);
  console.log(`Modell "window" (Werkzeug)      : ${wWindow.length} Kunden-Jahre`);

  const diff = alle.filter(k => {
    const a = mYear.get(k), b = mWindow.get(k);
    return !a || !b || a.phantomCents !== b.phantomCents || a.shortfallCents !== b.shortfallCents;
  });
  console.log(`Abweichende Kunden-Jahre        : ${diff.length}\n`);

  if (diff.length > 0) {
    console.log("Kunde/Jahr".padEnd(14), "Phantom year".padStart(14), "Phantom window".padStart(15),
                "Fehlb. year".padStart(13), "Fehlb. window".padStart(14));
    for (const k of diff) {
      const a = mYear.get(k), b = mWindow.get(k);
      console.log(
        k.padEnd(14),
        (a ? formatEuroDE(a.phantomCents) : "—").padStart(14),
        (b ? formatEuroDE(b.phantomCents) : "—").padStart(15),
        (a ? formatEuroDE(a.shortfallCents) : "—").padStart(13),
        (b ? formatEuroDE(b.shortfallCents) : "—").padStart(14),
      );
    }
  }
  console.log(
    "\nHINWEIS: Keines der Modelle ist als richtig gesetzt. Ein '—' heisst, dass\n" +
    "das jeweilige Modell dieses Kunden-Jahr gar nicht als Kandidat bildet.\n" +
    "Welches dem Produktions-Roll 2025->2026 entspricht, entscheidet der\n" +
    "Abgleich mit den tatsaechlich persistierten Uebertraegen.",
  );
}

/**
 * Stichtag der Auswertung.
 *
 * `--as-of=YYYY-MM-DD` ist fuer die 45b-Rueckschau WESENTLICH, nicht bequem:
 * ein Uebertrag verfaellt zum 30.06. und faellt ab dem 01.07. samt seinem
 * Verbrauch symmetrisch aus der Verfuegbarkeitsrechnung. An einem H2-Stichtag
 * ist der Ueber-Ansatz deshalb NICHT sichtbar — gemessen wurde ein Delta von
 * exakt 0. Wer den Schaden auf H1-Rechnungen sucht, MUSS auf einen H1-Stichtag
 * stellen (bzw. je Rechnung auf deren Ausstellungszeitpunkt).
 *
 * Ohne Angabe: heute — das ist der richtige Default fuer "wie sieht es
 * gerade aus", aber der falsche fuer die Rueckschau.
 */
function stichtag(): string {
  const arg = process.argv.find(a => a.startsWith("--as-of="));
  if (!arg) return todayISO();
  const wert = arg.split("=")[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wert)) {
    console.error(`[45b-dryrun] --as-of erwartet YYYY-MM-DD, bekam: ${wert}`);
    process.exit(2);
  }
  return wert;
}

async function main(): Promise<void> {
  const asOfIso = stichtag();
  if (process.argv.includes("--compare-keying")) return gegenprobe(asOfIso);

  const arg = process.argv.find(a => a.startsWith("--keying="));
  const keying = arg?.split("=")[1];
  if (keying !== "year" && keying !== "window") {
    console.error(
      "[45b-dryrun] --keying=year|window ist PFLICHT (kein Default: die beiden\n" +
      "             Modelle laufen bei den Legacy-Zeilen auseinander), oder\n" +
      "             --compare-keying fuer beide nebeneinander.\n" +
      "             --as-of=YYYY-MM-DD setzt den Stichtag (Rueckschau auf H1!).",
    );
    process.exit(2);
  }
  const out = await lauf(keying, asOfIso);
  console.log(JSON.stringify({ asOfIso, keying, rows: out }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[45b-dryrun] Fehlgeschlagen:", err);
  process.exit(1);
});
