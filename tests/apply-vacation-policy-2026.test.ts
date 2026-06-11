import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../server/lib/db";
import { eq, inArray } from "drizzle-orm";
import {
  users,
  employeeVacationAllowance,
  vacationEntitlementHistory,
} from "@shared/schema";
import {
  TARGET_YEAR,
  TARGET_MONTH,
  selectActivePolicyEmployees,
  buildVacationPolicyPlans,
  applyPlan,
  planHasChanges,
  resolveActorUserId,
  type EmployeePlan,
} from "../server/scripts/apply-vacation-policy-2026";
import {
  getVacationAllowance,
  getVacationEntitlementHistoryForUser,
} from "../server/storage/time-tracking/vacation";

/**
 * Regressionsschutz für das Operator-Skript `apply-vacation-policy-2026.ts`.
 *
 * Geprüft wird die Skript-KERNLOGIK (Auswahl aktiver Mitarbeitender, Planbildung
 * und Anwendung) gegen eine echte (Wegwerf-)DB. Um auf JEDER DB ungefährlich zu
 * sein, wird das `applyPlan` BEWUSST nur auf die hier frisch geseedeten
 * Mitarbeitenden angewandt (gefiltert nach `seededIds`) — nicht auf den
 * kompletten Mandanten. Die Eingrenzung "nur aktive `aktiv`-Mitarbeitende"
 * wird separat über `selectActivePolicyEmployees()` verifiziert.
 */

const SUFFIX = `vacpol2026-${Date.now()}`;

interface SeededEmployees {
  minijobber: number;
  sozialVoll: number;
  sozialEintritt2026: number;
  inaktivFlag: number;
  statusInaktiv: number;
}

let seeded: SeededEmployees;
let seededIds: number[] = [];

async function insertEmployee(opts: {
  name: string;
  employmentType: string;
  employmentStatus: string;
  isActive: boolean;
  vacationDaysPerYear: number;
  weeklyWorkDays: number;
  eintrittsdatum: string;
}): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `${opts.name}.${SUFFIX}@test.local`,
      passwordHash: "x",
      displayName: `${opts.name} ${SUFFIX}`,
      employmentType: opts.employmentType,
      employmentStatus: opts.employmentStatus,
      isActive: opts.isActive,
      vacationDaysPerYear: opts.vacationDaysPerYear,
      weeklyWorkDays: opts.weeklyWorkDays,
      eintrittsdatum: opts.eintrittsdatum,
    })
    .returning({ id: users.id });
  return row.id;
}

beforeAll(async () => {
  // Minijobber mit "falschen" Profilwerten (Default 30/5) → soll auf 12/2.
  const minijobber = await insertEmployee({
    name: "minijobber",
    employmentType: "minijobber",
    employmentStatus: "aktiv",
    isActive: true,
    vacationDaysPerYear: 30,
    weeklyWorkDays: 5,
    eintrittsdatum: "2024-01-01",
  });

  // Sozialversicherungspflichtig, volles Jahr, "falsche" Werte (12/2) → 30/5.
  const sozialVoll = await insertEmployee({
    name: "sozialvoll",
    employmentType: "sozialversicherungspflichtig",
    employmentStatus: "aktiv",
    isActive: true,
    vacationDaysPerYear: 12,
    weeklyWorkDays: 2,
    eintrittsdatum: "2024-01-01",
  });

  // Sozialversicherungspflichtig, unterjähriger Eintritt 01.07.2026 → Pro-Rata.
  const sozialEintritt2026 = await insertEmployee({
    name: "sozialeintritt",
    employmentType: "sozialversicherungspflichtig",
    employmentStatus: "aktiv",
    isActive: true,
    vacationDaysPerYear: 12,
    weeklyWorkDays: 2,
    eintrittsdatum: "2026-07-01",
  });

  // Inaktiv via Flag (isActive = false) — darf NICHT angefasst werden.
  const inaktivFlag = await insertEmployee({
    name: "inaktivflag",
    employmentType: "minijobber",
    employmentStatus: "aktiv",
    isActive: false,
    vacationDaysPerYear: 30,
    weeklyWorkDays: 5,
    eintrittsdatum: "2024-01-01",
  });

  // Status != "aktiv" (inaktiv) — darf NICHT angefasst werden.
  const statusInaktiv = await insertEmployee({
    name: "statusinaktiv",
    employmentType: "minijobber",
    employmentStatus: "inaktiv",
    isActive: true,
    vacationDaysPerYear: 30,
    weeklyWorkDays: 5,
    eintrittsdatum: "2024-01-01",
  });

  seeded = {
    minijobber,
    sozialVoll,
    sozialEintritt2026,
    inaktivFlag,
    statusInaktiv,
  };
  seededIds = Object.values(seeded);

  // Bestehende 2026-Allowances mit Carry-Over vorbelegen (mit absichtlich
  // falschen totalDays), um zu prüfen, dass der Carry-Over erhalten bleibt und
  // totalDays korrigiert wird.
  await db.insert(employeeVacationAllowance).values([
    {
      userId: minijobber,
      year: TARGET_YEAR,
      totalDays: "99.00",
      carryOverDays: 7,
      notes: "Carry-Over-Notiz Minijobber",
    },
    {
      userId: sozialVoll,
      year: TARGET_YEAR,
      totalDays: "99.00",
      carryOverDays: 5,
      notes: "Carry-Over-Notiz Sozial",
    },
  ]);
});

afterAll(async () => {
  if (seededIds.length === 0) return;
  await db
    .delete(vacationEntitlementHistory)
    .where(inArray(vacationEntitlementHistory.userId, seededIds));
  await db
    .delete(employeeVacationAllowance)
    .where(inArray(employeeVacationAllowance.userId, seededIds));
  await db.delete(users).where(inArray(users.id, seededIds));
});

