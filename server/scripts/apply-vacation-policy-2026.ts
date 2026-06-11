/**
 * Task #1218 — Urlaubsregelung 2026 per Skript anwenden.
 *
 * Eine neue Urlaubsregelung gilt ab dem 01.01.2026 für das volle Jahr und wird
 * pauschal nach Anstellungsart auf alle AKTIVEN Mitarbeitenden angewendet:
 *
 *   - minijobber                  → 12 Urlaubstage/Jahr, 2 Arbeitstage/Woche
 *   - sozialversicherungspflichtig → 30 Urlaubstage/Jahr, 5 Arbeitstage/Woche
 *
 * Das Skript nutzt AUSSCHLIESSLICH die bereits vorhandene Urlaubs-Logik
 * (Anspruchs-Historie + Jahres-Allowance-Cache), damit die monatsgenaue
 * Pro-Rata-Berechnung bei unterjährigem Eintritt automatisch greift:
 *   1. Profilwerte `vacationDaysPerYear` / `weeklyWorkDays` (nur wenn abweichend).
 *   2. Anspruchs-Historie-Eintrag gültig ab Januar 2026 via
 *      `upsertVacationEntitlementHistory` (Upsert auf (userId, 2026, 1)).
 *   3. Jahres-Allowance 2026 via `computeAnnualEntitlement` (aus der neuen
 *      History abgeleitet) + `setVacationAllowance`; der bestehende
 *      `carryOverDays`-Wert und die Notiz bleiben unangetastet.
 *
 * GELTUNGSBEREICH: Nur aktive Mitarbeitende (`isActive = true`,
 * `employmentStatus = "aktiv"`), analog zum `syncVacationCarryover`-Job.
 * Carry-Over bleibt unverändert; nur der Jahresanspruch 2026 wird neu gesetzt.
 *
 * IDEMPOTENZ: Jeder der drei Schritte wird nur ausgeführt, wenn der Soll-Wert
 * vom Ist-Wert abweicht. Ein zweiter Lauf findet daher nichts mehr.
 *
 * DRY-RUN (Default): Ohne `--apply` wird NICHTS geschrieben — der Report zeigt
 * exakt, was ein scharfer Lauf ändern WÜRDE.
 *
 * SICHERHEIT: Hard-Stop bei `NODE_ENV=production` und bei einem DB-Host, der
 * nach Produktion aussieht (analog `clamp-over-limit-budget-type-settings.ts`).
 * Das Skript wird NIE automatisch ausgeführt — nur manuell durch einen Operator.
 *
 * Aufruf:
 *   tsx server/scripts/apply-vacation-policy-2026.ts            # Dry-Run
 *   tsx server/scripts/apply-vacation-policy-2026.ts --apply    # schreibend
 */
import { and, eq } from "drizzle-orm";
import { db } from "../lib/db";
import { users, type EmploymentType } from "@shared/schema";
import { timeTrackingStorage } from "../storage/time-tracking";

const APPLY = process.argv.includes("--apply");

const TARGET_YEAR = 2026;
const TARGET_MONTH = 1; // Januar 2026

interface PolicyTarget {
  vacationDaysPerYear: number;
  weeklyWorkDays: number;
}

const POLICY_BY_EMPLOYMENT_TYPE: Record<EmploymentType, PolicyTarget> = {
  minijobber: { vacationDaysPerYear: 12, weeklyWorkDays: 2 },
  sozialversicherungspflichtig: { vacationDaysPerYear: 30, weeklyWorkDays: 5 },
};

// Individuell vereinbarte Ausnahmen (NICHT pauschal nach Anstellungsart).
// Diese Mitarbeitenden werden vom Skript komplett übersprungen, damit ein
// erneuter Lauf ihre individuell zugesagten Werte nicht auf den pauschalen
// Anstellungsart-Wert zurücksetzt. Schlüssel = userId, Wert = Begründung.
const INDIVIDUAL_EXCEPTIONS: Record<number, string> = {
  11: "Ursula Ullmann — individuell vereinbart: 33 Urlaubstage/Jahr",
};

async function safetyChecks(apply: boolean): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("ABBRUCH: NODE_ENV=production. Dieses Skript darf nie auf Produktion laufen.");
  }
  const url = process.env.DATABASE_URL || "";
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/@([^:/?#]+)/);
    host = (m ? m[1] : "").toLowerCase();
  }
  if (host && /(^|[.-])prod([.-]|$)|production/.test(host)) {
    throw new Error(`ABBRUCH: DB-Host '${host}' sieht nach Produktion aus. Dieses Skript darf nie auf Produktion laufen.`);
  }
  console.log(`Sicherheits-Checks ok. DB-Host: ${host || "(unbekannt)"} · Modus: ${apply ? "APPLY (schreibend)" : "DRY-RUN"}`);
}

async function resolveActorUserId(): Promise<number | null> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .limit(1);
  return admin?.id ?? null;
}

