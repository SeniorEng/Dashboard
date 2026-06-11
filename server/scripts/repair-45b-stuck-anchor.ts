/**
 * Task #1193 — Report + idempotenter Bulk-Fix für „auf den Stichmonat
 * festhängende" Budget-Anker bei Bestandskunden.
 *
 * Hintergrund: Der Budget-Anker (`customer_budget_preferences.budget_start_date`)
 * wurde historisch je nach Anlage-Pfad unterschiedlich gesetzt. Bei Altkunden,
 * die VOR dem Anker-SSoT (Task #1192/#1143) angelegt wurden, steht er häufig
 *   - auf dem KREATIONS-/Stichmonat (statt am Pflegegrad-Beginn / 01.01.) und
 *   - mit `budget_start_date_origin = NULL`.
 * Der §45b-Lesepfad (`calculateAllocated45b`) bodet/kappt einen Anker NUR, wenn
 * Origin = 'derived_pflegegrad' ist (`floorAutoAnchor45bToCurrentYear`). Bei
 * NULL liest er den Anker ROH — die §45b-Monatsansammlung beginnt erst im
 * Stichmonat statt im Januar, das Budget zeigt nur einen Bruchteil der
 * Jahresansammlung (Prod-Repro: Kunde "Mentke" #182 → 4 Monate / 524 € fehlen).
 *
 * Geregelter Fluss (Report → Freigabe → Korrektur) — ERSETZT das ad-hoc
 * Repair-Tooling:
 *
 *  1. REPORT (Dry-Run = Default): listet alle Kunden mit aktiven §-Töpfen,
 *     deren Anker `origin IS NULL` trägt UND später liegt als der per SSoT
 *     abgeleitete Soll-Anker (`budget_start_date > resolveBudgetAnchor(...)`).
 *     Spalten: Kunde · PG seit · aktueller Anker · Soll-Anker · fehlende
 *     Monate · fehlender Betrag € · vorhandene Startwerte/Carryover.
 *
 *  2. SOLL-ANKER: ausschließlich über die Anker-SSoT
 *     `resolveBudgetAnchor(careLevelHistory, today)` (Task #1192) =
 *     `max(frühester pflegegradSeit, 01.01. laufendes Jahr)`. KEINE eigene
 *     Anker-Mathematik in diesem Skript.
 *
 *  3. KORREKTUR (`--apply`): setzt für die freigegebenen Fälle
 *     `budget_start_date = Soll-Anker` und `budget_start_date_origin =
 *     'derived_pflegegrad'` (über `upsertBudgetPreferences`) und schreibt EINEN
 *     GoBD-Audit-Eintrag pro Änderung. Idempotent: ein zweiter Lauf findet die
 *     Fälle nicht mehr (Origin ist nicht mehr NULL).
 *
 *  4. KORREKTUR-GATE: nur Kunden mit AKTIVEM §45b werden geschrieben — nur dort
 *     hängt die Ansammlung am gebodeten Anker. Reine §45a/§39-Kunden bleiben
 *     UNANGETASTET (ihr Anker wird nicht angefasst). Bei Kunden mit §45b UND
 *     §45a/§39 ist der geschriebene Wert der kanonische Pflegegrad-Anker, den
 *     §45a/§39 ohnehin nutzen sollen.
 *
 * Es werden KEINE `budget_allocations` angefasst (kein Verschieben von Startwert-/
 * Carryover-Zeilen). Hat ein Kunde einen §45b-Startwert (`initial_balance`), der
 * nach der Anker-Korrektur den Akkumulations-Start weiterhin verschiebt, warnt
 * der Report.
 *
 * DRY-RUN: Ohne `--apply` wird die Korrektur in einer Transaktion ausgeführt,
 * das tatsächliche §45b-Allocated vorher/nachher via `calculateAllocatedCents`
 * gemessen (→ fehlende Monate/Betrag) und die Transaktion am Ende bewusst
 * zurückgerollt — der Report zeigt also exakt, WAS ein scharfer Lauf ändern
 * WÜRDE, ohne zu schreiben.
 *
 * SICHERHEIT: Dieser Fix DARF auf Produktion laufen (er repariert Prod-
 * Bestandskunden). Damit das nicht VERSEHENTLICH gegen die falsche DB passiert,
 * verlangt ein scharfer Lauf gegen einen prod-aussehenden DB-Host (oder
 * NODE_ENV=production) zusätzlich `--confirm-prod`. Der DB-Host wird immer
 * prominent ausgegeben.
 *
 * Aufruf:
 *   tsx server/scripts/repair-45b-stuck-anchor.ts                       # Dry-Run, nur betroffene
 *   tsx server/scripts/repair-45b-stuck-anchor.ts --all                 # Dry-Run, auch unbetroffene listen
 *   tsx server/scripts/repair-45b-stuck-anchor.ts --customer=182        # Dry-Run, nur Kunde #182
 *   tsx server/scripts/repair-45b-stuck-anchor.ts --customer=182 --apply
 *   tsx server/scripts/repair-45b-stuck-anchor.ts --apply --confirm-prod  # scharf auf Produktion
 */
