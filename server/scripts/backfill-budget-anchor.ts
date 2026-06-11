/**
 * Task #1203 — Datenpflege: Stale Budget-Anker (`customer_budget_preferences.
 * budget_start_date` / `_origin`) aus dem Altsystem aufräumen.
 *
 * Hintergrund: Task #1192 hat die EINE Laufzeit-Regel für den Budget-Anker
 * als reine SSoT-Funktion `resolveBudgetAnchor(careLevelHistory, today)`
 * etabliert (`shared/domain/budget/budget-anchor.ts`):
 *   Anker = max(frühester Pflegegrad-Beginn, 01.01. des laufenden Jahres).
 * Bestandskunden tragen aber noch Anker, die das ALTE System geschrieben hat —
 * darunter Legacy-`origin = 'manual'` und `origin = NULL`. Diese wurden in
 * #1192 bewusst NICHT angefasst (forward-only). Dieser einmalige, idempotente
 * Backfill bringt den PERSISTIERTEN Cache für jeden Kunden mit Pflegegrad-
 * Historie in Einklang mit der Regel und stempelt `origin = 'derived_pflegegrad'`.
 *
 * !!! WICHTIGE WIRKUNG — NICHT NUR EIN ANZEIGE-CACHE !!!
 * Anders als die Task-Beschreibung suggeriert ist `resolveBudgetAnchor` zum
 * Stand dieses Skripts in KEINEN Lesepfad verdrahtet (siehe
 * `.agents/memory/45b-anchor-origin-stamp.md`). Die Topf-Rechner lesen
 * `budget_start_date` DIREKT aus der DB:
 *   - §45a (`umwandlung_45a`) und §39/§42a (`ersatzpflege_39_42a`) lesen den
 *     Anker ROH (ungekappter Pflegegrad-Beginn ist für sie das Korrekte).
 *   - §45b (`entlastungsbetrag_45b`) bodet den Anker auf den 1.1. des
 *     laufenden Jahres NUR, wenn `origin === 'derived_pflegegrad'`.
 * Ein scharfer Lauf kann daher die Berechnung tatsächlich VERÄNDERN: Für
 * Kunden, deren Pflegegrad vor dem laufenden Jahr begann, ersetzt er einen
 * evtl. früheren §45a/§39-Anker durch den auf den 1.1. gebodeten Wert und
 * verschiebt deren Ansammlungsfenster nach vorne.
 *
 * STEP-BY-STEP (Split-by-Risk):
 * Damit dieser Anker-Backfill GEFAHRLOS schrittweise ausgerollt werden kann,
 * teilt das Skript die betroffenen Kunden anhand der gemessenen Auswirkung in
 * zwei Stufen:
 *
 *   - SAFE-Tier   = Anwenden ändert §45a UND §39 NICHT (reines Aufräumen:
 *                   Origin-Stempel + ggf. §45b-Bodung). DEFAULT-Stufe.
 *   - REVIEW-Tier = Anwenden verschiebt §45a und/oder §39 (deren Fenster
 *                   wandern). Wird per Default NUR GEMELDET, nicht geschrieben.
 *                   Erst der explizite Schalter `--include-window-shifts`
 *                   verarbeitet diese Stufe (bewusst getrennter, bestätigter
 *                   Schritt).
 *
 * Die Einordnung passiert durch echtes MESSEN (calculateAllocatedCents je Topf
 * VOR/NACH dem Schreiben innerhalb einer Transaktion). Im Dry-Run wird die
 * Transaktion stets zurückgerollt; im Apply wird nur die jeweils freigegebene
 * Stufe committet.
 *
 * DRY-RUN: Ohne `--apply` wird je Kunde gemessen und alles zurückgerollt — der
 * Report zeigt exakt, WAS ein scharfer Lauf je Stufe ändern WÜRDE.
 *
 * SICHERHEIT: Ein scharfer Lauf (`--apply`) gegen einen prod-aussehenden
 * DB-Host (oder `NODE_ENV=production`) verlangt zusätzlich `--confirm-prod`.
 * Der DB-Host wird immer prominent ausgegeben.
 *
 * Aufruf:
 *   tsx server/scripts/backfill-budget-anchor.ts                          # Dry-Run, alle betroffenen (beide Stufen melden)
 *   tsx server/scripts/backfill-budget-anchor.ts --all                    # Dry-Run, auch unbetroffene listen
 *   tsx server/scripts/backfill-budget-anchor.ts --customer=209           # Dry-Run, nur Kunde #209
 *   tsx server/scripts/backfill-budget-anchor.ts --apply                  # SCHRITT 1: nur SAFE-Tier schreiben
 *   tsx server/scripts/backfill-budget-anchor.ts --apply --include-window-shifts   # SCHRITT 2: auch REVIEW-Tier
 *   tsx server/scripts/backfill-budget-anchor.ts --apply --confirm-prod   # scharf auf Produktion (Schritt 1)
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customers,
  customerBudgetPreferences,
  customerCareLevelHistory,
  users,
} from "@shared/schema";
import { resolveBudgetAnchor } from "@shared/domain/budget/budget-anchor";
import { calculateAllocatedCents } from "../storage/budget/allocation-storage";
import { upsertBudgetPreferences } from "../storage/budget/preferences-storage";
import { auditService } from "../services/audit";
import { todayISO } from "@shared/utils/datetime";

const DERIVED_ORIGIN = "derived_pflegegrad" as const;

const POTS = [
  { type: "entlastungsbetrag_45b" as const, label: "§45b", side: false },
  { type: "umwandlung_45a" as const, label: "§45a", side: true },
  { type: "ersatzpflege_39_42a" as const, label: "§39", side: true },
];

const euro = (c: number) => `${(c / 100).toFixed(2)} €`;

/** Sentinel, der die Dry-Run-/Skip-Transaktion sauber zurückrollt. */
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
      + ` (oder NODE_ENV=production). Bitte zur Bestätigung zusätzlich '--confirm-prod' übergeben.`,
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

