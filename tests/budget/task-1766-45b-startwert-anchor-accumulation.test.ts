/**
 * Task #1812 (konsolidiert #1766) — §45b-Startwert = RESET / Re-Baseline.
 *
 * Frühere Semantik (#1766): Ein mittjähriger §45b-Startwert war ADDITIV — die
 * volle Monatsansammlung ab dem Eligibility-Anker (Jan–Jul = 7 × 131 €) blieb
 * bestehen und der Startwert ersetzte nur die virtuelle Aufstockung SEINES
 * Monats.
 *
 * Neue Semantik (#1812): Der zum Stichtag späteste wirksame Startwert-Monat M
 * ist eine NEUE BASIS. Er ERSETZT jede Ansammlung <= M (inkl. Überträge). Nur
 * Monate NACH M akkumulieren weiter (auf den Jahres-Cap begrenzt). Verbrauch
 * VOR M ist bereits in der neuen Basis abgebildet und darf NICHT erneut vom
 * laufenden Topf abgezogen werden.
 *
 * Konkret hier: Startwert 131 € im Juli, Stichtag Mitte Juli → allocated = 131 €
 * (die neue Basis), NICHT 917 €. Ein rückdatierter Read VOR Juli sieht den Reset
 * noch nicht (Startwert noch nicht wirksam).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices } from "@shared/schema";
import {
  computeFifoAvailability,
  createConsumptionTransaction,
} from "../../server/storage/budget/consumption-engine";
import {
  upsertCarryoverAllocation,
  upsertInitialBalanceAllocation,
} from "../../server/storage/budget/allocation-storage";
import { getAvailableForDate } from "../../server/storage/budget/import-availability";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import {
  apiGet,
  apiPost,
  apiPut,
  cleanupCustomer,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

const YEAR = new Date().getFullYear();
const MONTHLY_45B_CENTS = 13100;
const STARTWERT_MONAT = 7; // Juli
const AS_OF = `${YEAR}-0${STARTWERT_MONAT}-15`;
// Pflegegrad seit Vorjahr → §45b-Anker gebodet auf 1.1. laufendes Jahr.
const PFLEGEGRAD_SEIT = `${YEAR - 1}-10-01`;
// Anker Januar, Stichtag Mitte Juli → OHNE Reset wären das 7 berechtigte Monate.
const FULL_ACCRUAL = STARTWERT_MONAT * MONTHLY_45B_CENTS;
// MIT Reset (Startwert im Juli, Stichtag Mitte Juli, keine Monate nach Juli):
// die neue Basis ist der Startwert selbst.
const EXPECTED_RESET_BASELINE = MONTHLY_45B_CENTS;

interface OverviewDTO {
  entlastungsbetrag45b: {
    totalAllocatedCents: number;
    totalUsedCents: number;
    availableCents: number;
    availableAfterPlannedCents: number;
  };
}

const createdCustomers: number[] = [];

beforeAll(async () => {
  await getAuthCookie();
});

afterEach(async () => {
  while (createdCustomers.length) {
    await cleanupCustomer(createdCustomers.pop());
  }
});

afterAll(async () => {
  await runCleanup();
});

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T1812_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    pflegegradSeit: PFLEGEGRAD_SEIT,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  createdCustomers.push(id);
  return id;
}

async function enable45b(customerId: number): Promise<void> {
  const res = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
  });
  expect(res.status, `type-settings: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
}

async function get45bAllocatedAt(customerId: number, asOf: string): Promise<number> {
  const res = await apiGet<OverviewDTO>(`/api/budget/${customerId}/overview?date=${asOf}`);
  expect(res.status, `overview: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
  return res.data.entlastungsbetrag45b.totalAllocatedCents;
}

describe("Task #1812 — §45b-Startwert als Reset/Re-Baseline", () => {
  it("Startwert im Juli setzt die Basis zurück → allocated = 131 € (Startwert), NICHT die volle Ansammlung (917 €)", async () => {
    const customerId = await freshCustomer("T1812-reset-baseline");
    await enable45b(customerId);

    // OHNE Startwert: voller Laufzeit-Anker (Anker 1.1. → 7 × 131 € bis Mitte Juli).
    expect(await get45bAllocatedAt(customerId, AS_OF)).toBe(FULL_ACCRUAL);

    // Mittjähriger §45b-Startwert (Juli) — meldet ein Restguthaben von 131 €.
    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
      { amountCents: MONTHLY_45B_CENTS, validFrom: `${YEAR}-0${STARTWERT_MONAT}` },
    );
    expect([200, 201], `initial-balance: ${res.status} ${JSON.stringify(res.data)}`).toContain(res.status);

    // Kern von #1812: allocated ist die NEUE BASIS (131 €), die gesamte
    // Ansammlung <= Juli ist ersetzt.
    expect(await get45bAllocatedAt(customerId, AS_OF)).toBe(EXPECTED_RESET_BASELINE);

    // Rückdatierter Read VOR dem Startwert-Monat: der Reset ist noch nicht
    // wirksam → normale Ansammlung bis dahin (Jan–Jun = 6 × 131 €).
    const preResetAsOf = `${YEAR}-06-15`;
    expect(await get45bAllocatedAt(customerId, preResetAsOf)).toBe(6 * MONTHLY_45B_CENTS);
  }, 60_000);

  // Voller Inzident-Nachbau: früherer Übertrag + mittjähriger Startwert (Reset)
  // + Verbrauch VOR dem Reset (1. Halbjahr) UND im Reset-Monat. Der Verbrauch
  // vor dem Reset ist bereits in der neuen Basis abgebildet und darf NICHT
  // erneut abgezogen werden → keine falsche „über Budget"-Warnung.
  it("Übertrag + Reset-Startwert + Mischverbrauch → Basis = 131 €, Vor-Reset-Verbrauch nicht doppelt abgezogen", async () => {
    const handle: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T1812-full",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: PFLEGEGRAD_SEIT,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
    });
    const { customerId, employeeId } = handle;
    const apptIds: number[] = [];

    async function book(date: string, minutes: number): Promise<number> {
      const [appt] = await db.insert(appointments).values({
        customerId,
        assignedEmployeeId: employeeId,
        appointmentType: "kundentermin",
        date,
        scheduledStart: "10:00:00",
        scheduledEnd: "11:00:00",
        durationPromised: minutes,
        status: "scheduled",
        notes: "T1812 Mischverbrauch",
      }).returning();
      apptIds.push(appt.id);
      const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
      const hwId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
      await db.insert(appointmentServices).values({
        appointmentId: appt.id, serviceId: hwId, plannedDurationMinutes: minutes,
      });
      const tx = await createConsumptionTransaction({
        customerId,
        appointmentId: appt.id,
        transactionDate: date,
        hauswirtschaftMinutes: minutes,
        alltagsbegleitungMinutes: 0,
        travelKilometers: 0,
        customerKilometers: 0,
        userId: employeeId,
      });
      return Math.abs(tx.amountCents);
    }

    try {
      // Vorjahres-Übertrag (Fenster Jan–Jun laufendes Jahr) — vom Reset ersetzt.
      await upsertCarryoverAllocation({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        sourceYear: YEAR - 1,
        amountCents: MONTHLY_45B_CENTS,
      });
      // Mittjähriger §45b-Startwert (Juli) — der Reset-Anker.
      await upsertInitialBalanceAllocation({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: YEAR,
        month: STARTWERT_MONAT,
        amountCents: MONTHLY_45B_CENTS,
        validFrom: `${YEAR}-0${STARTWERT_MONAT}-01`,
        expiresAt: null,
      });

      // Verbrauch im 1. Halbjahr (VOR dem Reset) …
      const h1Consumed = await book(`${YEAR}-02-16`, 60);
      expect(h1Consumed).toBeGreaterThan(0);
      // … und im Juli (im Reset-Monat, gegen die neue Basis).
      const julyConsumed = await book(`${YEAR}-07-10`, 30);
      expect(julyConsumed).toBeGreaterThan(0);

      const res = await apiGet<OverviewDTO>(`/api/budget/${customerId}/overview?date=${AS_OF}`);
      expect(res.status, `overview: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
      const pot = res.data.entlastungsbetrag45b;

      // (1) Kern-Fix #1812: allocated ist die neue Basis (131 €), Übertrag +
      //     Vor-Reset-Ansammlung sind ersetzt.
      expect(pot.totalAllocatedCents).toBe(EXPECTED_RESET_BASELINE);

      // (2) Nur der Reset-Monats-Verbrauch (Juli) zählt gegen den laufenden
      //     Topf; der Vor-Reset-Verbrauch (Februar) ist in der Basis enthalten
      //     und wird NICHT erneut abgezogen → Verfügbar = Basis − Juli-Verbrauch.
      expect(pot.availableCents).toBe(EXPECTED_RESET_BASELINE - julyConsumed);
      expect(pot.availableAfterPlannedCents).toBeGreaterThanOrEqual(0);
      expect(pot.availableCents).toBeGreaterThanOrEqual(0);

      // (3) SSoT: Overview-Verfügbarkeit == Booking-Reader (eine Quelle).
      const overviewAvail = (await getAvailableForDate(customerId, AS_OF)).total45b;
      const bookingAvail = (await computeFifoAvailability(
        customerId, "entlastungsbetrag_45b", AS_OF,
      )).totalAvailable;
      expect(bookingAvail).toBe(overviewAvail);
    } finally {
      for (const id of apptIds.reverse()) {
        try {
          await db.delete(appointmentServices).where(eq(appointmentServices.appointmentId, id));
          await db.delete(appointments).where(eq(appointments.id, id));
        } catch { /* best-effort */ }
      }
      await handle.cleanup();
    }
  }, 90_000);
});