// Plant + wendet die Kernlogik NUR für die geseedeten Mitarbeitenden an.
async function applyPolicyForSeeded(): Promise<EmployeePlan[]> {
  const active = await selectActivePolicyEmployees();
  const mine = active.filter((e) => seededIds.includes(e.id));
  const { plans } = await buildVacationPolicyPlans(mine);
  const changing = plans.filter(planHasChanges);
  const actorUserId = await resolveActorUserId();
  for (const p of changing) {
    await applyPlan(p, actorUserId);
  }
  return plans;
}

describe("apply-vacation-policy-2026 — Skript-Kernlogik", () => {
  it("selectActivePolicyEmployees erfasst nur aktive 'aktiv'-Mitarbeitende", async () => {
    const active = await selectActivePolicyEmployees();
    const activeIds = active.map((e) => e.id);

    expect(activeIds).toContain(seeded.minijobber);
    expect(activeIds).toContain(seeded.sozialVoll);
    expect(activeIds).toContain(seeded.sozialEintritt2026);
    // Inaktive bzw. nicht-"aktiv" Mitarbeitende werden ausgeschlossen.
    expect(activeIds).not.toContain(seeded.inaktivFlag);
    expect(activeIds).not.toContain(seeded.statusInaktiv);
  });

  it("setzt Profil-, Historie- und Allowance-Werte korrekt (inkl. Pro-Rata & Carry-Over)", async () => {
    await applyPolicyForSeeded();

    // --- Minijobber: Profil 12/2, History (2026,1)=12, Allowance 12, CO=7 ---
    const [mj] = await db
      .select({
        vacationDaysPerYear: users.vacationDaysPerYear,
        weeklyWorkDays: users.weeklyWorkDays,
      })
      .from(users)
      .where(eq(users.id, seeded.minijobber));
    expect(mj.vacationDaysPerYear).toBe(12);
    expect(mj.weeklyWorkDays).toBe(2);

    const mjHistory = await getVacationEntitlementHistoryForUser(seeded.minijobber);
    const mjJan = mjHistory.find(
      (h) => h.validFromYear === TARGET_YEAR && h.validFromMonth === TARGET_MONTH,
    );
    expect(mjJan?.daysPerYear).toBe(12);

    const mjAllowance = await getVacationAllowance(seeded.minijobber, TARGET_YEAR);
    expect(Number(mjAllowance?.totalDays)).toBeCloseTo(12, 5);
    expect(mjAllowance?.carryOverDays).toBe(7);
    expect(mjAllowance?.notes).toBe("Carry-Over-Notiz Minijobber");

    // --- Sozial volles Jahr: Profil 30/5, History 30, Allowance 30, CO=5 ---
    const [sv] = await db
      .select({
        vacationDaysPerYear: users.vacationDaysPerYear,
        weeklyWorkDays: users.weeklyWorkDays,
      })
      .from(users)
      .where(eq(users.id, seeded.sozialVoll));
    expect(sv.vacationDaysPerYear).toBe(30);
    expect(sv.weeklyWorkDays).toBe(5);

    const svHistory = await getVacationEntitlementHistoryForUser(seeded.sozialVoll);
    const svJan = svHistory.find(
      (h) => h.validFromYear === TARGET_YEAR && h.validFromMonth === TARGET_MONTH,
    );
    expect(svJan?.daysPerYear).toBe(30);

    const svAllowance = await getVacationAllowance(seeded.sozialVoll, TARGET_YEAR);
    expect(Number(svAllowance?.totalDays)).toBeCloseTo(30, 5);
    expect(svAllowance?.carryOverDays).toBe(5);

    // --- Sozial Eintritt 01.07.2026: Pro-Rata 30/12*6 = 15, CO=0 (neu) ---
    const seHistory = await getVacationEntitlementHistoryForUser(
      seeded.sozialEintritt2026,
    );
    const seJan = seHistory.find(
      (h) => h.validFromYear === TARGET_YEAR && h.validFromMonth === TARGET_MONTH,
    );
    expect(seJan?.daysPerYear).toBe(30);

    const seAllowance = await getVacationAllowance(
      seeded.sozialEintritt2026,
      TARGET_YEAR,
    );
    expect(Number(seAllowance?.totalDays)).toBeCloseTo(15, 5);
    expect(seAllowance?.carryOverDays).toBe(0);
  });

  it("lässt inaktive / nicht-'aktiv' Mitarbeitende unangetastet", async () => {
    for (const id of [seeded.inaktivFlag, seeded.statusInaktiv]) {
      const [u] = await db
        .select({
          vacationDaysPerYear: users.vacationDaysPerYear,
          weeklyWorkDays: users.weeklyWorkDays,
        })
        .from(users)
        .where(eq(users.id, id));
      // Profil unverändert (Ausgangswerte 30/5).
      expect(u.vacationDaysPerYear).toBe(30);
      expect(u.weeklyWorkDays).toBe(5);

      // Keine 2026-Historie und keine Allowance angelegt.
      const history = await getVacationEntitlementHistoryForUser(id);
      expect(
        history.some(
          (h) => h.validFromYear === TARGET_YEAR && h.validFromMonth === TARGET_MONTH,
        ),
      ).toBe(false);
      const allowance = await getVacationAllowance(id, TARGET_YEAR);
      expect(allowance).toBeUndefined();
    }
  });

  it("ist idempotent — ein zweiter Lauf erzeugt keine Änderungen", async () => {
    const plans = await applyPolicyForSeeded();
    const changing = plans.filter(planHasChanges);
    expect(changing).toHaveLength(0);
  });
});