import { and, asc, eq, isNull, isNotNull } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customers,
  customerBudgetPreferences,
  customerBudgetTypeSettings,
  customerCareLevelHistory,
  budgetAllocations,
  users,
} from "@shared/schema";
import { resolveBudgetAnchor } from "@shared/domain/budget/budget-anchor";
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";
import { calculateAllocatedCents } from "../storage/budget/allocation-storage";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { auditService } from "../services/audit";
import { todayISO } from "@shared/utils/datetime";

const BUDGET_TYPE = "entlastungsbetrag_45b" as const;
const euro = (c: number) => `${(c / 100).toFixed(2)} €`;

/**
 * Reine Hilfsfunktion: Anzahl §45b-Monate, die die Allocated-Differenz abbildet.
 * Default-Monatsbetrag = gesetzlicher §45b-Maximalbetrag (131 €). Wird gegen
 * den Standardbetrag gerundet — eine reine Anzeige-Approximation für den Report,
 * keine Buchungslogik.
 */
export function missingMonthsFromCents(
  missingCents: number,
  monthlyCents: number = BUDGET_45B_MAX_MONTHLY_CENTS,
): number {
  if (monthlyCents <= 0) return 0;
  return Math.round(missingCents / monthlyCents);
}

/** Sentinel, der die Dry-Run-Transaktion sauber zurückrollt. */
class DryRunRollback extends Error {
  constructor() {
    super("dry-run rollback (kein Fehler)");
  }
}

