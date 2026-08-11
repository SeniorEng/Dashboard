/**
 * EINMAL-WERKZEUG (Dry-Run, NUR LESEND) — §45b-Übertrag: halbjahresscharfe
 * Gegenrechnung zur heutigen jahresscharfen Verrechnung.
 *
 * ── One-off-Disziplin (CLAUDE.md) ────────────────────────────────────────
 * Diese Datei ist ein temporäres Werkzeug. Nach „angewendet + verifiziert"
 * wird sie GELÖSCHT und durch ein Protokoll unter
 * `docs/corrections/<datum>_45b-halbjahres-split.md` ersetzt (Problem,
 * Maßnahme, Vorher/Nachher, Audit-Referenz). Das Protokoll ist der Nachweis,
 * nicht das liegengebliebene Skript. Liegenbleiben bricht `tsc`/CI, sobald
 * sich Signaturen ändern, und suggeriert einen wiederholbaren Vorgang, den es
 * nicht gibt. Wird daraus eine dauerhafte Fähigkeit, gehört sie als Feature
 * gebaut — nicht als Skript.
 *
 * ── Was es misst ─────────────────────────────────────────────────────────
 * `allocation-storage.ts:1598` verrechnet Verbrauch gegen den hereingerollten
 * Übertrag OHNE Halbjahres-Unterscheidung:
 *
 *     consumedAgainstOwnYear = max(0, netConsumed − totalCarryoverIn)
 *
 * Der Übertrag verfällt aber mit Ablauf des 30.06. Verbrauch NACH der Frist
 * wird dadurch von einem bereits verfallenen Guthaben absorbiert; der eigene
 * Jahrestopf wird zu wenig belastet, `unused` (:1599) zu groß, und der zu hohe
 * Übertrag wird als `budget_allocations`-Zeile PERSISTIERT (:1603). Von dort
 * speist er die Verfügbarkeit, die Kaskade und über
 * `invoice-data.ts:702` (`buildBudgetSplitFromLedger`) die §45b-Rechnung an
 * die Pflegekasse.
 *
 * ── Zwei Disziplinen, die dieses Skript einhält ──────────────────────────
 * 1. KEINE zweite Datumsrechnung. Die Frist kommt aus `carryoverWindowFor()`
 *    (`shared/domain/budget-carryover-dedup.ts`), der SSoT, die auch der
 *    Schreibpfad benutzt. Kein `${year}-06-30` in dieser Datei.
 * 2. KEIN Anfassen der Pro-Allocation-Maps. Die bewusst ungefilterten
 *    `consumedBySpecial`/`reversalBySpecial` aus `computeFifoAvailability`
 *    (siehe #33) werden hier weder gelesen noch nachgebaut. Dieses Skript
 *    aggregiert ausschließlich über `budget_transactions`.
 *
 * ── Read-only ────────────────────────────────────────────────────────────
 * Es gibt KEINEN Schreibpfad. Kein `insert`/`update`/`delete` wird importiert,
 * und ein `--apply` o.ä. existiert bewusst nicht — die Korrektur gestellter
 * Rechnungen ist ein GoBD-Vorgang (Storno + Neuausstellung) und keine
 * Skript-Operation.
 *
 * Aufruf:
 *   DATABASE_URL=<prod-KOPIE> npx tsx server/scripts/fix-45b-halfyear-split-dryrun.ts
 *   … --json     maschinenlesbare Ausgabe statt Tabelle
 */
import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "../lib/db";
import {
  budgetAllocations,
  budgetTransactions,
  invoiceLineItems,
  invoices,
} from "@shared/schema";
import { carryoverWindowFor } from "@shared/domain/budget-carryover-dedup";
import { calculateAllocatedCents } from "../storage/budget/allocation-storage";
import { readBudgetTypeSettings } from "../storage/budget/preferences-storage";
import { formatEuroDE } from "@shared/utils/money";

const BT = "entlastungsbetrag_45b";

interface Row {
  customerId: number;
  sourceYear: number;
  targetYear: number;
  /** Frist aus der SSoT — nicht hier gerechnet. */
  expiresAt: string;
  carryoverInIst: number;
  carryoverInSoll: number;
  phantomCents: number;
  geltendGemachtCents: number;
  korrekterRestCents: number;
  fehlbetragCents: number;
  fehlbetragGestelltCents: number;
  fehlbetragEntwurfCents: number;
}

