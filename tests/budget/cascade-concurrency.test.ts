import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getAuthCookie } from "../test-utils";
import { db } from "../../server/lib/db";
import { budgetTransactions } from "@shared/schema";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { runInParallel } from "../helpers/race";
import { createCascadeConsumption } from "../../server/storage/budget/consumption-engine";
import type { CascadeResult } from "../../server/storage/budget/types";

describe("Race — paralleler Cascade-Consume (Task #494)", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    await getAuthCookie();
  });

  afterEach(async () => {
    if (scenario) {
      await scenario.cleanup();
    }
  });

  it("RACE — 50 parallele createCascadeConsumption-Calls überbuchen den §45b-Topf nicht (Advisory-Lock im Cascade-Pfad)", async () => {
    // Aktueller Monat als Buchungsdatum, damit die initial_balance-
    // Allokation an dem Datum garantiert valid ist.
    const today = new Date();
    const monthStr = String(today.getMonth() + 1).padStart(2, "0");
    const budgetStartDate = `${today.getFullYear()}-${monthStr}-01`;
    const txDate = `${today.getFullYear()}-${monthStr}-15`;

    const ALLOCATION_CENTS = 10_000;
    const N = 50;
    const PER_CALL_CENTS = 1_000;

    // §45b mit monthlyLimitCents=0 → kein Monats-Auto-Income, d.h. das
    // Allocation-Total bleibt stabil bei genau ALLOCATION_CENTS (initial
    // balance). 45a/39 sind deaktiviert, acceptsPrivatePayment=false, damit
    // ein Überlauf NICHT auf Privat ausweichen kann.
    scenario = await setupBudgetScenario({
      customerNamePrefix: "RACE-CASCADE",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 0 },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: ALLOCATION_CENTS,
        validFrom: budgetStartDate,
      },
      appointments: [
        {
          date: txDate,
          scheduledStart: "08:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 30 }],
          notes: "RACE-CASCADE dummy appointment",
        },
      ],
    });

    expect(scenario.appointmentIds).toHaveLength(1);
    const apptId = scenario.appointmentIds[0];

    // 50 echte parallele Cascade-Calls in derselben Mikrotask.
    // skipExistingCheck=true, damit die Wiederverwendung der appointmentId
    // nicht am Existenz-Check scheitert — der Test zielt auf das
    // Lock-Verhalten der Cascade-Schleife selbst.
    const calls: Array<() => Promise<CascadeResult>> = Array.from({ length: N }, () => () =>
      createCascadeConsumption({
        customerId: scenario.customerId,
        appointmentId: apptId,
        transactionDate: txDate,
        totalAmountCents: PER_CALL_CENTS,
        hauswirtschaftMinutes: 10,
        hauswirtschaftCents: PER_CALL_CENTS,
        alltagsbegleitungMinutes: 0,
        alltagsbegleitungCents: 0,
        travelKilometers: 0,
        travelCents: 0,
        customerKilometers: 0,
        customerKilometersCents: 0,
        skipExistingCheck: true,
      }),
    );

    const results = await runInParallel(calls);

    // Keine harten Fehler — Cascade verbucht den Überlauf als
    // `outstandingCents`, wirft nicht.
    const failures = results.filter((r) => r.status === "rejected");
    expect(
      failures,
      `Cascade-Calls dürfen nicht hart fehlschlagen: ${failures
        .map((f) => String((f as PromiseRejectedResult).reason?.message ?? f))
        .join(" | ")}`,
    ).toHaveLength(0);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<CascadeResult> => r.status === "fulfilled",
    );
    const totalReportedConsumed = fulfilled.reduce(
      (sum, r) => sum + r.value.totalConsumedCents,
      0,
    );
    const totalReportedOutstanding = fulfilled.reduce(
      (sum, r) => sum + r.value.outstandingCents,
      0,
    );

    // Σ(reported consumed) + Σ(outstanding) = Σ(angefragt). Verbalisierte
    // Mengen-Erhaltung pro Aufruf.
    expect(totalReportedConsumed + totalReportedOutstanding).toBe(N * PER_CALL_CENTS);

    // Wahrheit aus der DB: gebuchte Konsumtionen über alle 50 Calls.
    const consumedRow = await db
      .select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      })
      .from(budgetTransactions)
      .where(
        and(
          eq(budgetTransactions.customerId, scenario.customerId),
          eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
          eq(budgetTransactions.transactionType, "consumption"),
        ),
      );
    const totalDbConsumed = Number(consumedRow[0]?.total ?? 0);

    // Kerninvariante: Summe der DB-Konsumtionen == Summe der gemeldeten
    // Konsumtionen UND ≤ Allokation. Ohne Lock würden mehrere parallele
    // Cascades dieselbe `available`-Sicht lesen und unabhängig je
    // PER_CALL_CENTS schreiben — totalDbConsumed wäre dann > ALLOCATION_CENTS.
    expect(totalDbConsumed).toBe(totalReportedConsumed);
    expect(totalDbConsumed).toBeLessThanOrEqual(ALLOCATION_CENTS);

    // Lock greift wirklich: genau ALLOCATION_CENTS wurden verbucht, der
    // Rest landete als outstandingCents bei den verlierenden Calls.
    expect(totalDbConsumed).toBe(ALLOCATION_CENTS);
    expect(totalReportedOutstanding).toBe(N * PER_CALL_CENTS - ALLOCATION_CENTS);
  });
});
