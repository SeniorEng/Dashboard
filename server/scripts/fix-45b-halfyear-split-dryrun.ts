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
import { computeCarryoverPhantom, computeShortfall, sourceYearEntitlementCents } from "./lib/45b-halfyear-math";
import { pickEffective45bSettingRow } from "../storage/budget/allocation-storage";
import { clampToStatutoryMax, BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";
import { getEarliestCareLevelStart } from "../storage/customer-mgmt/care-level";

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
  fehlbetragNichtZugeordnetCents: number;
}

/**
 * Netto-VERBRAUCH (consumption − reversal) in einem Datumsfenster.
 *
 * `write_off` ist bewusst AUSGESCHLOSSEN. Der Verfalls-Write-Off liegt per
 * `addDays(expiresAt, 1)` auf dem 01.07. und fiel damit ins Jahresfenster,
 * aber nicht ins Fenster „bis Frist" — die Asymmetrie blähte den
 * Phantom-Betrag um genau den Write-Off auf (gemessen: 25 % zu viel) und
 * erfand Fehlbeträge bei Kunden ohne jede Überzahlung. Fachlich ist er auch
 * kein Verbrauch gegen den eigenen Topf, sondern das Verfallen des Übertrags.
 */
async function netConsumptionBetween(
  customerId: number, fromIso: string, toIso: string,
): Promise<number> {
  const [row] = await db.select({
    consumed: sql<number>`COALESCE(SUM(CASE WHEN ${budgetTransactions.transactionType} = 'consumption' THEN ABS(${budgetTransactions.amountCents}) ELSE 0 END), 0)`,
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
 *
 * Der `id`-Tiebreaker ist Pflicht: mehrere Verbrauchszeilen am selben Tag sind
 * der Normalfall, und ohne ihn koennen zwei Laeufe auf identischen Daten
 * verschieden aufteilen.
 */
async function splitShortfallByInvoiceState(
  customerId: number, year: number, fehlbetragCents: number,
): Promise<{ gestellt: number; entwurf: number; nichtZugeordnet: number }> {
  if (fehlbetragCents <= 0) return { gestellt: 0, entwurf: 0, nichtZugeordnet: 0 };

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
  )).orderBy(sql`${budgetTransactions.transactionDate} DESC, ${budgetTransactions.id} DESC`);

  const apptIds = rows.map(r => r.appointmentId).filter((x): x is number => x != null);
  const issuedAppts = new Set<number>();
  if (apptIds.length > 0) {
    const inv = await db.selectDistinct({ appointmentId: invoiceLineItems.appointmentId })
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
      .where(and(
        inArray(invoiceLineItems.appointmentId, apptIds),
        // KEIN `eq(invoices.budgetType, BT)`: `budget_type` ist NULL für
        // Bestands-Rechnungen vor Task #759 (Schema sagt ausdrücklich: kein
        // Backfill, GoBD). Eine gestellte Altrechnung wäre damit unsichtbar
        // geworden und im Eimer „Entwurf — nach vorn korrigierbar" gelandet.
        // Das ist die GoBD-gefährliche Richtung, deshalb hier NICHT filtern.
        isNotNull(invoices.issuedAt),
        // Aktiv = beide Bedingungen. `storniert_at` allein reicht nicht: es
        // wird nur in `billing-storage.ts` mitgesetzt, Altbestand kann
        // `status='storniert'` bei leerem `storniert_at` tragen und würde
        // sonst als aktiv gestellt gelten (Storno-Forderung auf einen bereits
        // stornierten Beleg).
        sql`${invoices.status} <> 'storniert'`,
        isNull(invoices.storniertAt),
      ));
    for (const r of inv) if (r.appointmentId != null) issuedAppts.add(r.appointmentId);
  }

  let rest = fehlbetragCents;
  let gestellt = 0;
  let entwurf = 0;
  let nichtZugeordnet = 0;
  for (const r of rows) {
    if (rest <= 0) break;
    const take = Math.min(rest, Math.abs(r.amount));
    // Ohne `appointmentId` (Import-Buchungen) ist keine Rechnung auffindbar.
    // KONSERVATIV als „gestellt" werten: lieber ein GoBD-Vorgang zu viel
    // geprüft als eine gestellte Rechnung still korrigiert.
    if (r.appointmentId == null || issuedAppts.has(r.appointmentId)) gestellt += take;
    else entwurf += take;
    rest -= take;
  }
  // Reicht die Summe der Verbrauchszeilen nicht, verschwand der Rest bisher
  // stumm und „gestellt + Entwurf" war kleiner als der Fehlbetrag.
  if (rest > 0) nichtZugeordnet = rest;
  return { gestellt, entwurf, nichtZugeordnet };
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

  const degenerate: Array<{ customerId: number; sourceYear: number }> = [];
  const crossCheckMismatches: Array<{ customerId: number; sourceYear: number; neu: number; alt: number }> = [];

  for (const { customerId, targetYear, carryoverIn } of byKey.values()) {
    const sourceYear = targetYear - 1;
    const { expiresAt, validFrom } = carryoverWindowFor(sourceYear);
    const prevExpiry = carryoverWindowFor(sourceYear - 1).expiresAt;
    const prevCarryIn = byKey.get(`${customerId}|${sourceYear}`)?.carryoverIn ?? 0;

    const typeSettings = await readBudgetTypeSettings(
      customerId, { kind: "forDate", asOfDate: `${targetYear}-12-31` },
    );

    // B1 — geschlossen. Der Quelljahres-Anspruch kommt jetzt aus einer
    // ZUSTANDSUNABHÄNGIGEN Rechnung: `enumerate45bStatutoryMonths` (SSoT, auch
    // vom Schreibpfad benutzt) über ein explizites Fenster ab dem ROHEN
    // Pflegegrad-Beginn — ohne `floorAutoAnchor45bToCurrentYear`, dessen Floor
    // auf das laufende Jahr die Ursache des stillen Null-Befunds war.
    // `monthlyAmountFor` ist aus den exportierten Bausteinen komponiert, kein
    // Zweitbegriff.
    const pgStart = await getEarliestCareLevelStart(customerId, db);
    const all45b = typeSettings.filter(t => t.budgetType === BT);
    const monthlyAmountFor = (y: number, m: number): number => {
      const row = pickEffective45bSettingRow(all45b, y, m);
      // Gleiche Reihenfolge wie `monthlyAmountFor` in allocation-storage.ts:798:
      // ohne wirksame Phase bzw. ohne gesetztes Limit gilt der gesetzliche
      // Höchstbetrag, sonst der auf ihn geklammerte Wert.
      if (!row || row.monthlyLimitCents == null) return BUDGET_45B_MAX_MONTHLY_CENTS;
      return clampToStatutoryMax({
        budgetType: BT, monthlyLimitCents: row.monthlyLimitCents,
        yearlyLimitCents: null, pflegegrad: null,
      }).monthlyLimitCents ?? BUDGET_45B_MAX_MONTHLY_CENTS;
    };
    const ibRows = await db.select({
      year: budgetAllocations.year, month: budgetAllocations.month,
    }).from(budgetAllocations).where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, BT),
      eq(budgetAllocations.source, "initial_balance"),
      isNull(budgetAllocations.deletedAt),
    ));
    const initialBalanceMonthKeys = new Set(
      ibRows.filter(r => r.month != null).map(r => `${r.year}-${r.month}`),
    );

    const sourceYearAllocated = sourceYearEntitlementCents({
      sourceYear, pgStartIso: pgStart ?? null,
      initialBalanceMonthKeys, monthlyAmountFor,
    });

    // GEGENPROBE: in Jahren, in denen `calculateAllocatedCents({year})` NICHT
    // degeneriert (also kein Carryover-Shift greift), müssen beide Wege
    // denselben Wert liefern. Weicht es ab, ist die neue Rechnung verdächtig —
    // dann lieber laut sein als still falsche Zahlen liefern.
    const viaLegacy = await calculateAllocatedCents(
      customerId, BT, { year: sourceYear }, undefined, undefined, typeSettings,
    );
    if (viaLegacy > 0 && viaLegacy !== sourceYearAllocated) {
      crossCheckMismatches.push({ customerId, sourceYear, neu: sourceYearAllocated, alt: viaLegacy });
    }
    if (sourceYearAllocated <= 0) { degenerate.push({ customerId, sourceYear }); continue; }

    const netYear = await netConsumptionBetween(customerId, `${sourceYear}-01-01`, `${sourceYear}-12-31`);
    const netUntil = await netConsumptionBetween(customerId, `${sourceYear}-01-01`, prevExpiry);

    const ph = computeCarryoverPhantom({
      sourceYearAllocatedCents: sourceYearAllocated,
      prevCarryInCents: prevCarryIn,
      netConsumptionYearCents: netYear,
      netConsumptionUntilDeadlineCents: netUntil,
      persistedCarryoverOutCents: carryoverIn,
    });

    // B4 — beide Fenster MÜSSEN deckungsgleich sein. `calculateAllocatedCents`
    // reicht im `{year}`-Modus nur bis heute; der Verbrauch wird deshalb
    // ebenfalls bei heute gekappt statt bis 31.12. zu summieren.
    const heute = new Date().toISOString().slice(0, 10);
    const fensterEnde = heute < `${targetYear}-12-31` ? heute : `${targetYear}-12-31`;
    const claimed = await netConsumptionBetween(customerId, validFrom, fensterEnde);
    const targetYearAllocated = await calculateAllocatedCents(
      customerId, BT, { year: targetYear }, undefined, undefined, typeSettings,
    );
    const sf = computeShortfall({
      claimedCents: claimed,
      targetYearAllocatedCents: targetYearAllocated,
      carryoverInSollCents: ph.carryoverOutSollCents,
    });

    if (ph.phantomCents <= 0 && sf.shortfallCents <= 0) continue;
    const split = await splitShortfallByInvoiceState(customerId, targetYear, sf.shortfallCents);

    out.push({
      customerId, sourceYear, targetYear, expiresAt,
      carryoverInIst: carryoverIn,
      carryoverInSoll: ph.carryoverOutSollCents,
      phantomCents: ph.phantomCents,
      geltendGemachtCents: claimed,
      korrekterRestCents: sf.availableCents,
      fehlbetragCents: sf.shortfallCents,
      fehlbetragGestelltCents: split.gestellt,
      fehlbetragEntwurfCents: split.entwurf,
      fehlbetragNichtZugeordnetCents: split.nichtZugeordnet,
    });
  }

  if (degenerate.length > 0) {
    console.error(
      `\n[B1] ${degenerate.length} Kunden-Jahre NICHT bewertet: der Quelljahres-Anspruch ` +
      `kam als 0 zurueck (calculateAllocatedCents liefert die Heute-Sicht).\n` +
      `     Kein Pflegegrad-Beginn oder Anspruch beginnt erst nach dem Quelljahr.\n`,
    );
  }
  if (crossCheckMismatches.length > 0) {
    console.error(`\n[GEGENPROBE] ${crossCheckMismatches.length} Abweichung(en) zur Alt-Rechnung:`);
    for (const m of crossCheckMismatches) {
      console.error(`  Kunde ${m.customerId}, ${m.sourceYear}: neu=${m.neu} alt=${m.alt}`);
    }
    console.error("  Die Zahlen sind NICHT belastbar, solange das ungeklaert ist.\n");
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