function parseCustomerId(): number | null {
  const arg = process.argv.find((a) => a.startsWith("--customer="));
  if (!arg) return null;
  const n = Number(arg.split("=")[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function dbHost(): string {
  const url = process.env.DATABASE_URL || "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/@([^/:?]+)/);
    return (m ? m[1] : "").toLowerCase();
  }
}

function looksLikeProd(host: string): boolean {
  return process.env.NODE_ENV === "production"
    || /(^|[.-])prod([.-]|$)|production/.test(host);
}

async function safetyChecks(apply: boolean, confirmProd: boolean): Promise<void> {
  const host = dbHost();
  const prod = looksLikeProd(host);
  console.log(
    `Sicherheits-Checks · DB-Host: ${host || "(unbekannt)"} · `
    + `${prod ? "PROD-VERDACHT" : "nicht-prod"} · `
    + `Modus: ${apply ? "APPLY (schreibend)" : "DRY-RUN"}`,
  );
  if (apply && prod && !confirmProd) {
    throw new Error(
      `ABBRUCH: Scharfer Lauf gegen prod-aussehenden DB-Host '${host || "(unbekannt)"}'`
      + ` (oder NODE_ENV=production). Dieser Fix DARF auf Produktion laufen — `
      + `bitte zur Bestätigung zusätzlich '--confirm-prod' übergeben.`,
    );
  }
}

async function findOperatorUserId(): Promise<number | null> {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .limit(1);
  return u?.id ?? null;
}

interface NullOriginCustomer {
  customerId: number;
  name: string;
  currentAnchor: string;
  origin: string | null;
}

async function loadNullOriginCustomers(onlyCustomer: number | null): Promise<NullOriginCustomer[]> {
  const whereParts = [
    isNull(customerBudgetPreferences.budgetStartDateOrigin),
    isNotNull(customerBudgetPreferences.budgetStartDate),
  ];
  if (onlyCustomer != null) {
    whereParts.push(eq(customerBudgetPreferences.customerId, onlyCustomer));
  }
  const rows = await db
    .select({
      customerId: customerBudgetPreferences.customerId,
      name: customers.name,
      currentAnchor: customerBudgetPreferences.budgetStartDate,
      origin: customerBudgetPreferences.budgetStartDateOrigin,
    })
    .from(customerBudgetPreferences)
    .innerJoin(customers, eq(customers.id, customerBudgetPreferences.customerId))
    .where(and(...whereParts))
    .orderBy(asc(customerBudgetPreferences.customerId));

  return rows
    .filter((r): r is NullOriginCustomer => !!r.currentAnchor)
    .map((r) => ({
      customerId: r.customerId,
      name: r.name ?? "",
      currentAnchor: r.currentAnchor!,
      origin: r.origin,
    }));
}

/** Frühester Pflegegrad-Beginn (für die Report-Spalte „PG seit", roh). */
async function earliestPflegegradStart(customerId: number): Promise<string | null> {
  const rows = await db
    .select({ validFrom: customerCareLevelHistory.validFrom })
    .from(customerCareLevelHistory)
    .where(eq(customerCareLevelHistory.customerId, customerId));
  const sorted = rows
    .map((r) => r.validFrom)
    .filter((v): v is string => !!v)
    .sort();
  return sorted[0] ?? null;
}

/** Pflegegrad-Historie als SSoT-Input (reihenfolge-unabhängig). */
async function careLevelHistoryRows(customerId: number): Promise<{ validFrom: string | null }[]> {
  return db
    .select({ validFrom: customerCareLevelHistory.validFrom })
    .from(customerCareLevelHistory)
    .where(eq(customerCareLevelHistory.customerId, customerId));
}

/** Irgendein §-Topf aktiv (datumsunabhängig). */
async function hasActivePot(customerId: number): Promise<boolean> {
  const rows = await db
    .select({ id: customerBudgetTypeSettings.id })
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      eq(customerBudgetTypeSettings.enabled, true),
    ))
    .limit(1);
  return rows.length > 0;
}

/** §45b aktiv (datumsunabhängig, analog calculateAllocated45b). */
async function is45bEnabled(customerId: number): Promise<boolean> {
  const rows = await db
    .select({ id: customerBudgetTypeSettings.id })
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      eq(customerBudgetTypeSettings.budgetType, BUDGET_TYPE),
      eq(customerBudgetTypeSettings.enabled, true),
    ))
    .limit(1);
  return rows.length > 0;
}

/** Summe vorhandener §45b-Startwerte und Carryover (Report-Spalte). */
async function existing45bSources(customerId: number): Promise<{
  initialBalanceCents: number;
  carryoverCents: number;
}> {
  const rows = await db
    .select({
      source: budgetAllocations.source,
      amountCents: budgetAllocations.amountCents,
    })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      isNull(budgetAllocations.deletedAt),
    ));
  let initialBalanceCents = 0;
  let carryoverCents = 0;
  for (const r of rows) {
    if (r.source === "initial_balance") initialBalanceCents += r.amountCents;
    else if (r.source === "carryover") carryoverCents += r.amountCents;
  }
  return { initialBalanceCents, carryoverCents };
}

