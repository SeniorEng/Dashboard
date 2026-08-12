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
 * gemeinsame Funktion, die auch der kommende Produktions-Fix benutzt; sie setzt
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
  type AllocRow, type SettingRow, type SplitRow, type TxRow,
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

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const asOfIso = todayISO();

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
  let legacyYearZeilen = 0;
  for (const c of carryovers) {
    const targetYear = Number(c.validFrom.slice(0, 4));
    if (c.year !== targetYear) legacyYearZeilen++;
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
          // Aktiv = beides. `storniert_at` allein reicht nicht: Altbestand kann
          // status='storniert' bei leerem storniert_at tragen.
          isNull(invoices.storniertAt),
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

  if (asJson) {
    // Warnungen gehören MIT in die maschinenlesbare Ausgabe — sonst sieht ein
    // Konsument „belastbare" Zahlen ohne jeden Hinweis.
    console.log(JSON.stringify({ asOfIso, rows: out, ineligibleCustomerIds: [...ineligible], nichtBewertbar }, null, 2));
    return;
  }

  console.log(`\n§45b — halbjahresscharfe Gegenrechnung (DRY-RUN, nur lesend), Stichtag ${asOfIso}\n`);
  if (out.length === 0) {
    console.log("Keine Abweichung gefunden.\n");
  } else {
    console.log(
      "Kunde".padStart(6), "Jahr".padStart(6), "Phantom".padStart(12),
      "Fehlbetrag".padStart(12), "gestellt".padStart(12), "Entwurf".padStart(12), "offen".padStart(10),
    );
    for (const r of out) {
      console.log(
        String(r.customerId).padStart(6), String(r.targetYear).padStart(6),
        formatEuroDE(r.phantomCents).padStart(12),
        formatEuroDE(r.shortfallCents).padStart(12),
        formatEuroDE(r.gestelltCents).padStart(12),
        formatEuroDE(r.entwurfCents).padStart(12),
        formatEuroDE(r.nichtZugeordnetCents).padStart(10),
      );
    }
    const sum = (f: (r: Row) => number) => out.reduce((s, r) => s + f(r), 0);
    console.log("\n--- Summen ---");
    console.log(`Betroffene Kunden-Jahre : ${out.length}`);
    console.log(`Betroffene Kunden       : ${new Set(out.map(r => r.customerId)).size}`);
    console.log(`Phantom-Übertrag gesamt : ${formatEuroDE(sum(r => r.phantomCents))}`);
    console.log(`Fehlbetrag gesamt       : ${formatEuroDE(sum(r => r.shortfallCents))}`);
    console.log(`  davon gestellt        : ${formatEuroDE(sum(r => r.gestelltCents))}  ← GoBD: Storno + Neuausstellung`);
    console.log(`  davon Entwurf         : ${formatEuroDE(sum(r => r.entwurfCents))}  ← nach vorn korrigierbar`);
    console.log(`  nicht zugeordnet      : ${formatEuroDE(sum(r => r.nichtZugeordnetCents))}`);
  }
  if (nichtBewertbar.length > 0) {
    console.log(
      `\nNICHT BEWERTBAR: ${nichtBewertbar.length} Kunden-Jahr(e) — das Quelljahr liegt ausserhalb des\n` +
      `Anspruchsfensters (davor ODER dahinter); die Herkunft des Uebertrags ist aus den\n` +
      `vorhandenen Daten nicht rekonstruierbar.\n` +
      `Diese Zeilen sind WEDER geprueft NOCH entlastet: ` +
      nichtBewertbar.map(n => `${n.customerId}/${n.sourceYear}`).join(", "),
    );
  }
  // LEGENDE — bekannte Verzerrungen. Ohne sie liest sich "wenig gefunden" als
  // Entwarnung, obwohl beide Systematiken die Treffermenge nach UNTEN druecken.
  console.log(
    "\n--- Legende: bekannte Verzerrungen (beide nach unten) ---\n" +
    "  * Settings-Luecke: deckt keine Phasenzeile einen Monat ab, rechnet dieses\n" +
    "    Werkzeug mit dem gesetzlichen Hoechstbetrag, der Schreibpfad dagegen mit\n" +
    "    dem konfigurierten Kundensatz. Bei reduziertem Satz ist der Anspruch\n" +
    "    hier zu hoch -> Phantom und Fehlbetrag zu NIEDRIG (S-4).\n" +
    "  * Zieljahres-Verfuegbarkeit wird gegen den KORRIGIERTEN Uebertrag\n" +
    "    gerechnet, nicht gegen den persistierten. Liegt der persistierte\n" +
    "    darunter (Unterdeckung), ist der Fehlbetrag zu niedrig und die\n" +
    "    Unterdeckung wird gar nicht ausgewiesen (S-5).\n" +
    "  * 'Nicht bewertbar' heisst WEDER geprueft NOCH entlastet.\n" +
    "  Ein kleines Ergebnis ist damit keine Entwarnung.",
  );

  if (legacyYearZeilen > 0) {
    console.log(
      `\nHinweis: ${legacyYearZeilen} Uebertragszeile(n) tragen die Legacy-Konvention\n` +
      `\`year = sourceYear\`. Die Auswertung schluesselt ueber \`valid_from\` und erfasst sie;\n` +
      `eine \`year\`-basierte Auswertung haette sie verfehlt.`,
    );
  }
  if (ineligible.size > 0) {
    console.log(`\nOhne §45b-Anspruch (Eligibility-Gate), nicht bewertet: ${ineligible.size} Kunde(n).`);
  }
  console.log("");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[45b-dryrun] Fehlgeschlagen:", err);
  process.exit(1);
});