interface Candidate {
  customerId: number;
  name: string;
  currentAnchor: string | null;
  origin: string | null;
}

async function loadCandidates(onlyCustomer: number | null): Promise<Candidate[]> {
  const whereParts = onlyCustomer != null
    ? [eq(customerBudgetPreferences.customerId, onlyCustomer)]
    : [];
  const rows = await db
    .select({
      customerId: customerBudgetPreferences.customerId,
      name: customers.name,
      currentAnchor: customerBudgetPreferences.budgetStartDate,
      origin: customerBudgetPreferences.budgetStartDateOrigin,
    })
    .from(customerBudgetPreferences)
    .innerJoin(customers, eq(customers.id, customerBudgetPreferences.customerId))
    .where(whereParts.length ? and(...whereParts) : undefined)
    .orderBy(asc(customerBudgetPreferences.customerId));

  return rows.map((r) => ({
    customerId: r.customerId,
    name: r.name ?? "",
    currentAnchor: r.currentAnchor ?? null,
    origin: r.origin,
  }));
}

async function careLevelHistory(customerId: number): Promise<{ validFrom: string | null }[]> {
  return db
    .select({ validFrom: customerCareLevelHistory.validFrom })
    .from(customerCareLevelHistory)
    .where(eq(customerCareLevelHistory.customerId, customerId));
}

interface Plan {
  candidate: Candidate;
  hasHistory: boolean;
  derivedAnchor: string | null;
  affected: boolean;
}

async function planFor(candidate: Candidate, today: string): Promise<Plan> {
  const history = await careLevelHistory(candidate.customerId);
  const hasHistory = history.some((r) => !!r.validFrom);
  const derivedAnchor = resolveBudgetAnchor(history, today);

  // Betroffen = es gibt einen ableitbaren Anker UND er ODER die Origin weichen
  // vom aktuell persistierten Zustand ab. Identische Werte mit bereits
  // derived-Origin = nichts zu tun (Idempotenz).
  const affected =
    derivedAnchor != null
    && (candidate.currentAnchor !== derivedAnchor || candidate.origin !== DERIVED_ORIGIN);

  return { candidate, hasHistory, derivedAnchor, affected };
}

type PotMeasurement = { label: string; side: boolean; before: number; after: number };
type Tier = "safe" | "review";

interface Outcome {
  measurements: PotMeasurement[];
  tier: Tier;
  committed: boolean;
}

