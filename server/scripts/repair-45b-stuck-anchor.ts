/**
 * Task #1148 — Datenfix: §45b-Budget hängt bei Bestandskunden auf einem Monat fest.
 *
 * Hintergrund: Task #1143 hat den §45b-Akkumulations-Bug NACH VORNE behoben
 * (POST /initial-balance + DELETE schreiben/erneuern jetzt den kunden-weiten
 * `budget_start_date` mit Origin 'derived_pflegegrad'). Kunden, die VOR diesem
 * Fix angelegt wurden, behalten aber einen Anker, der
 *   - auf den Stichmonat gepinnt ist (statt am Pflegegrad-Beginn) und
 *   - `budget_start_date_origin = NULL` trägt.
 * Der §45b-Lesepfad (`calculateAllocated45b`) bodet/kappt einen Anker NUR, wenn
 * Origin = 'derived_pflegegrad' ist (`floorAutoAnchor45bToCurrentYear`). Bei
 * NULL liest er den Anker ROH — das §45b-Budget bleibt auf dem Stichmonat
 * hängen und zeigt ~131 € statt der vollen Jahres-Ansammlung (Prod-Kunde
 * "Valdorf, Gerhard" #209).
 *
 * Was der Fix tut (idempotent, GoBD-konform, FORWARD-ONLY für die Anzeige):
 *  1. Kandidaten = Kunden mit §45b AKTIV, `budget_start_date_origin IS NULL`,
 *     `budget_start_date` gesetzt UND vorhandener Pflegegrad-Historie.
 *  2. Re-derivierter Anker = frühester Pflegegrad-Beginn
 *     (`resolve45bAccrualAnchor`, identisch zum DELETE-/Wizard-Pfad).
 *  3. BETROFFEN ist nur, wessen re-derivierter Anker FRÜHER liegt als der aktuell
 *     gepinnte (`derived < current`) — also genau die „auf einen Monat
 *     festhängenden" Kunden. Ein manuell auf ein FRÜHERES Datum gesetzter Anker
 *     wird so nie nach hinten gezogen; absichtlich `manual` markierte Anker
 *     werden ohnehin ausgeschlossen (nur `origin IS NULL`).
 *  4. Schreibt `budget_start_date = re-derivierter Anker` und
 *     `budget_start_date_origin = 'derived_pflegegrad'` (über
 *     `upsertBudgetPreferences`). §45a/§39 lesen den Anker weiterhin ROH — der
 *     re-derivierte Wert IST der kanonische Pflegegrad-Anker, den §45a/§39 ohnehin
 *     nutzen sollen (vor/nach im Report sichtbar). §45b kappt ihn beim Lesen.
 *  5. Audit-Eintrag `budget_initial_setup` (GoBD).
 *
 * Es werden KEINE `budget_allocations` angefasst (kein Verschieben von Startwert-
 * Zeilen — das ist der separate #856-Pfad `fix-customer-45b-anchor.ts`). Hat ein
 * Kunde einen §45b-Startwert (`initial_balance`), der nach der Anker-Korrektur den
 * Akkumulations-Start weiterhin verschiebt, warnt der Report und verweist dorthin.
 *
 * DRY-RUN: Ohne `--apply` wird die Korrektur in einer Transaktion ausgeführt,
 * das tatsächliche §45b-Allocated vorher/nachher via `calculateAllocatedCents`
 * gemessen und die Transaktion am Ende bewusst zurückgerollt — der Report zeigt
 * also exakt, WAS ein scharfer Lauf ändern WÜRDE, ohne zu schreiben.
 *
 * SICHERHEIT: Anders als die Test-Cleanup-Skripte DARF dieser Fix auf Produktion
 * laufen (er repariert Prod-Bestandskunden). Damit das nicht VERSEHENTLICH gegen
 * die falsche DB passiert, verlangt ein scharfer Lauf gegen einen prod-aussehenden
 * DB-Host (oder NODE_ENV=production) zusätzlich `--confirm-prod`. Der DB-Host wird
 * immer prominent ausgegeben.
 *
 * Aufruf:
 *   tsx server/scripts/repair-45b-stuck-anchor.ts                       # Dry-Run, alle betroffenen
 *   tsx server/scripts/repair-45b-stuck-anchor.ts --all                 # Dry-Run, auch unbetroffene listen
 *   tsx server/scripts/repair-45b-stuck-anchor.ts --customer=209        # Dry-Run, nur Kunde #209
 *   tsx server/scripts/repair-45b-stuck-anchor.ts --customer=209 --apply
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
import { floorAutoAnchor45bToCurrentYear } from "@shared/domain/budgets";
import { resolve45bAccrualAnchor } from "@shared/domain/budget/carryover-eligibility";
import { calculateAllocatedCents } from "../storage/budget/allocation-storage";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { auditService } from "../services/audit";
import { currentYearAndMonth, todayISO } from "@shared/utils/datetime";

const BUDGET_TYPE = "entlastungsbetrag_45b" as const;
const euro = (c: number) => `${(c / 100).toFixed(2)} €`;

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

interface Candidate {
  customerId: number;
  name: string;
  currentAnchor: string;
  origin: string | null;
}

async function loadCandidates(onlyCustomer: number | null): Promise<Candidate[]> {
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
    .filter((r): r is Candidate => !!r.currentAnchor)
    .map((r) => ({
      customerId: r.customerId,
      name: r.name ?? "",
      currentAnchor: r.currentAnchor!,
      origin: r.origin,
    }));
}

async function is45bEnabled(customerId: number): Promise<boolean> {
  // Datumsunabhängig (analog calculateAllocated45b): irgendeine §45b-Zeile aktiv.
  const rows = await db
    .select({ enabled: customerBudgetTypeSettings.enabled })
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      eq(customerBudgetTypeSettings.budgetType, BUDGET_TYPE),
      eq(customerBudgetTypeSettings.enabled, true),
    ))
    .limit(1);
  return rows.length > 0;
}

async function earliestPflegegradStart(customerId: number): Promise<string | null> {
  const rows = await db
    .select({ validFrom: customerCareLevelHistory.validFrom })
    .from(customerCareLevelHistory)
    .where(eq(customerCareLevelHistory.customerId, customerId));
  // Reihenfolge-unabhängig (frühestes validFrom) — fallbackISO = "" markiert
  // „keine Historie" (resolve gibt dann "" zurück, das wir als null behandeln).
  const resolved = resolve45bAccrualAnchor(rows, "");
  return resolved || null;
}

async function has45bInitialBalanceAtOrAfter(
  customerId: number,
  effectiveAnchor: string,
): Promise<boolean> {
  // Ein aktiver §45b-Startwert verschiebt den Akkumulations-Start im Lesepfad
  // (initialBalanceMonths-Shift). Liegt sein Monat >= dem korrigierten,
  // gebodeten Anker, kann die reine Anker-Korrektur unvollständig bleiben.
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

interface Plan {
  candidate: Candidate;
  enabled: boolean;
  derivedAnchor: string | null;
  effectiveBefore: string; // §45b-effektiver Anker bei origin NULL (= roh)
  effectiveAfter: string | null; // §45b-effektiver Anker nach Fix (gebodet)
  affected: boolean;
  ibWarning: boolean;
}

async function planFor(candidate: Candidate, curYear: number): Promise<Plan> {
  const enabled = await is45bEnabled(candidate.customerId);
  const derivedAnchor = await earliestPflegegradStart(candidate.customerId);

  // §45b liest bei origin NULL den Anker ROH; nach dem Fix (origin derived) wird
  // er auf den 1.1. des laufenden Jahres gebodet.
  const effectiveBefore = candidate.currentAnchor;
  const effectiveAfter = derivedAnchor
    ? floorAutoAnchor45bToCurrentYear(derivedAnchor, curYear)
    : null;

  // Betroffen = §45b aktiv, ableitbarer Anker liegt FRÜHER als der gepinnte
  // (Kunde hängt zu spät fest) UND der effektive §45b-Anker ändert sich dadurch.
  const affected =
    enabled
    && derivedAnchor != null
    && derivedAnchor < candidate.currentAnchor
    && effectiveAfter != null
    && effectiveAfter !== effectiveBefore;

  let ibWarning = false;
  if (affected && effectiveAfter) {
    ibWarning = await has45bInitialBalanceAtOrAfter(candidate.customerId, effectiveAfter);
  }

  return { candidate, enabled, derivedAnchor, effectiveBefore, effectiveAfter, affected, ibWarning };
}

async function measureAndApply(
  plan: Plan,
  apply: boolean,
  operatorUserId: number | null,
  asOfDate: string,
): Promise<{ before: number; after: number }> {
  const { candidate, derivedAnchor } = plan;
  if (!derivedAnchor) return { before: 0, after: 0 };

  let before = 0;
  let after = 0;
  try {
    await db.transaction(async (tx) => {
      before = await calculateAllocatedCents(
        candidate.customerId,
        BUDGET_TYPE,
        { asOfDate },
        tx,
      );

      await budgetLedgerStorage.upsertBudgetPreferences({
        customerId: candidate.customerId,
        budgetStartDate: derivedAnchor,
        budgetStartDateOrigin: "derived_pflegegrad",
      }, operatorUserId ?? undefined, tx);

      after = await calculateAllocatedCents(
        candidate.customerId,
        BUDGET_TYPE,
        { asOfDate },
        tx,
      );

      if (apply) {
        await auditService.log(
          operatorUserId ?? 0,
          "budget_initial_setup",
          "budget",
          candidate.customerId,
          {
            customerId: candidate.customerId,
            budgetType: BUDGET_TYPE,
            budgetStartDate: derivedAnchor,
            previousBudgetStartDate: candidate.currentAnchor,
            previousOrigin: candidate.origin,
            newOrigin: "derived_pflegegrad",
            allocatedBeforeCents: before,
            allocatedAfterCents: after,
            reason:
              "Task #1148: §45b-Anker am Pflegegrad-Beginn verankert + Origin "
              + "'derived_pflegegrad' gesetzt (Bestandskunde hing auf einem Monat fest).",
          },
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

  const { year: curYear, month: curMonth } = currentYearAndMonth();
  const asOfDate = todayISO();

  console.log(`\n=== §45b-„hängt auf einem Monat"-Anker-Fix · Task #1148 ===`);
  await safetyChecks(apply, confirmProd);
  console.log(
    `Stichtag: ${curYear}-${String(curMonth).padStart(2, "0")} · `
    + `${showAll ? "ALLE NULL-Origin-Kandidaten" : "nur betroffene"}`
    + `${onlyCustomer ? ` · nur Kunde #${onlyCustomer}` : ""}\n`,
  );

  const candidates = await loadCandidates(onlyCustomer);
  if (candidates.length === 0) {
    console.log("Keine Kandidaten (origin IS NULL + budget_start_date gesetzt) gefunden.");
    return;
  }

  const operatorUserId = await findOperatorUserId();
  if (apply && operatorUserId == null) {
    throw new Error("Kein Superadmin gefunden — Operator für Audit-Log fehlt.");
  }

  let affectedCount = 0;
  let totalDelta = 0;

  for (const candidate of candidates) {
    const plan = await planFor(candidate, curYear);

    if (!plan.affected && !showAll) continue;

    const { before, after } = plan.affected
      ? await measureAndApply(plan, apply, operatorUserId, asOfDate)
      : { before: 0, after: 0 };

    if (plan.affected) {
      affectedCount++;
      totalDelta += after - before;
    }

    const flag = plan.affected ? (apply ? "✓" : "Δ") : " ";
    const enabledMark = plan.enabled ? "§45b aktiv" : "§45b inaktiv";
    const derived = plan.derivedAnchor ?? "(keine PG-Historie)";
    const deltaStr = plan.affected
      ? ` · ${enabledMark} · Allocated ${euro(before)} → ${euro(after)} (${after - before >= 0 ? "+" : ""}${euro(after - before)})`
      : ` · ${enabledMark}`;

    console.log(
      `${flag} #${candidate.customerId} ${(candidate.name).slice(0, 26).padEnd(26)} `
      + `Anker ${candidate.currentAnchor} → ${derived} `
      + `(§45b effektiv ${plan.effectiveBefore} → ${plan.effectiveAfter ?? "—"})${deltaStr}`,
    );
    if (plan.ibWarning) {
      console.log(
        `    ⚠ Kunde hat einen aktiven §45b-Startwert >= korrigiertem Anker — die reine `
        + `Anker-Korrektur kann unvollständig bleiben. Bitte fix-customer-45b-anchor.ts (#856) prüfen.`,
      );
    }
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte NULL-Origin-Kandidaten: ${candidates.length}`);
  console.log(`Davon betroffen (festhängend):   ${affectedCount}`);
  console.log(`Σ §45b-Allocated-Differenz:      ${totalDelta >= 0 ? "+" : ""}${euro(totalDelta)}`);
  if (affectedCount === 0) {
    console.log(`\n✓ Kein Kunde betroffen — nichts zu reparieren.`);
  } else if (apply) {
    console.log(`\n✓ ${affectedCount} Kunde(n) repariert (Anker + Origin gesetzt, Audit geschrieben).`);
  } else {
    console.log(`\n⚠ ${affectedCount} Kunde(n) würden repariert. Mit --apply scharf ausführen`
      + ` (auf Produktion zusätzlich --confirm-prod).`);
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