/** Aktiver §45b-Startwert mit Monat >= korrigiertem Anker (Unvollständigkeits-Warnung). */
async function has45bInitialBalanceAtOrAfter(
  customerId: number,
  effectiveAnchor: string,
): Promise<boolean> {
  const rows = await db
    .select({ validFrom: budgetAllocations.validFrom })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      eq(budgetAllocations.source, "initial_balance"),
      isNull(budgetAllocations.deletedAt),
    ));
  return rows.some((r) => r.validFrom >= effectiveAnchor);
}

export interface AnchorRepairRow {
  customerId: number;
  name: string;
  /** Frühester Pflegegrad-Beginn (roh). */
  pgSeit: string | null;
  /** Aktueller (gepinnter) Anker. */
  currentAnchor: string;
  origin: string | null;
  /** Soll-Anker per resolveBudgetAnchor (SSoT) oder null (keine PG-Historie). */
  sollAnchor: string | null;
  hasActivePot: boolean;
  enabled45b: boolean;
  /** In der Report-Population: origin NULL, aktiver Topf, currentAnchor > sollAnchor. */
  inPopulation: boolean;
  /**
   * Korrektur-Kandidat: inPopulation + §45b aktiv. Diese Kunden werden gelistet,
   * gezählt UND (bei --apply) geschrieben — UNABHÄNGIG davon, ob sich der
   * §45b-Allocated-Betrag dadurch ändert (die Origin-Korrektur NULL →
   * 'derived_pflegegrad' ist für sich genommen schon eine GoBD-relevante
   * Reparatur, die künftige Lesepfade stabilisiert).
   */
  willCorrect: boolean;
  missingMonths: number;
  missingCents: number;
  existingInitialBalanceCents: number;
  existingCarryoverCents: number;
  ibWarning: boolean;
  beforeCents: number;
  afterCents: number;
}

export interface AnchorRepairResult {
  rows: AnchorRepairRow[];
  checked: number;
  affectedCount: number;
  totalDeltaCents: number;
}

export interface AnchorRepairOptions {
  onlyCustomer?: number | null;
  apply?: boolean;
  /** Auch nicht-betroffene NULL-Origin-Kunden in den Rows behalten. */
  includeUnaffected?: boolean;
  /** „heute" für den SSoT-Floor (Default todayISO()). */
  today?: string;
  /** Mess-Stichtag für §45b-Allocated vorher/nachher (Default = today). */
  asOfDate?: string;
  /** Operator für Audit-Log (Default = erster Superadmin). */
  operatorUserId?: number | null;
}

/**
 * Kern-Routine: ermittelt Kandidaten, misst §45b vorher/nachher und (bei
 * `apply`) schreibt Anker + Origin + Audit. Wird sowohl von der CLI als auch
 * vom Integrationstest verwendet.
 */