interface EmployeePlan {
  userId: number;
  displayName: string;
  employmentType: EmploymentType;
  target: PolicyTarget;
  profileChange: {
    vacationDaysPerYear?: { before: number; after: number };
    weeklyWorkDays?: { before: number; after: number };
  } | null;
  historyChange: { before: number | null; after: number } | null;
  allowanceChange: { before: number | null; after: number } | null;
}

interface CategoryCounts {
  profiles: number;
  historyEntries: number;
  allowances: number;
}

async function buildPlanForEmployee(emp: {
  id: number;
  displayName: string | null;
  employmentType: string;
  vacationDaysPerYear: number | null;
  weeklyWorkDays: number;
  eintrittsdatum: string | null;
}): Promise<EmployeePlan> {
  const employmentType = emp.employmentType as EmploymentType;
  const target = POLICY_BY_EMPLOYMENT_TYPE[employmentType];

  // --- 1. Profil ---
  const profileChange: EmployeePlan["profileChange"] = {};
  const currentVacDays = emp.vacationDaysPerYear ?? 30;
  if (currentVacDays !== target.vacationDaysPerYear) {
    profileChange.vacationDaysPerYear = { before: currentVacDays, after: target.vacationDaysPerYear };
  }
  if (emp.weeklyWorkDays !== target.weeklyWorkDays) {
    profileChange.weeklyWorkDays = { before: emp.weeklyWorkDays, after: target.weeklyWorkDays };
  }
  const hasProfileChange = Object.keys(profileChange).length > 0;

  // --- 2. Anspruchs-Historie (Januar 2026) ---
  const history = await timeTrackingStorage.getVacationEntitlementHistoryForUser(emp.id);
  const existingJan2026 = history.find(
    (h) => h.validFromYear === TARGET_YEAR && h.validFromMonth === TARGET_MONTH,
  );
  const historyChange =
    existingJan2026?.daysPerYear === target.vacationDaysPerYear
      ? null
      : { before: existingJan2026?.daysPerYear ?? null, after: target.vacationDaysPerYear };

  // --- 3. Jahres-Allowance 2026 ---
  // Soll-Anspruch aus der (zukünftigen) History ableiten: wir simulieren den
  // Januar-2026-Eintrag lokal, damit Dry-Run und Apply denselben Wert zeigen.
  const projectedHistory = [
    ...history.filter((h) => !(h.validFromYear === TARGET_YEAR && h.validFromMonth === TARGET_MONTH)),
    {
      id: -1,
      userId: emp.id,
      validFromYear: TARGET_YEAR,
      validFromMonth: TARGET_MONTH,
      daysPerYear: target.vacationDaysPerYear,
      createdAt: new Date(),
      createdBy: null,
    },
  ];
  const targetTotalDays = timeTrackingStorage.computeAnnualEntitlement(
    projectedHistory,
    target.vacationDaysPerYear,
    emp.eintrittsdatum ?? null,
    TARGET_YEAR,
  );
  const existingAllowance = await timeTrackingStorage.getVacationAllowance(emp.id, TARGET_YEAR);
  const existingTotal = existingAllowance ? Number(existingAllowance.totalDays) : null;
  const allowanceChange =
    existingTotal !== null && Math.abs(existingTotal - targetTotalDays) < 1e-9
      ? null
      : { before: existingTotal, after: targetTotalDays };

  return {
    userId: emp.id,
    displayName: emp.displayName ?? `Mitarbeiter #${emp.id}`,
    employmentType,
    target,
    profileChange: hasProfileChange ? profileChange : null,
    historyChange,
    allowanceChange,
  };
}

async function applyPlan(plan: EmployeePlan, actorUserId: number | null): Promise<void> {
  // 1. Profil
  if (plan.profileChange) {
    await db
      .update(users)
      .set({
        vacationDaysPerYear: plan.target.vacationDaysPerYear,
        weeklyWorkDays: plan.target.weeklyWorkDays,
        updatedAt: new Date(),
      })
      .where(eq(users.id, plan.userId));
  }

  // 2. Anspruchs-Historie (Upsert ist idempotent — letzter Wert gewinnt)
  if (plan.historyChange) {
    await timeTrackingStorage.upsertVacationEntitlementHistory({
      userId: plan.userId,
      validFromYear: TARGET_YEAR,
      validFromMonth: TARGET_MONTH,
      daysPerYear: plan.target.vacationDaysPerYear,
      createdBy: actorUserId,
    });
  }

  // 3. Jahres-Allowance 2026 (Carry-Over + Notiz bleiben erhalten). Anspruch
  // wird aus der frisch geschriebenen History über die bestehende Logik
  // abgeleitet — unterjähriger Eintritt greift via `eintrittsdatum` automatisch.
  if (plan.allowanceChange) {
    const [existingAllowance, freshHistory, [u]] = await Promise.all([
      timeTrackingStorage.getVacationAllowance(plan.userId, TARGET_YEAR),
      timeTrackingStorage.getVacationEntitlementHistoryForUser(plan.userId),
      db
        .select({ eintrittsdatum: users.eintrittsdatum })
        .from(users)
        .where(eq(users.id, plan.userId))
        .limit(1),
    ]);
    const totalDays = timeTrackingStorage.computeAnnualEntitlement(
      freshHistory,
      plan.target.vacationDaysPerYear,
      u?.eintrittsdatum ?? null,
      TARGET_YEAR,
    );
    await timeTrackingStorage.setVacationAllowance({
      userId: plan.userId,
      year: TARGET_YEAR,
      totalDays,
      carryOverDays: existingAllowance?.carryOverDays ?? 0,
      notes: existingAllowance?.notes ?? null,
    });
  }
}