/** Netto-Verbrauch (consumption+write_off − reversal) in einem Datumsfenster. */
async function netConsumedBetween(
  customerId: number, fromIso: string, toIso: string,
): Promise<number> {
  const [row] = await db.select({
    consumed: sql<number>`COALESCE(SUM(CASE WHEN ${budgetTransactions.transactionType} IN ('consumption','write_off') THEN ABS(${budgetTransactions.amountCents}) ELSE 0 END), 0)`,
    reversed: sql<number>`COALESCE(SUM(CASE WHEN ${budgetTransactions.transactionType} = 'reversal' THEN ABS(${budgetTransactions.amountCents}) ELSE 0 END), 0)`,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, BT),
    sql`${budgetTransactions.transactionDate} >= ${fromIso}`,
    lte(budgetTransactions.transactionDate, toIso),
  ));
  return Math.max(0, Number(row?.consumed ?? 0) - Number(row?.reversed ?? 0));
}

/**
 * Verteilt einen Fehlbetrag auf gestellte vs. Entwurfs-Rechnungen.
 *
 * Zuordnungsregel: der Fehlbetrag sind die ZULETZT verbrauchten Cent des
 * Jahres — der Teil, für den am Ende kein echtes Guthaben mehr da war. Wir
 * laufen die Verbrauchszeilen des Jahres also rückwärts nach Datum und
 * schneiden bei `fehlbetrag` ab. Das ist eine ZUORDNUNGS-Konvention, keine
 * fachliche Wahrheit — ein anderer Schnitt (anteilig, FIFO vorwärts) ergäbe
 * dieselbe Summe, aber eine andere Aufteilung gestellt/Entwurf.
 */