export async function runBudgetAnchorRepair(
  opts: AnchorRepairOptions = {},
): Promise<AnchorRepairResult> {
  const apply = opts.apply ?? false;
  const includeUnaffected = opts.includeUnaffected ?? false;
  const today = opts.today ?? todayISO();
  const asOfDate = opts.asOfDate ?? today;

  let operatorUserId = opts.operatorUserId ?? null;
  if (operatorUserId == null) {
    operatorUserId = await findOperatorUserId();
  }
  if (apply && operatorUserId == null) {
    throw new Error("Kein Superadmin gefunden — Operator für Audit-Log fehlt.");
  }

  const nullOrigin = await loadNullOriginCustomers(opts.onlyCustomer ?? null);
  const rows: AnchorRepairRow[] = [];
  let affectedCount = 0;
  let totalDeltaCents = 0;

  for (const c of nullOrigin) {
    const [pgSeit, history, activePot, enabled45b, sources] = await Promise.all([
      earliestPflegegradStart(c.customerId),
      careLevelHistoryRows(c.customerId),
      hasActivePot(c.customerId),
      is45bEnabled(c.customerId),
      existing45bSources(c.customerId),
    ]);

    const sollAnchor = resolveBudgetAnchor(history, today);

    // Population (Report): origin NULL, aktiver Topf, Anker liegt SPÄTER als der
    // Soll-Anker (Kunde hängt zu spät fest). ISO-Strings lexikografisch.
    const inPopulation =
      activePot
      && sollAnchor != null
      && c.currentAnchor > sollAnchor;

    // Korrektur-Kandidat = Population + §45b aktiv. Die Entscheidung, OB
    // geschrieben/gelistet/gezählt wird, hängt AUSSCHLIESSLICH an diesem
    // Kriterium — NICHT daran, ob sich der Allocated-Betrag ändert. Sonst
    // könnte ein Anker im Apply-Modus still korrigiert + auditiert werden,
    // ohne im Report aufzutauchen (Verstoß gegen Report → Freigabe → Korrektur).
    const willCorrect = inPopulation && enabled45b && sollAnchor != null;

    let beforeCents = 0;
    let afterCents = 0;
    let ibWarning = false;

    if (willCorrect && sollAnchor != null) {
      ibWarning = await has45bInitialBalanceAtOrAfter(c.customerId, sollAnchor);
      const measured = await measureAndApply(
        { customerId: c.customerId, currentAnchor: c.currentAnchor, origin: c.origin, sollAnchor },
        apply,
        operatorUserId,
        asOfDate,
      );
      beforeCents = measured.before;
      afterCents = measured.after;
    }

    // Differenz ist rein informativ (Report-Spalte) und darf 0 sein.
    const missingCents = willCorrect ? Math.max(0, afterCents - beforeCents) : 0;
    const row: AnchorRepairRow = {
      customerId: c.customerId,
      name: c.name,
      pgSeit,
      currentAnchor: c.currentAnchor,
      origin: c.origin,
      sollAnchor,
      hasActivePot: activePot,
      enabled45b,
      inPopulation,
      willCorrect,
      missingMonths: missingMonthsFromCents(missingCents),
      missingCents,
      existingInitialBalanceCents: sources.initialBalanceCents,
      existingCarryoverCents: sources.carryoverCents,
      ibWarning,
      beforeCents,
      afterCents,
    };

    if (willCorrect) {
      affectedCount++;
      totalDeltaCents += missingCents;
    }

    if (willCorrect || (includeUnaffected && c.currentAnchor)) {
      rows.push(row);
    }
  }

  return { rows, checked: nullOrigin.length, affectedCount, totalDeltaCents };
}

