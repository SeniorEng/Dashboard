import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { eq, and, sql, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations,
  budgetTransactions,
  appointments,
  appointmentServices,
} from "@shared/schema";
import { setupBudgetScenario } from "../helpers/budget-scenarios";
import { freezeTime, thawTime } from "../helpers/frozen-clock";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { processExpiredCarryover } from "../../server/storage/budget/allocation-storage";
import { reverseBudgetTransaction } from "../../server/storage/budget/transaction-storage";
import { getBudgetSummary } from "../../server/storage/budget/summary-queries";
import {
  apiGet,
  getAuthCookie,
  createTestCustomer,
  cleanupCustomer,
} from "../test-utils";

// Property-Tests P1–P5. setupBudgetScenario legt einen API-Customer pro Run an
// (~3–4s). Bei 100 Runs/Property wären das >1500s; daher reduziert auf 30 Runs
// für P1–P4 (API-gebunden) und 50 für P5 (nur DB) per Task-Spec
// "30–50 mit Kommentar". Seed=42 in tests/setup.ts pinned die Reproduzierbarkeit.

const RUNS_API = 30;
const RUNS_DB = 50;

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;

beforeAll(async () => {
  auth = await getAuthCookie();
  const svc = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
  const hw = svc.data.find((s) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Service 'hauswirtschaft' nicht im Katalog");
  hwServiceId = hw.id;
});

function pastWeekdayDates(n: number): string[] {
  const dates: string[] = [];
  const d = new Date();
  while (dates.length < n) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    dates.push(d.toISOString().split("T")[0]);
  }
  return dates;
}

async function insertAppointment(
  customerId: number,
  employeeId: number,
  dateStr: string,
  hwMinutes: number,
): Promise<number> {
  const [appt] = await db
    .insert(appointments)
    .values({
      customerId,
      assignedEmployeeId: employeeId,
      appointmentType: "kundentermin",
      date: dateStr,
      scheduledStart: "08:00:00",
      scheduledEnd: "09:00:00",
      durationPromised: 60,
      status: "scheduled",
      notes: "Property-Test",
    })
    .returning();
  await db.insert(appointmentServices).values({
    appointmentId: appt.id,
    serviceId: hwServiceId,
    plannedDurationMinutes: hwMinutes,
  });
  return appt.id;
}

// Wirft nur Nicht-Budget-Fehler weiter; "Budget reicht nicht" ist im
// Hard-Block-Szenario erwartetes Verhalten und gehört zur Property-Semantik.
async function tryConsume(args: Parameters<typeof createConsumptionTransaction>[0]) {
  try {
    await createConsumptionTransaction(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Budget reicht nicht|Budget unzureichend|insufficient budget/i.test(msg)) return;
    throw e;
  }
}

async function getCentsPerMinute(customerId: number, dateStr: string): Promise<number> {
  const r = await apiGet<{ totalCents: number }>(
    `/api/budget/${customerId}/cost-estimate?date=${dateStr}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`,
  );
  return r.data.totalCents / 60;
}

async function sumDbConsumption(customerId: number): Promise<number> {
  const [r] = await db
    .select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)::int`,
    })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.transactionType, "consumption"),
      ),
    );
  return Number(r?.total ?? 0);
}

async function sumDbAllocations(customerId: number): Promise<number> {
  const [r] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)::int`,
    })
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.customerId, customerId),
        isNull(budgetAllocations.deletedAt),
      ),
    );
  return Number(r?.total ?? 0);
}

