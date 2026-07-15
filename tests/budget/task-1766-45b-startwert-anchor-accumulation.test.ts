/**
 * Task #1766 — §45b-Allocated-Unterzählung bei Anker VOR einem mittjährigen
 * Startwert.
 *
 * Reproduzierte Fehlsituation: Ein Kunde hat einen §45b-Eligibility-Anker aus
 * der Pflegegrad-Historie (Pflegegrad seit Vorjahr → Anker auf den 1.1. des
 * laufenden Jahres gebodet) UND einen mittjährigen §45b-Startwert
 * (`initial_balance`, z.B. Juli). Der frühere `initialBalanceMonths`-
 * `allocStart`-Shift schob `allocStart` auf den Monat NACH dem Startwert (August)
 * und schnitt damit die komplette davorliegende Monatsansammlung (Jan–Jun) weg
 * → „Gesamt zugewiesen" zeigte nur den einzelnen Startwert-Monat (131 €) statt
 * der vollen Ansammlung (7 × 131 € = 917 €).
 *
 * Fix: Der Shift greift nur noch, wenn der Startwert SELBST die Anker-Herkunft
 * ist (Onboarding ohne frühere Eligibility). Liegt eine frühere Eligibility vor,
 * akkumulieren die Monate davor weiter; die Doppelzählung des Startwert-Monats
 * verhindert unverändert der `initialBalanceSet`-Skip-Set (Startwert-Monat ersetzt
 * die virtuelle Monatsaufstockung dieses Monats — kein Doppelzählen).
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
// Anker Januar, Stichtag Mitte Juli → 7 berechtigte Monate (Jan–Jul).
const EXPECTED_FULL_ACCRUAL = STARTWERT_MONAT * MONTHLY_45B_CENTS;

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
    nachname: `T1766_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

async function get45bAllocated(customerId: number): Promise<number> {
  const res = await apiGet<OverviewDTO>(`/api/budget/${customerId}/overview?date=${AS_OF}`);
  expect(res.status, `overview: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
  return res.data.entlastungsbetrag45b.totalAllocatedCents;
}

describe("Task #1766 — §45b-Ansammlung bei Anker vor mittjährigem Startwert", () => {
  it("Startwert im Juli + Anker aus Pflegegrad-Historie → volle Ansammlung (7 × 131 €), nicht nur der Startwert-Monat", async () => {
    const customerId = await freshCustomer("T1766-anchor-before-startwert");
    await enable45b(customerId);

    // Voller Laufzeit-Anker-Baseline (Anker 1.1. → 7 × 131 € bis Mitte Juli).
    expect(await get45bAllocated(customerId)).toBe(EXPECTED_FULL_ACCRUAL);

    // Mittjähriger §45b-Startwert (Juli, = eine Monatsaufstockung 131 €).
    // Er ersetzt die virtuelle Juli-Aufstockung (Skip-Set), darf aber die
    // davorliegende Ansammlung (Jan–Jun) NICHT wegschneiden.
    const res = await apiPost(
      `/api/budget/${customerId}/initial-balance/entlastungsbetrag_45b`,
      { amountCents: MONTHLY_45B_CENTS, validFrom: `${YEAR}-0${STARTWERT_MONAT}` },
    );
    expect([200, 201], `initial-balance: ${res.status} ${JSON.stringify(res.data)}`).toContain(res.status);

    // Regressions-Kern: allocated bleibt die volle Ansammlung (917 €), NICHT
    // der einzelne Startwert-Monat (131 €).
    expect(await get45bAllocated(customerId)).toBe(EXPECTED_FULL_ACCRUAL);
  }, 60_000);

  // Voller Inzident-Nachbau (der ursprüngliche „702,74 € über Budget"-Fall):
  // frühere Eligibility (Pflegegrad-Anker Vorjahr) + abgelaufener Vorjahres-
  // Übertrag (Fenster Jan–Jun) + mittjähriger Startwert (Juli) + Verbrauch im
  // 1. Halbjahr (gegen den Übertrag) UND im Juli (gegen den laufenden Topf).
  // Vor dem Fix kollabierte allocated auf den einzelnen Startwert-Monat, sodass
  // der (teils gegen den abgelaufenen Übertrag gebuchte) Verbrauch eine falsche
  // „über Budget"-Warnung erzeugte.
  it("voller Szenario-Nachbau: abgelaufener Übertrag + Startwert + Mischverbrauch → volle Ansammlung, KEINE falsche „über Budget\"-Warnung", async () => {
    const handle: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T1766-full",
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
        notes: "T1766 Mischverbrauch",
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
      // Abgelaufener Vorjahres-Übertrag (Fenster Jan–Jun laufendes Jahr).
      await upsertCarryoverAllocation({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        sourceYear: YEAR - 1,
        amountCents: MONTHLY_45B_CENTS,
      });
      // Mittjähriger §45b-Startwert (Juli) — der Auslöser des allocStart-Shifts.
      await upsertInitialBalanceAllocation({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: YEAR,
        month: STARTWERT_MONAT,
        amountCents: MONTHLY_45B_CENTS,
        validFrom: `${YEAR}-0${STARTWERT_MONAT}-01`,
        expiresAt: null,
      });

      // Verbrauch im 1. Halbjahr (FIFO → gegen den Übertrag, priority 0) …
      const h1Consumed = await book(`${YEAR}-02-16`, 60);
      expect(h1Consumed).toBeGreaterThan(0);
      // … und im Juli (gegen den laufenden Jahrestopf).
      const julyConsumed = await book(`${YEAR}-07-10`, 30);
      expect(julyConsumed).toBeGreaterThan(0);

      const res = await apiGet<OverviewDTO>(`/api/budget/${customerId}/overview?date=${AS_OF}`);
      expect(res.status, `overview: ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
      const pot = res.data.entlastungsbetrag45b;

      // (1) Kern-Fix: allocated ist die volle Jahres-Ansammlung (7 × 131 €), der
      //     ab Juli abgelaufene Übertrag ist korrekt NICHT mitgezählt.
      expect(pot.totalAllocatedCents).toBe(EXPECTED_FULL_ACCRUAL);

      // (2) Keine falsche „über Budget"-Warnung: die Planungs-Projektion (das
      //     Client-Gate für „über Budget") bleibt ≥ 0. Vor dem Fix war allocated
      //     nur 131 € → availableAfterPlanned massiv negativ → Falschwarnung.
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