function planHasChanges(plan: EmployeePlan): boolean {
  return plan.profileChange !== null || plan.historyChange !== null || plan.allowanceChange !== null;
}

async function main(): Promise<void> {
  await safetyChecks(APPLY);

  const activeEmployees = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      employmentType: users.employmentType,
      vacationDaysPerYear: users.vacationDaysPerYear,
      weeklyWorkDays: users.weeklyWorkDays,
      eintrittsdatum: users.eintrittsdatum,
    })
    .from(users)
    .where(and(eq(users.isActive, true), eq(users.employmentStatus, "aktiv")));

  if (activeEmployees.length === 0) {
    console.log("Keine aktiven Mitarbeitenden gefunden. Nichts zu tun.");
    return;
  }

  const plans: EmployeePlan[] = [];
  for (const emp of activeEmployees) {
    if (emp.id in INDIVIDUAL_EXCEPTIONS) {
      console.log(`↷ Mitarbeiter ${emp.id} übersprungen (Ausnahme: ${INDIVIDUAL_EXCEPTIONS[emp.id]}).`);
      continue;
    }
    if (!(emp.employmentType in POLICY_BY_EMPLOYMENT_TYPE)) {
      console.warn(`⚠ Mitarbeiter ${emp.id} hat unbekannte Anstellungsart '${emp.employmentType}' — übersprungen.`);
      continue;
    }
    plans.push(await buildPlanForEmployee(emp));
  }

  const changing = plans.filter(planHasChanges);

  console.log(
    `\n${activeEmployees.length} aktive Mitarbeitende geprüft · ${changing.length} mit ausstehenden Änderungen.\n`,
  );

  for (const p of changing) {
    console.log(`Mitarbeiter ${p.userId} (${p.displayName}) · ${p.employmentType}:`);
    if (p.profileChange?.vacationDaysPerYear) {
      const c = p.profileChange.vacationDaysPerYear;
      console.log(`  • Profil vacationDaysPerYear: ${c.before} → ${c.after}`);
    }
    if (p.profileChange?.weeklyWorkDays) {
      const c = p.profileChange.weeklyWorkDays;
      console.log(`  • Profil weeklyWorkDays: ${c.before} → ${c.after}`);
    }
    if (p.historyChange) {
      console.log(
        `  • Historie ${TARGET_YEAR}-${String(TARGET_MONTH).padStart(2, "0")}: ${p.historyChange.before ?? "—"} → ${p.historyChange.after} Tage/Jahr`,
      );
    }
    if (p.allowanceChange) {
      console.log(
        `  • Allowance ${TARGET_YEAR} totalDays: ${p.allowanceChange.before ?? "—"} → ${p.allowanceChange.after}`,
      );
    }
  }

  // Zusammenfassung je Anstellungsart.
  const summary = new Map<EmploymentType, CategoryCounts>();
  for (const p of changing) {
    const c = summary.get(p.employmentType) ?? { profiles: 0, historyEntries: 0, allowances: 0 };
    if (p.profileChange) c.profiles += 1;
    if (p.historyChange) c.historyEntries += 1;
    if (p.allowanceChange) c.allowances += 1;
    summary.set(p.employmentType, c);
  }

  if (changing.length === 0) {
    console.log("Alles bereits auf dem Soll-Stand der Urlaubsregelung 2026 (idempotent).");
    return;
  }

  if (!APPLY) {
    console.log("\n— Zusammenfassung (DRY-RUN, nichts geschrieben) —");
    for (const [type, c] of summary) {
      console.log(
        `  ${type}: ${c.profiles} Profil(e) · ${c.historyEntries} Historie-Eintrag/-träge · ${c.allowances} Allowance(s)`,
      );
    }
    console.log("\nDRY-RUN: nichts geschrieben. Mit --apply scharf ausführen.");
    return;
  }

  const actorUserId = await resolveActorUserId();
  for (const p of changing) {
    await applyPlan(p, actorUserId);
    console.log(`✓ Mitarbeiter ${p.userId} (${p.displayName}) aktualisiert.`);
  }

  console.log("\n— Zusammenfassung (APPLY) —");
  for (const [type, c] of summary) {
    console.log(
      `  ${type}: ${c.profiles} Profil(e) · ${c.historyEntries} Historie-Eintrag/-träge · ${c.allowances} Allowance(s)`,
    );
  }
  console.log(`\nFertig. ${changing.length} Mitarbeitende aktualisiert.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