async function splitShortfallByInvoiceState(
  customerId: number, year: number, fehlbetragCents: number,
): Promise<{ gestellt: number; entwurf: number }> {
  if (fehlbetragCents <= 0) return { gestellt: 0, entwurf: 0 };

  const rows = await db.select({
    amount: budgetTransactions.amountCents,
    appointmentId: budgetTransactions.appointmentId,
    date: budgetTransactions.transactionDate,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, BT),
    eq(budgetTransactions.transactionType, "consumption"),
    sql`${budgetTransactions.transactionDate} >= ${`${year}-01-01`}`,
    lte(budgetTransactions.transactionDate, `${year}-12-31`),
  )).orderBy(sql`${budgetTransactions.transactionDate} DESC`);

  const apptIds = rows.map(r => r.appointmentId).filter((x): x is number => x != null);
  const issuedAppts = new Set<number>();
  if (apptIds.length > 0) {
    const inv = await db.selectDistinct({ appointmentId: invoiceLineItems.appointmentId })
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
      .where(and(
        inArray(invoiceLineItems.appointmentId, apptIds),
        eq(invoices.budgetType, BT),
        isNotNull(invoices.issuedAt),
        isNull(invoices.storniertAt),
      ));
    for (const r of inv) if (r.appointmentId != null) issuedAppts.add(r.appointmentId);
  }

  let rest = fehlbetragCents;
  let gestellt = 0;
  let entwurf = 0;
  for (const r of rows) {
    if (rest <= 0) break;
    const take = Math.min(rest, Math.abs(r.amount));
    if (r.appointmentId != null && issuedAppts.has(r.appointmentId)) gestellt += take;
    else entwurf += take;
    rest -= take;
  }
  return { gestellt, entwurf };
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");

  // Kandidaten: jedes (Kunde, Zieljahr), in das ein Übertrag hereinrollte.
  const carryovers = await db.select({
    customerId: budgetAllocations.customerId,
    targetYear: budgetAllocations.year,
    amountCents: budgetAllocations.amountCents,
    expiresAt: budgetAllocations.expiresAt,
  }).from(budgetAllocations).where(and(
    eq(budgetAllocations.budgetType, BT),
    eq(budgetAllocations.source, "carryover"),
    isNull(budgetAllocations.deletedAt),
  ));

  const byKey = new Map<string, { customerId: number; targetYear: number; carryoverIn: number }>();
  for (const c of carryovers) {
    const key = `${c.customerId}|${c.targetYear}`;
    const prev = byKey.get(key);
    if (prev) prev.carryoverIn += c.amountCents;
    else byKey.set(key, { customerId: c.customerId, targetYear: c.targetYear, carryoverIn: c.amountCents });
  }

  const out: Row[] = [];

  for (const { customerId, targetYear, carryoverIn } of byKey.values()) {
    const sourceYear = targetYear - 1;
    // Frist aus der SSoT — bewusst nicht hier gerechnet.
    const { expiresAt, validFrom } = carryoverWindowFor(sourceYear);

    const typeSettings = await readBudgetTypeSettings(
      customerId, { kind: "forDate", asOfDate: `${targetYear}-12-31` },
    );

    // Anspruch des QUELLJAHRES — bestimmt, wie viel überhaupt rollen konnte.
    const sourceYearAllocated = await calculateAllocatedCents(
      customerId, BT, { year: sourceYear }, undefined, undefined, typeSettings,
    );

    // IST: jahresscharf, so wie :1598 heute rechnet.
    const netSourceYear = await netConsumedBetween(customerId, `${sourceYear}-01-01`, `${sourceYear}-12-31`);
    // Der Übertrag, der IN das Quelljahr rollte (Vorjahres-Übertrag):
    const prevCarryIn = byKey.get(`${customerId}|${sourceYear}`)?.carryoverIn ?? 0;
    const consumedOwnIst = Math.max(0, netSourceYear - prevCarryIn);
    const unusedIst = Math.max(0, sourceYearAllocated - consumedOwnIst);

    // SOLL: nur Verbrauch BIS zur Frist des Vorjahres-Übertrags darf diesen
    // absorbieren. Die Frist des Vorjahres-Übertrags ist die des Fensters,
    // das im Quelljahr endet.
    const prevExpiry = carryoverWindowFor(sourceYear - 1).expiresAt;
    const netBisFrist = await netConsumedBetween(customerId, `${sourceYear}-01-01`, prevExpiry);
    const absorbed = Math.min(prevCarryIn, netBisFrist);
    const consumedOwnSoll = Math.max(0, netSourceYear - absorbed);
    const unusedSoll = Math.max(0, sourceYearAllocated - consumedOwnSoll);

    const phantom = unusedIst - unusedSoll;

    // Zieljahr: was wurde geltend gemacht, was wäre korrekt verfügbar gewesen?
    const geltendGemacht = await netConsumedBetween(customerId, validFrom, `${targetYear}-12-31`);
    const targetYearAllocated = await calculateAllocatedCents(
      customerId, BT, { year: targetYear }, undefined, undefined, typeSettings,
    );
    // Korrekter Rest = Zieljahres-Anspruch + KORRIGIERTER Übertrag.
    const korrekterRest = targetYearAllocated + Math.max(0, carryoverIn - Math.max(0, phantom));
    const fehlbetrag = Math.max(0, geltendGemacht - korrekterRest);

    if (phantom <= 0 && fehlbetrag <= 0) continue;

    const split = await splitShortfallByInvoiceState(customerId, targetYear, fehlbetrag);

    out.push({
      customerId, sourceYear, targetYear, expiresAt,
      carryoverInIst: carryoverIn,
      carryoverInSoll: Math.max(0, carryoverIn - Math.max(0, phantom)),
      phantomCents: Math.max(0, phantom),
      geltendGemachtCents: geltendGemacht,
      korrekterRestCents: korrekterRest,
      fehlbetragCents: fehlbetrag,
      fehlbetragGestelltCents: split.gestellt,
      fehlbetragEntwurfCents: split.entwurf,
    });
  }

  out.sort((a, b) => b.fehlbetragCents - a.fehlbetragCents);

  if (asJson) {
    console.log(JSON.stringify({ rows: out }, null, 2));
    return;
  }

  console.log("\n§45b — halbjahresscharfe Gegenrechnung (DRY-RUN, nur lesend)\n");
  if (out.length === 0) {
    console.log("Keine Abweichung gefunden.\n");
    return;
  }
  console.log(
    "Kunde".padStart(6), "Jahr".padStart(6), "Frist".padStart(12),
    "Phantom".padStart(12), "geltend".padStart(12), "korrekt".padStart(12),
    "Fehlbetrag".padStart(12), "davon gestellt".padStart(15), "davon Entwurf".padStart(15),
  );
  for (const r of out) {
    console.log(
      String(r.customerId).padStart(6), String(r.targetYear).padStart(6), r.expiresAt.padStart(12),
      formatEuroDE(r.phantomCents).padStart(12),
      formatEuroDE(r.geltendGemachtCents).padStart(12),
      formatEuroDE(r.korrekterRestCents).padStart(12),
      formatEuroDE(r.fehlbetragCents).padStart(12),
      formatEuroDE(r.fehlbetragGestelltCents).padStart(15),
      formatEuroDE(r.fehlbetragEntwurfCents).padStart(15),
    );
  }
  const sum = (f: (r: Row) => number) => out.reduce((s, r) => s + f(r), 0);
  console.log("\n--- Summen ---");
  console.log(`Betroffene Kunden-Jahre : ${out.length}`);
  console.log(`Betroffene Kunden       : ${new Set(out.map(r => r.customerId)).size}`);
  console.log(`Phantom-Übertrag gesamt : ${formatEuroDE(sum(r => r.phantomCents))}`);
  console.log(`Fehlbetrag gesamt       : ${formatEuroDE(sum(r => r.fehlbetragCents))}`);
  console.log(`  davon auf gestellten  : ${formatEuroDE(sum(r => r.fehlbetragGestelltCents))}  ← GoBD: Storno + Neuausstellung`);
  console.log(`  davon auf Entwürfen   : ${formatEuroDE(sum(r => r.fehlbetragEntwurfCents))}  ← nach vorn korrigierbar`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[45b-dryrun] Fehlgeschlagen:", err);
    process.exit(1);
  });