async function measureAndApply(
  target: { customerId: number; currentAnchor: string; origin: string | null; sollAnchor: string },
  apply: boolean,
  operatorUserId: number | null,
  asOfDate: string,
): Promise<{ before: number; after: number }> {
  let before = 0;
  let after = 0;
  try {
    await db.transaction(async (tx) => {
      before = await calculateAllocatedCents(
        target.customerId,
        BUDGET_TYPE,
        { asOfDate },
        tx,
      );

      await budgetLedgerStorage.upsertBudgetPreferences({
        customerId: target.customerId,
        budgetStartDate: target.sollAnchor,
        budgetStartDateOrigin: "derived_pflegegrad",
      }, operatorUserId ?? undefined, tx);

      after = await calculateAllocatedCents(
        target.customerId,
        BUDGET_TYPE,
        { asOfDate },
        tx,
      );

      if (apply) {
        await auditService.log(
          operatorUserId ?? 0,
          "budget_initial_setup",
          "budget",
          target.customerId,
          {
            customerId: target.customerId,
            budgetType: BUDGET_TYPE,
            budgetStartDate: target.sollAnchor,
            previousBudgetStartDate: target.currentAnchor,
            previousOrigin: target.origin,
            newOrigin: "derived_pflegegrad",
            allocatedBeforeCents: before,
            allocatedAfterCents: after,
            reason:
              "Task #1193: Budget-Anker per Anker-SSoT (resolveBudgetAnchor) am "
              + "Pflegegrad-Beginn/01.01. verankert + Origin 'derived_pflegegrad' "
              + "gesetzt (Bestandskunde hing auf dem Stichmonat fest).",
          },
          undefined,
          tx,
        );
      } else {
        throw new DryRunRollback();
      }
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return { before, after };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const confirmProd = process.argv.includes("--confirm-prod");
  const showAll = process.argv.includes("--all");
  const onlyCustomer = parseCustomerId();
  const today = todayISO();

  console.log(`\n=== Budget-Anker-Reparatur (festhängender Stichmonat) · Task #1193 ===`);
  await safetyChecks(apply, confirmProd);
  console.log(
    `Heute: ${today} · `
    + `${showAll ? "ALLE NULL-Origin-Kandidaten" : "nur betroffene"}`
    + `${onlyCustomer ? ` · nur Kunde #${onlyCustomer}` : ""}\n`,
  );

  const operatorUserId = await findOperatorUserId();
  if (apply && operatorUserId == null) {
    throw new Error("Kein Superadmin gefunden — Operator für Audit-Log fehlt.");
  }

  const result = await runBudgetAnchorRepair({
    onlyCustomer,
    apply,
    includeUnaffected: showAll,
    today,
    operatorUserId,
  });

  if (result.checked === 0) {
    console.log("Keine Kandidaten (origin IS NULL + budget_start_date gesetzt) gefunden.");
    return;
  }

  // Tabellen-Header.
  console.log(
    `   ${"Kunde".padEnd(28)} ${"PG seit".padEnd(11)} ${"Anker".padEnd(11)} `
    + `${"Soll".padEnd(11)} ${"fehlt".padStart(6)} ${"Betrag".padStart(11)} `
    + `${"Startwert".padStart(11)} ${"Carryover".padStart(11)}`,
  );

  for (const r of result.rows) {
    if (!r.willCorrect && !showAll) continue;
    const flag = r.willCorrect ? (apply ? "✓" : "Δ") : " ";
    const potMark = r.enabled45b ? "" : (r.hasActivePot ? " (§45a/§39 only)" : " (kein Topf)");
    console.log(
      `${flag} #${String(r.customerId).padEnd(5)} ${(r.name).slice(0, 20).padEnd(20)} `
      + `${(r.pgSeit ?? "—").padEnd(11)} ${r.currentAnchor.padEnd(11)} `
      + `${(r.sollAnchor ?? "—").padEnd(11)} ${String(r.missingMonths).padStart(6)} `
      + `${euro(r.missingCents).padStart(11)} `
      + `${euro(r.existingInitialBalanceCents).padStart(11)} `
      + `${euro(r.existingCarryoverCents).padStart(11)}${potMark}`,
    );
    if (r.ibWarning) {
      console.log(
        `    ⚠ Kunde hat einen aktiven §45b-Startwert >= korrigiertem Anker — die reine `
        + `Anker-Korrektur kann unvollständig bleiben.`,
      );
    }
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte NULL-Origin-Kandidaten: ${result.checked}`);
  console.log(`Davon betroffen (festhängend):   ${result.affectedCount}`);
  console.log(`Σ §45b-Allocated-Differenz:      ${result.totalDeltaCents >= 0 ? "+" : ""}${euro(result.totalDeltaCents)}`);
  if (result.affectedCount === 0) {
    console.log(`\n✓ Kein Kunde betroffen — nichts zu reparieren.`);
  } else if (apply) {
    console.log(`\n✓ ${result.affectedCount} Kunde(n) repariert (Anker + Origin gesetzt, Audit geschrieben).`);
  } else {
    console.log(`\n⚠ ${result.affectedCount} Kunde(n) würden repariert. Mit --apply scharf ausführen`
      + ` (auf Produktion zusätzlich --confirm-prod).`);
  }
}

// Nur als CLI ausführen, nicht beim Import aus dem Test.
const invokedDirectly = process.argv[1]?.includes("repair-45b-stuck-anchor");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      if (err instanceof DryRunRollback) {
        process.exit(0);
      }
      console.error(err);
      process.exit(1);
    });
}