describe("Budget Property-Tests (P1–P5)", () => {
  // P1 — SUM(consumption) ≤ SUM(allocations WHERE deleted_at IS NULL)
  // §45b virtuelle Monats-Auto-Allokationen werden via budgetStartDate='2099-01-01'
  // unterdrückt, damit DB-SUM die tatsächliche Cap exakt widerspiegelt
  // (manual_adjustment-Zeilen sind die einzige Allokationsquelle).
  it("P1 — Verbrauch ≤ Allokation + Carryover (Hard-Block)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          initialEuros: fc.integer({ min: 1, max: 100 }),
          carryoverEuros: fc.integer({ min: 0, max: 200 }),
          durations: fc.array(fc.integer({ min: 0, max: 240 }), {
            minLength: 1,
            maxLength: 8,
          }),
        }),
        async ({ initialEuros, carryoverEuros, durations }) => {
          const scenario = await setupBudgetScenario({
            customerNamePrefix: "PROP-P1",
            pflegegrad: 3,
            acceptsPrivatePayment: false,
            preferences: { budgetStartDate: "2099-01-01" },
            types: [
              { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
              { type: "umwandlung_45a", priority: 2, enabled: false },
              { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
            ],
            manualAdjustments: [
              { type: "entlastungsbetrag_45b", amountCents: (initialEuros + carryoverEuros) * 100 },
            ],
          });
          try {
            const dates = pastWeekdayDates(durations.length);
            for (let i = 0; i < durations.length; i++) {
              const apptId = await insertAppointment(
                scenario.customerId,
                scenario.employeeId,
                dates[i],
                durations[i],
              );
              await tryConsume({
                customerId: scenario.customerId,
                appointmentId: apptId,
                transactionDate: dates[i],
                hauswirtschaftMinutes: durations[i],
                alltagsbegleitungMinutes: 0,
                travelKilometers: 0,
                customerKilometers: 0,
                userId: auth.user.id,
              });
            }
            const consumed = await sumDbConsumption(scenario.customerId);
            const allocated = await sumDbAllocations(scenario.customerId);
            expect(consumed).toBeLessThanOrEqual(allocated);
          } finally {
            await scenario.cleanup();
          }
        },
      ),
      { numRuns: RUNS_API },
    );
  }, 600_000);

  // P2 — Storno-Idempotenz: budget_overview vor Konsum == nach komplettem Storno.
  it("P2 — Storno-Idempotenz (Konsum + vollständiger Storno = Baseline)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 30, max: 90 }), { minLength: 1, maxLength: 5 }),
        async (durations) => {
          const scenario = await setupBudgetScenario({
            customerNamePrefix: "PROP-P2",
            pflegegrad: 3,
            acceptsPrivatePayment: true,
            types: [
              { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
              { type: "umwandlung_45a", priority: 2, enabled: false },
              { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
            ],
          });
          try {
            const before = await getBudgetSummary(scenario.customerId);

            const dates = pastWeekdayDates(durations.length);
            for (let i = 0; i < durations.length; i++) {
              const apptId = await insertAppointment(
                scenario.customerId,
                scenario.employeeId,
                dates[i],
                durations[i],
              );
              await tryConsume({
                customerId: scenario.customerId,
                appointmentId: apptId,
                transactionDate: dates[i],
                hauswirtschaftMinutes: durations[i],
                alltagsbegleitungMinutes: 0,
                travelKilometers: 0,
                customerKilometers: 0,
                userId: auth.user.id,
              });
            }

            const consumptionRows = await db
              .select({ id: budgetTransactions.id })
              .from(budgetTransactions)
              .where(
                and(
                  eq(budgetTransactions.customerId, scenario.customerId),
                  eq(budgetTransactions.transactionType, "consumption"),
                ),
              );
            for (const tx of consumptionRows) {
              await reverseBudgetTransaction(tx.id, auth.user.id);
            }

            const after = await getBudgetSummary(scenario.customerId);
            expect(after.totalUsedCents).toBe(before.totalUsedCents);
            expect(after.availableCents).toBe(before.availableCents);
          } finally {
            await scenario.cleanup();
          }
        },
      ),
      { numRuns: RUNS_API },
    );
  }, 600_000);

  // P3 — Cascade respektiert Priority + FIFO innerhalb des Topfes.
  // Zwei priorisierte §45b-Allokationen mit unterschiedlichem validFrom werden
  // direkt in die DB injiziert; ein Termin überschreitet ihre Summe und läuft
  // in den §45a-Cascade-Topf über. Assertion: ältere §45b-Allokation wird
  // zuerst geleert (FIFO via validFrom), erst danach die jüngere, dann §45a.
  it("P3 — Cascade: priorisierter Topf bis Cap, Rest im Folge-Topf, FIFO innerhalb", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          alloc1Euros: fc.integer({ min: 5, max: 25 }),
          alloc2Euros: fc.integer({ min: 5, max: 25 }),
          overflowEuros: fc.integer({ min: 5, max: 30 }),
          cap45aEuros: fc.integer({ min: 60, max: 120 }),
        }),
        async ({ alloc1Euros, alloc2Euros, overflowEuros, cap45aEuros }) => {
          const cap45a = cap45aEuros * 100;
          const sum45b = (alloc1Euros + alloc2Euros) * 100;
          fc.pre(overflowEuros * 100 + 200 < cap45a);

          const scenario = await setupBudgetScenario({
            customerNamePrefix: "PROP-P3",
            pflegegrad: 3,
            acceptsPrivatePayment: true,
            // §45b mit Cap = sum45b limitiert die Konsumtion exakt auf die
            // injizierten manual_adjustments → Cascade nach §45a fängt den Rest.
            // Kein budgetStartDate=2099 hier, sonst wäre auch §45a deaktiviert
            // (calculateAllocated45a iteriert ab budgetStartDate).
            types: [
              { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: sum45b },
              { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: cap45a },
              { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
            ],
          });
          try {
            const curYear = new Date().getFullYear();
            // Zwei §45b-Allokationen mit explizit unterschiedlichem validFrom für FIFO-Test.
            const [older] = await db
              .insert(budgetAllocations)
              .values({
                customerId: scenario.customerId,
                budgetType: "entlastungsbetrag_45b",
                year: curYear,
                month: null,
                amountCents: alloc1Euros * 100,
                source: "manual_adjustment",
                validFrom: `${curYear}-01-01`,
                notes: "P3-older",
              })
              .returning();
            const [newer] = await db
              .insert(budgetAllocations)
              .values({
                customerId: scenario.customerId,
                budgetType: "entlastungsbetrag_45b",
                year: curYear,
                month: null,
                amountCents: alloc2Euros * 100,
                source: "manual_adjustment",
                validFrom: `${curYear}-02-01`,
                notes: "P3-newer",
              })
              .returning();

            const [dateStr] = pastWeekdayDates(1);
            const centsPerMin = await getCentsPerMinute(scenario.customerId, dateStr);
            const targetCost = sum45b + overflowEuros * 100;
            const minutes = Math.max(1, Math.round(targetCost / centsPerMin));
            const expectedTotal = Math.round((minutes / 60) * (centsPerMin * 60));
            fc.pre(expectedTotal > sum45b && expectedTotal <= sum45b + cap45a);

            const apptId = await insertAppointment(
              scenario.customerId,
              scenario.employeeId,
              dateStr,
              minutes,
            );
            await createConsumptionTransaction({
              customerId: scenario.customerId,
              appointmentId: apptId,
              transactionDate: dateStr,
              hauswirtschaftMinutes: minutes,
              alltagsbegleitungMinutes: 0,
              travelKilometers: 0,
              customerKilometers: 0,
              userId: auth.user.id,
            });

            // Aggregat-Check: prio-Topf voll, Rest im Cascade-Topf.
            const byTypeRows = await db
              .select({
                budgetType: budgetTransactions.budgetType,
                total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)::int`,
              })
              .from(budgetTransactions)
              .where(
                and(
                  eq(budgetTransactions.customerId, scenario.customerId),
                  eq(budgetTransactions.transactionType, "consumption"),
                ),
              )
              .groupBy(budgetTransactions.budgetType);
            const byType = new Map(byTypeRows.map((r) => [r.budgetType, Number(r.total)]));
            expect(byType.get("entlastungsbetrag_45b") ?? 0).toBe(sum45b);
            expect(byType.get("umwandlung_45a") ?? 0).toBe(expectedTotal - sum45b);

            // FIFO: älteste §45b-Allokation wird vor der jüngeren entleert.
            const fifoRows = await db
              .select({
                id: budgetTransactions.id,
                allocationId: budgetTransactions.allocationId,
              })
              .from(budgetTransactions)
              .where(
                and(
                  eq(budgetTransactions.customerId, scenario.customerId),
                  eq(budgetTransactions.transactionType, "consumption"),
                  eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
                ),
              )
              .orderBy(budgetTransactions.id);
            const olderIdx = fifoRows.findIndex((r) => r.allocationId === older.id);
            const newerIdx = fifoRows.findIndex((r) => r.allocationId === newer.id);
            expect(olderIdx).toBeGreaterThanOrEqual(0);
            expect(newerIdx).toBeGreaterThanOrEqual(0);
            expect(olderIdx).toBeLessThan(newerIdx);
          } finally {
            await scenario.cleanup();
          }
        },
      ),
      { numRuns: RUNS_API },
    );
  }, 600_000);

  // P4 — Jede consumption-Zeile hat eine Quelle: allocation_id IS NOT NULL ODER
  // (für unlinked Cascade-Konsum) appointment_id IS NOT NULL als Marker.
  it("P4 — Jede Consumption hat Quelle (allocation_id ODER appointment_id)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          initialEuros: fc.integer({ min: 0, max: 30 }),
          durations: fc.array(fc.integer({ min: 15, max: 120 }), {
            minLength: 1,
            maxLength: 5,
          }),
        }),
        async ({ initialEuros, durations }) => {
          const scenario = await setupBudgetScenario({
            customerNamePrefix: "PROP-P4",
            pflegegrad: 3,
            acceptsPrivatePayment: true,
            preferences: { budgetStartDate: "2099-01-01" },
            types: [
              { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
              { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 5000 },
              { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
            ],
            manualAdjustments: initialEuros > 0
              ? [{ type: "entlastungsbetrag_45b", amountCents: initialEuros * 100 }]
              : undefined,
          });
          try {
            const dates = pastWeekdayDates(durations.length);
            for (let i = 0; i < durations.length; i++) {
              const apptId = await insertAppointment(
                scenario.customerId,
                scenario.employeeId,
                dates[i],
                durations[i],
              );
              await tryConsume({
                customerId: scenario.customerId,
                appointmentId: apptId,
                transactionDate: dates[i],
                hauswirtschaftMinutes: durations[i],
                alltagsbegleitungMinutes: 0,
                travelKilometers: 0,
                customerKilometers: 0,
                userId: auth.user.id,
              });
            }

            const rows = await db
              .select({
                id: budgetTransactions.id,
                allocationId: budgetTransactions.allocationId,
                appointmentId: budgetTransactions.appointmentId,
              })
              .from(budgetTransactions)
              .where(
                and(
                  eq(budgetTransactions.customerId, scenario.customerId),
                  eq(budgetTransactions.transactionType, "consumption"),
                ),
              );
            for (const row of rows) {
              expect(
                row.allocationId !== null || row.appointmentId !== null,
                `consumption tx ${row.id} ohne Quelle`,
              ).toBe(true);
            }
          } finally {
            await scenario.cleanup();
          }
        },
      ),
      { numRuns: RUNS_API },
    );
  }, 600_000);

  // P5 — Write-Off ≤ 1 pro Allokation. Nach K7-Fix (Race-Schutz im
  // processExpiredCarryover) ist die Property erfüllt — daher `it`.
  it(
    "P5 — höchstens 1 Write-Off pro Allokation",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            allocations: fc.array(
              fc.record({
                amountCents: fc.integer({ min: 1000, max: 50000 }),
                yearOffset: fc.integer({ min: 1, max: 2 }),
              }),
              { minLength: 1, maxLength: 4 },
            ),
            freezeMonths: fc.array(fc.integer({ min: 7, max: 12 }), {
              minLength: 1,
              maxLength: 3,
            }),
            parallelCalls: fc.integer({ min: 1, max: 5 }),
          }),
          async ({ allocations, freezeMonths, parallelCalls }) => {
            const customer = await createTestCustomer({
              vorname: "PROP-P5",
              nachname: `WriteOff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              pflegegrad: 3,
              billingType: "pflegekasse_gesetzlich",
            });
            const cid = customer.id as number;
            try {
              const curYear = new Date().getFullYear();
              const allocIds: number[] = [];
              for (const a of allocations) {
                const year = curYear - a.yearOffset;
                const [row] = await db
                  .insert(budgetAllocations)
                  .values({
                    customerId: cid,
                    budgetType: "entlastungsbetrag_45b",
                    year,
                    month: null,
                    amountCents: a.amountCents,
                    source: "carryover",
                    validFrom: `${year}-01-01`,
                    expiresAt: `${year}-06-30`,
                    notes: "P5-Property-Test",
                  })
                  .returning();
                allocIds.push(row.id);
              }

              for (const month of freezeMonths) {
                freezeTime(`${curYear}-${String(month).padStart(2, "0")}-15T10:00:00.000Z`);
                try {
                  await Promise.allSettled(
                    Array.from({ length: parallelCalls }, () => processExpiredCarryover(cid)),
                  );
                } finally {
                  thawTime();
                }
              }

              for (const allocId of allocIds) {
                const writeOffs = await db
                  .select({ id: budgetTransactions.id })
                  .from(budgetTransactions)
                  .where(
                    and(
                      eq(budgetTransactions.customerId, cid),
                      eq(budgetTransactions.allocationId, allocId),
                      eq(budgetTransactions.transactionType, "write_off"),
                    ),
                  );
                expect(writeOffs.length).toBeLessThanOrEqual(1);
              }
            } finally {
              await cleanupCustomer(cid);
            }
          },
        ),
        { numRuns: RUNS_DB },
      );
    },
    300_000,
  );
});