/**
 * Misst je Topf das Allocated VOR/NACH dem Anker-Schreiben in EINER Transaktion,
 * stuft den Kunden anhand der §45a/§39-Verschiebung in SAFE/REVIEW ein und
 * committet NUR, wenn `apply` gesetzt ist UND die Stufe freigegeben ist
 * (SAFE immer, REVIEW nur mit `includeWindowShifts`). Sonst Rollback.
 */
async function processCustomer(
  plan: Plan,
  apply: boolean,
  includeWindowShifts: boolean,
  operatorUserId: number | null,
  asOfDate: string,
): Promise<Outcome> {
  const { candidate, derivedAnchor } = plan;
  const measurements: PotMeasurement[] = POTS.map((p) => ({
    label: p.label,
    side: p.side,
    before: 0,
    after: 0,
  }));
  let tier: Tier = "safe";
  let committed = false;
  if (!derivedAnchor) return { measurements, tier, committed };

  try {
    await db.transaction(async (tx) => {
      for (let i = 0; i < POTS.length; i++) {
        measurements[i].before = await calculateAllocatedCents(
          candidate.customerId,
          POTS[i].type,
          { asOfDate },
          tx,
        );
      }

      await upsertBudgetPreferences(
        {
          customerId: candidate.customerId,
          budgetStartDate: derivedAnchor,
          budgetStartDateOrigin: DERIVED_ORIGIN,
        },
        operatorUserId ?? undefined,
        tx,
      );

      for (let i = 0; i < POTS.length; i++) {
        measurements[i].after = await calculateAllocatedCents(
          candidate.customerId,
          POTS[i].type,
          { asOfDate },
          tx,
        );
      }

      const sideShift = measurements.some((m) => m.side && m.after !== m.before);
      tier = sideShift ? "review" : "safe";

      const shouldCommit = apply && (tier === "safe" || includeWindowShifts);
      if (shouldCommit) {
        await auditService.log(
          operatorUserId ?? 0,
          "budget_preferences_updated",
          "budget",
          candidate.customerId,
          {
            customerId: candidate.customerId,
            budgetStartDate: derivedAnchor,
            previousBudgetStartDate: candidate.currentAnchor,
            previousOrigin: candidate.origin,
            newOrigin: DERIVED_ORIGIN,
            tier,
            allocatedByPot: measurements.map((m) => ({
              pot: m.label,
              beforeCents: m.before,
              afterCents: m.after,
            })),
            reason:
              "Task #1203: Budget-Anker aus Pflegegrad-Historie re-deriviert "
              + "(resolveBudgetAnchor) + Origin 'derived_pflegegrad' gesetzt — "
              + `Aufräumen stale Altsystem-Anker (Stufe: ${tier}).`,
          },
          undefined,
          tx,
        );
        committed = true;
      } else {
        throw new DryRunRollback();
      }
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return { measurements, tier, committed };
}

function describePots(measurements: PotMeasurement[]): string {
  return measurements
    .map((m) => {
      const d = m.after - m.before;
      const mark = d !== 0 ? ` (${d >= 0 ? "+" : ""}${euro(d)})` : "";
      return `${m.label} ${euro(m.before)}→${euro(m.after)}${mark}`;
    })
    .join(" · ");
}

async function main() {
  const apply = process.argv.includes("--apply");
  const confirmProd = process.argv.includes("--confirm-prod");
  const includeWindowShifts = process.argv.includes("--include-window-shifts");
  const showAll = process.argv.includes("--all");
  const onlyCustomer = parseCustomerId();
  const asOfDate = todayISO();

  console.log(`\n=== Budget-Anker-Backfill · Task #1203 (Split-by-Risk) ===`);
  await safetyChecks(apply, confirmProd);
  console.log(
    `Stichtag (today): ${asOfDate} · `
    + `Stufe: ${includeWindowShifts ? "SAFE + REVIEW (--include-window-shifts)" : "nur SAFE"} · `
    + `${showAll ? "ALLE Kandidaten" : "nur betroffene"}`
    + `${onlyCustomer ? ` · nur Kunde #${onlyCustomer}` : ""}\n`,
  );

  const candidates = await loadCandidates(onlyCustomer);
  if (candidates.length === 0) {
    console.log("Keine customer_budget_preferences-Zeilen gefunden.");
    return;
  }

  const operatorUserId = await findOperatorUserId();
  if (apply && operatorUserId == null) {
    throw new Error("Kein Superadmin gefunden — Operator für Audit-Log fehlt.");
  }

  let noHistoryCount = 0;
  let safeCount = 0;
  let reviewCount = 0;
  let committedCount = 0;
  const potDelta: Record<string, number> = {};

  for (const candidate of candidates) {
    const plan = await planFor(candidate, asOfDate);

    if (!plan.hasHistory) noHistoryCount++;

    if (!plan.affected) {
      if (showAll) {
        const reason = !plan.hasHistory
          ? "keine PG-Historie → unangetastet"
          : "bereits korrekt (Anker + Origin)";
        console.log(
          `  #${candidate.customerId} ${candidate.name.slice(0, 26).padEnd(26)} `
          + `Anker ${candidate.currentAnchor ?? "(leer)"} [${candidate.origin ?? "NULL"}] · ${reason}`,
        );
      }
      continue;
    }

    const { measurements, tier, committed } = await processCustomer(
      plan,
      apply,
      includeWindowShifts,
      operatorUserId,
      asOfDate,
    );

    if (tier === "safe") safeCount++; else reviewCount++;
    if (committed) committedCount++;
    for (const m of measurements) potDelta[m.label] = (potDelta[m.label] ?? 0) + (m.after - m.before);

    const flag = committed ? "✓" : (tier === "review" && !includeWindowShifts ? "⏸" : "Δ");
    const tierTag = tier === "review" ? "[REVIEW]" : "[SAFE]  ";
    console.log(
      `${flag} ${tierTag} #${candidate.customerId} ${candidate.name.slice(0, 24).padEnd(24)} `
      + `Anker ${candidate.currentAnchor ?? "(leer)"} [${candidate.origin ?? "NULL"}] `
      + `→ ${plan.derivedAnchor} [${DERIVED_ORIGIN}]`,
    );
    console.log(`        ${describePots(measurements)}`);
    if (tier === "review") {
      console.log(
        `        ⚠ §45a/§39 lesen den Anker ROH — diese Verschiebung ändert deren `
        + `Ansammlungsfenster.${committed ? "" : " Schreiben nur mit --include-window-shifts (Schritt 2)."}`,
      );
    }
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte Preferences-Zeilen:      ${candidates.length}`);
  console.log(`Ohne PG-Historie (unangetastet):  ${noHistoryCount}`);
  console.log(`SAFE-Tier (kein §45a/§39-Shift):  ${safeCount}`);
  console.log(`REVIEW-Tier (Fenster verschiebt): ${reviewCount}`);
  console.log(`Tatsächlich committet:            ${committedCount}`);
  for (const { label } of POTS) {
    const d = potDelta[label] ?? 0;
    console.log(`Σ ${label}-Allocated-Differenz (gemessen): ${d >= 0 ? "+" : ""}${euro(d)}`);
  }

  if (safeCount + reviewCount === 0) {
    console.log(`\n✓ Kein Kunde betroffen — nichts aufzuräumen.`);
  } else if (apply) {
    console.log(`\n✓ ${committedCount} Kunde(n) geschrieben (Anker + Origin gesetzt, Audit).`);
    if (reviewCount > 0 && !includeWindowShifts) {
      console.log(
        `⏸ ${reviewCount} REVIEW-Kunde(n) übersprungen (Fenster-Shift). Nach Prüfung mit `
        + `--apply --include-window-shifts als Schritt 2 schreiben.`,
      );
    }
  } else {
    console.log(
      `\n⚠ DRY-RUN. Schritt 1 (sicher): --apply  →  ${safeCount} SAFE-Kunde(n).`,
    );
    if (reviewCount > 0) {
      console.log(
        `   Schritt 2 (geprüft): --apply --include-window-shifts  →  zusätzlich `
        + `${reviewCount} REVIEW-Kunde(n) (§45a/§39-Fenster verschieben).`,
      );
    }
    console.log(`   Auf Produktion zusätzlich --confirm-prod.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof DryRunRollback) {
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  });
