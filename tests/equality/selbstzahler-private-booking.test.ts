/**
 * Task #588 — Equality: Schätzung vs. Verbuchung beim Selbstzahler-Bug.
 *
 * Hintergrund: Bei Selbstzahler-Kunden schlug die Doku mit "Budget reicht
 * nicht — Kunde akzeptiert keine Privatzahlung." fehl, obwohl die
 * Kostenschätzung (`GET /api/budget/:id/cost-estimate`) für Selbstzahler
 * `isHardBlock: false` liefert. Ursache war ein Drift zwischen
 * Schätzung (`server/routes/budget.ts` mit Selbstzahler-Frühausstieg) und
 * Verbuchung (`server/storage/budget/consumption-engine.ts` prüfte
 * ausschließlich `acceptsPrivatePayment`, das für Selbstzahler im UI nicht
 * setzbar ist und per Default `false` bleibt).
 *
 * Dieser Drift-Test spielt die Kreuzmatrix
 *   {selbstzahler, pflegekasse+accepts=true, pflegekasse+accepts=false}
 *   × {Budget voll, Budget leer}
 * durch und prüft, dass Schätzung und Verbuchung KONSISTENT entscheiden.
 *
 * Erwartung pro Zeile:
 *  - Schätzung sagt `isHardBlock: false` ⇒ Verbuchung MUSS durchlaufen.
 *  - Schätzung sagt `isHardBlock: true`  ⇒ Verbuchung MUSS werfen.
 *  - Selbstzahler: niemals Hard-Block, immer 100 % Privat-Buchung,
 *    KEINE §45b/§45a/§39-Konsum-Zeile — selbst wenn (defensiv) eine
 *    Pflegekassen-Allocation am Kunden hängt.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiPut,
  cleanupCustomer,
  createTestCustomer,
  createTestEmployee,
  deactivateTestEmployee,
  getAuthCookie,
  getTodayDate,
  runCleanup,
  uniqueId,
} from "../test-utils";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices, budgetTransactions, customers } from "@shared/schema";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

type Variant =
  | "selbstzahler"
  | "pflegekasse_accepts_private"
  | "pflegekasse_no_private";

interface CostEstimate {
  totalCents: number;
  isHardBlock: boolean;
  privateCents: number;
  isSelbstzahler?: boolean;
  acceptsPrivatePayment?: boolean;
}

interface TxRow {
  id: number;
  appointmentId: number | null;
  budgetType: string;
  amountCents: number;
  transactionType: string;
}

async function getServiceIds(): Promise<Map<string, number>> {
  const r = await apiGet<Array<{ id: number; code: string }>>("/api/services");
  return new Map(r.data.map((s) => [s.code, s.id]));
}

async function createScenarioCustomer(variant: Variant): Promise<number> {
  const tag = uniqueId();
  if (variant === "selbstzahler") {
    const c = await createTestCustomer({
      vorname: "T588-SZ",
      nachname: `Privat-${tag}`,
      billingType: "selbstzahler",
      acceptsPrivatePayment: false,
    });
    return c.id as number;
  }
  const acceptsPrivatePayment = variant === "pflegekasse_accepts_private";
  const c = await createTestCustomer({
    vorname: "T588-PK",
    nachname: `Privat-${tag}`,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment,
  });
  // Defensiv gegen Server-Defaults: das Flag direkt in der DB nachziehen,
  // damit der Pflegekassen-Pfad garantiert mit dem im Variant geforderten
  // `acceptsPrivatePayment` arbeitet und nicht von einem späteren Overlay
  // (z.B. Customer-Update-Helfer) zurückgekippt wird.
  await db
    .update(customers)
    .set({ acceptsPrivatePayment })
    .where(eq(customers.id, c.id as number));
  return c.id as number;
}

async function fillBudget(customerId: number, currentMonthAmountCents: number): Promise<void> {
  await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents,
    carryoverAmountCents: 0,
    budgetStartDate: "2024-01-01",
  });
  await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
  });
}

async function emptyBudget(customerId: number): Promise<void> {
  // §45b hat einen virtuellen Auto-Renewal-Pfad: Auch ohne explizite
  // Allocation rechnet `calculateAllocated45b` ab Jahresanfang den
  // Default-Monatsbetrag (131 €) hoch, sobald §45b in den Type-Settings
  // `enabled` ist. Für ein deterministisch LEERES Budget MÜSSEN deshalb
  // ALLE drei Töpfe abgeschaltet werden (siehe
  // `server/storage/budget/allocation-storage.ts` "Auto-Renewal-Modell").
  await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: false, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
  });
}

async function createAppointmentWithService(
  customerId: number,
  employeeId: number,
  date: string,
  hwServiceId: number,
  durationMinutes: number,
): Promise<number> {
  const [appt] = await db
    .insert(appointments)
    .values({
      customerId,
      assignedEmployeeId: employeeId,
      appointmentType: "kundentermin",
      date,
      scheduledStart: "10:00:00",
      scheduledEnd: "11:00:00",
      durationPromised: durationMinutes,
      status: "scheduled",
      notes: "T588 Equality booking",
    })
    .returning();
  await db.insert(appointmentServices).values({
    appointmentId: appt.id,
    serviceId: hwServiceId,
    plannedDurationMinutes: durationMinutes,
  });
  return appt.id;
}

describe("Equality Schätzung ↔ Verbuchung — Selbstzahler-Privatpfad (Task #588)", () => {
  const matrix: Array<{
    variant: Variant;
    budget: "voll" | "leer";
    label: string;
    expectHardBlock: boolean;
    expectThrow: boolean;
    expectPrivateOnly: boolean;
  }> = [
    {
      variant: "selbstzahler",
      budget: "leer",
      label: "Selbstzahler / kein Budget → niemals Hard-Block, 100 % Privat",
      expectHardBlock: false,
      expectThrow: false,
      expectPrivateOnly: true,
    },
    {
      variant: "selbstzahler",
      budget: "voll",
      // Sicherheitsnetz: selbst wenn (z.B. durch Datenmigration) eine
      // Pflegekassen-Allocation an einem Selbstzahler hängt, MUSS der
      // Verbuchungspfad sie ignorieren und 100 % privat buchen — sonst
      // wäre die Pott-Anzeige in der UI eine Lüge.
      label: "Selbstzahler / mit Allocation → Allocation wird ignoriert, 100 % Privat",
      expectHardBlock: false,
      expectThrow: false,
      expectPrivateOnly: true,
    },
    {
      variant: "pflegekasse_accepts_private",
      budget: "voll",
      label: "Pflegekasse + accepts → Budget voll → kein Hard-Block",
      expectHardBlock: false,
      expectThrow: false,
      expectPrivateOnly: false,
    },
    {
      variant: "pflegekasse_accepts_private",
      budget: "leer",
      label: "Pflegekasse + accepts → Budget leer → kein Hard-Block (Split)",
      expectHardBlock: false,
      expectThrow: false,
      expectPrivateOnly: false,
    },
    {
      variant: "pflegekasse_no_private",
      budget: "voll",
      label: "Pflegekasse OHNE accepts → Budget voll → kein Hard-Block",
      expectHardBlock: false,
      expectThrow: false,
      expectPrivateOnly: false,
    },
    {
      variant: "pflegekasse_no_private",
      budget: "leer",
      label: "Pflegekasse OHNE accepts → Budget leer → Hard-Block (kein Regress)",
      expectHardBlock: true,
      expectThrow: true,
      expectPrivateOnly: false,
    },
  ];

  for (const row of matrix) {
    it(row.label, async () => {
      const auth = await getAuthCookie();
      const date = getTodayDate();
      const services = await getServiceIds();
      const hwServiceId = services.get("hauswirtschaft");
      if (!hwServiceId) throw new Error("Service 'hauswirtschaft' fehlt");

      const customerId = await createScenarioCustomer(row.variant);
      const employee = await createTestEmployee({ nachnamePrefix: `T588_${row.variant}` });
      const employeeId = employee.id;
      try {
        await apiPatch(`/api/admin/customers/${customerId}/assign`, {
          primaryEmployeeId: employeeId,
          backupEmployeeId: null,
          backupEmployeeId2: null,
        });

        if (row.budget === "voll") {
          await fillBudget(customerId, 500_00);
        } else if (row.variant !== "selbstzahler") {
          await emptyBudget(customerId);
        }

        const hwMinutes = 60;

        // 1) Schätzung (Anzeige)
        const estRes = await apiGet<CostEstimate>(
          `/api/budget/${customerId}/cost-estimate?date=${date}` +
            `&hauswirtschaftMinutes=${hwMinutes}&alltagsbegleitungMinutes=0` +
            `&travelKilometers=0&customerKilometers=0`,
        );
        expect(estRes.status, `cost-estimate status (${row.label})`).toBe(200);
        const est = estRes.data;
        const estHardBlock = est.isHardBlock === true;

        expect(
          estHardBlock,
          `Schätzung.isHardBlock=${est.isHardBlock} (totalCents=${est.totalCents}, ` +
            `accepts=${est.acceptsPrivatePayment}, isSelbstzahler=${est.isSelbstzahler}) ` +
            `weicht von Erwartung ${row.expectHardBlock} ab (${row.label})`,
        ).toBe(row.expectHardBlock);

        // 2) Verbuchung über produktiven Pfad
        const apptId = await createAppointmentWithService(
          customerId,
          employeeId,
          date,
          hwServiceId,
          hwMinutes,
        );

        let didThrow = false;
        let thrownMessage = "";
        try {
          await createConsumptionTransaction({
            customerId,
            appointmentId: apptId,
            transactionDate: date,
            hauswirtschaftMinutes: hwMinutes,
            alltagsbegleitungMinutes: 0,
            travelKilometers: 0,
            customerKilometers: 0,
            userId: auth.user.id,
          });
        } catch (err) {
          didThrow = true;
          thrownMessage = err instanceof Error ? err.message : String(err);
        }

        expect(
          didThrow,
          `Verbuchung didThrow=${didThrow} (msg=${thrownMessage}) weicht von ` +
            `Erwartung ${row.expectThrow} ab (${row.label})`,
        ).toBe(row.expectThrow);

        // Drift-Kerninvariant: Schätzung und Verbuchung müssen exakt
        // dieselbe Entscheidung treffen.
        expect(
          didThrow,
          `Drift: Schätzung.isHardBlock=${estHardBlock} ≠ Verbuchung.threw=${didThrow} (${row.label})`,
        ).toBe(estHardBlock);

        if (!row.expectThrow) {
          const txs = (await db
            .select({
              id: budgetTransactions.id,
              appointmentId: budgetTransactions.appointmentId,
              budgetType: budgetTransactions.budgetType,
              amountCents: budgetTransactions.amountCents,
              transactionType: budgetTransactions.transactionType,
            })
            .from(budgetTransactions)
            .where(eq(budgetTransactions.appointmentId, apptId))) as TxRow[];

          const consumption = txs.filter((t) => t.transactionType === "consumption");
          expect(consumption.length, `mind. eine Konsum-Tx (${row.label})`).toBeGreaterThan(0);

          if (row.expectPrivateOnly) {
            // Selbstzahler: KEINE §45b/§45a/§39-Zeile, nur 'private'.
            expect(
              consumption.every((t) => t.budgetType === "private"),
              `Selbstzahler: nur 'private' Konsum-Töpfe erlaubt, ` +
                `gefunden=${consumption.map((t) => t.budgetType).join(",")}`,
            ).toBe(true);
            const sum = consumption.reduce((s, t) => s + Math.abs(t.amountCents), 0);
            expect(
              sum,
              `Selbstzahler: Σ|amount| (=${sum}) muss === cost-estimate.totalCents (=${est.totalCents}) sein`,
            ).toBe(est.totalCents);
          }
        }
      } finally {
        await cleanupCustomer(customerId);
        await deactivateTestEmployee(employeeId);
      }
    }, 120_000);
  }
});
