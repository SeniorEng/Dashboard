/**
 * Task #424 — Pre-Check und Buchung müssen denselben Stichtag verwenden.
 *
 * Vor #424: `createConsumptionTransaction` prüfte die Verfügbarkeit gegen den
 * heutigen Stichtag, hat aber gegen das Termindatum gebucht. Für rückdatierte
 * oder zukünftige Termine konnten Pre-Check und Buchung deshalb auseinander-
 * laufen — z.B. wenn ein Carryover zwischen "heute" und Termin-Datum verfällt.
 *
 * Diese Regressionstests sichern die Date-Awareness an drei kritischen Stellen
 * ab:
 *   (a) Zukünftiger Termin bei laufendem Verbrauch im aktuellen Monat
 *   (b) Rückdatierter Termin im Vormonat
 *   (c) Carryover-Verfallsgrenze zwischen Pre-Check und Buchung
 *
 * Invariante: `getAvailableForDate(date).totalCents` muss exakt die Obergrenze
 * sein, die `createConsumptionTransaction` bei `transactionDate=date` durchlässt.
 * Cost-Estimate (`/api/budget/:id/cost-estimate?date=…`) liest dieselbe Quelle.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices, budgetAllocations } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { getAvailableForDate } from "../../server/storage/budget/import-availability";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { apiGet, getAuthCookie, runCleanup } from "../test-utils";

beforeAll(async () => { await getAuthCookie(); });
afterAll(async () => { await runCleanup(); });

let hwServiceId: number;

async function loadHwServiceId(): Promise<number> {
  if (hwServiceId) return hwServiceId;
  const res = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
  hwServiceId = res.data.find((s) => s.code === "hauswirtschaft")!.id;
  return hwServiceId;
}

async function makeAppt(customerId: number, employeeId: number, date: string) {
  const [appt] = await db.insert(appointments).values({
    customerId,
    assignedEmployeeId: employeeId,
    appointmentType: "kundentermin",
    date,
    scheduledStart: "10:00:00",
    scheduledEnd: "11:00:00",
    durationPromised: 60,
    status: "scheduled",
    notes: "T424 date-drift",
  }).returning();
  await db.insert(appointmentServices).values({
    appointmentId: appt.id,
    serviceId: await loadHwServiceId(),
    plannedDurationMinutes: 60,
  });
  return appt.id;
}

function weekdayInCurrentMonth(): string {
  const today = new Date();
  for (let offset = 0; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    if (d.getMonth() !== today.getMonth()) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}

function weekdayInPrevMonth(): string {
  const d = new Date();
  d.setDate(15);
  d.setMonth(d.getMonth() - 1);
  // 15. ist immer Mo-Fr oder Sa/So → ggf. korrigieren
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function weekdayInNextMonth(): string {
  const d = new Date();
  d.setDate(15);
  d.setMonth(d.getMonth() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("Task #424 — Date-Drift zwischen Pre-Check und Buchung", () => {
  describe("(a) Zukünftiger Termin mit Vorverbrauch im aktuellen Monat", () => {
    let scenario: BudgetScenarioHandle;

    beforeAll(async () => {
      scenario = await setupBudgetScenario({
        customerNamePrefix: "T424-FUTURE",
        pflegegrad: 2,
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        preferences: { budgetStartDate: "2026-01-01" },
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        initialBalance: {
          type: "entlastungsbetrag_45b",
          amountCents: 100000,
          validFrom: "2026-01-01",
        },
        appointments: [
          {
            date: weekdayInCurrentMonth(),
            scheduledStart: "09:00",
            services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
            document: true,
            notes: "T424 Vorverbrauch heute",
          },
        ],
      });
    });

    afterAll(async () => { await scenario.cleanup(); });

    it("Cost-Estimate für zukünftigen Termin == getAvailableForDate(zukünftig)", async () => {
      const futureDate = weekdayInNextMonth();
      const expected = await getAvailableForDate(scenario.customerId, futureDate);
      const res = await apiGet<any>(
        `/api/budget/${scenario.customerId}/cost-estimate?date=${futureDate}` +
        `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`,
      );
      expect(res.status).toBe(200);
      // Die im UI angezeigte Verfügbarkeit MUSS die date-aware Quelle nutzen.
      expect(res.data.availableCents).toBe(expected.totalCents);
    });

    it("Buchung zum Termindatum nutzt dieselbe Verfügbarkeit (kein Drift)", async () => {
      const futureDate = weekdayInNextMonth();
      const availBefore = (await getAvailableForDate(scenario.customerId, futureDate)).totalCents;
      expect(availBefore).toBeGreaterThan(0);

      const apptId = await makeAppt(scenario.customerId, scenario.employeeId, futureDate);
      const txn = await createConsumptionTransaction({
        customerId: scenario.customerId,
        appointmentId: apptId,
        transactionDate: futureDate,
        hauswirtschaftMinutes: 60,
        alltagsbegleitungMinutes: 0,
        travelKilometers: 0,
        customerKilometers: 0,
        userId: scenario.employeeId,
      });
      expect(txn).toBeDefined();

      // Nach der Buchung muss die date-aware Verfügbarkeit am SELBEN Datum
      // exakt um den gebuchten Betrag gesunken sein.
      const availAfter = (await getAvailableForDate(scenario.customerId, futureDate)).totalCents;
      expect(availAfter).toBe(availBefore - Math.abs(txn.amountCents));
    });
  });

  describe("(b) Rückdatierter Termin im Vormonat", () => {
    let scenario: BudgetScenarioHandle;

    beforeAll(async () => {
      scenario = await setupBudgetScenario({
        customerNamePrefix: "T424-BACKDATED",
        pflegegrad: 2,
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        preferences: { budgetStartDate: "2026-01-01" },
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        initialBalance: {
          type: "entlastungsbetrag_45b",
          amountCents: 100000,
          validFrom: "2026-01-01",
        },
        appointments: [],
      });
    });

    afterAll(async () => { await scenario.cleanup(); });

    it("Pre-Check für Vormonat schließt heutige Buchungen aus dem netConsumed aus", async () => {
      const pastDate = weekdayInPrevMonth();
      const availPastBefore = (await getAvailableForDate(scenario.customerId, pastDate)).totalCents;

      // Eine heutige Buchung darf die Verfügbarkeit für ein VERGANGENES
      // Termindatum nicht beeinflussen (netConsumed ist date-bounded auf
      // `transactionDate <= asOfDate`).
      const todayDate = weekdayInCurrentMonth();
      const todayApptId = await makeAppt(scenario.customerId, scenario.employeeId, todayDate);
      await createConsumptionTransaction({
        customerId: scenario.customerId,
        appointmentId: todayApptId,
        transactionDate: todayDate,
        hauswirtschaftMinutes: 60,
        alltagsbegleitungMinutes: 0,
        travelKilometers: 0,
        customerKilometers: 0,
        userId: scenario.employeeId,
      });

      const availPastAfter = (await getAvailableForDate(scenario.customerId, pastDate)).totalCents;
      expect(availPastAfter).toBe(availPastBefore);
    });

    it("Buchung zum Vormonat nutzt dieselbe Stichtags-Verfügbarkeit wie der Pre-Check", async () => {
      const pastDate = weekdayInPrevMonth();
      const availBefore = (await getAvailableForDate(scenario.customerId, pastDate)).totalCents;

      const apptId = await makeAppt(scenario.customerId, scenario.employeeId, pastDate);
      const txn = await createConsumptionTransaction({
        customerId: scenario.customerId,
        appointmentId: apptId,
        transactionDate: pastDate,
        hauswirtschaftMinutes: 60,
        alltagsbegleitungMinutes: 0,
        travelKilometers: 0,
        customerKilometers: 0,
        userId: scenario.employeeId,
      });
      expect(txn).toBeDefined();

      const availAfter = (await getAvailableForDate(scenario.customerId, pastDate)).totalCents;
      expect(availAfter).toBe(availBefore - Math.abs(txn.amountCents));
    });
  });

  describe("(c) Carryover-Verfallsgrenze zwischen Pre-Check und Buchung", () => {
    let scenario: BudgetScenarioHandle;
    const beforeExpiry = "2026-06-15";  // vor 2026-06-30
    const afterExpiry = "2026-07-15";   // nach 2026-06-30

    beforeAll(async () => {
      // Nur Carryover, kein initial_balance → Carryover wird NICHT durch
      // `!ibYears.has(carryover.year - 1)` herausgefiltert.
      scenario = await setupBudgetScenario({
        customerNamePrefix: "T424-CARRYOVER",
        pflegegrad: 2,
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        preferences: { budgetStartDate: "2026-01-01" },
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        carryover: {
          type: "entlastungsbetrag_45b",
          amountCents: 50000,
          year: 2025,
        },
        appointments: [],
      });

      // `syncCarryoverAndExpiry` läuft beim ersten Allocation-Read und würde
      // alle Carryovers mit `expiresAt < heute` als 'expiry'-Buchung
      // abschreiben. Heute ist > 2026-06-30 → der Carryover wäre weg. Für die
      // Tests stellen wir `expiresAt` deshalb gezielt zurück auf 2026-06-30
      // und löschen ggf. die Auto-Expiry-Buchung, um das Verhalten zu prüfen.
      await db.update(budgetAllocations)
        .set({ expiresAt: "2026-06-30" })
        .where(and(
          eq(budgetAllocations.customerId, scenario.customerId),
          eq(budgetAllocations.source, "carryover"),
        ));
    });

    afterAll(async () => { await scenario.cleanup(); });

    it("Pre-Check VOR Verfall sieht Carryover, Pre-Check NACH Verfall nicht mehr", async () => {
      // Vorab: alle automatischen Expiry-Buchungen entfernen, damit nur die
      // Allocation-Seite gemessen wird.
      await db.execute(sql`
        DELETE FROM budget_transactions
        WHERE customer_id = ${scenario.customerId}
          AND transaction_type = 'write_off'
          AND notes LIKE 'Verfallenes Guthaben%'
      `);

      const availBefore = (await getAvailableForDate(scenario.customerId, beforeExpiry)).total45b;
      const availAfter = (await getAvailableForDate(scenario.customerId, afterExpiry)).total45b;

      // Vor Verfall: Monats-Aufstockungen Jan–Jun + Carryover 50000 ct
      // Nach Verfall: dieselben Monats-Aufstockungen + Juli-Aufstockung, ABER
      // KEIN Carryover mehr.
      // → Differenz muss MINDESTENS die Carryover-Höhe minus eine Monatsrate
      //   sein. (Wir prüfen das robust über "vorher > nachher" plus eine
      //   absolute Untergrenze der Carryover-Beträge.)
      expect(availBefore).toBeGreaterThan(availAfter);
      expect(availBefore - availAfter).toBeGreaterThanOrEqual(50000 - 13100);
    });

    it("Cost-Estimate respektiert das übergebene `?date=` (selbe Quelle wie Buchung)", async () => {
      await db.execute(sql`
        DELETE FROM budget_transactions
        WHERE customer_id = ${scenario.customerId}
          AND transaction_type = 'write_off'
          AND notes LIKE 'Verfallenes Guthaben%'
      `);

      const beforeRes = await apiGet<any>(
        `/api/budget/${scenario.customerId}/cost-estimate?date=${beforeExpiry}` +
        `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`,
      );
      const afterRes = await apiGet<any>(
        `/api/budget/${scenario.customerId}/cost-estimate?date=${afterExpiry}` +
        `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`,
      );

      expect(beforeRes.status).toBe(200);
      expect(afterRes.status).toBe(200);

      // Das per ?date= übergebene Stichtag muss tatsächlich Wirkung haben:
      // Vor Verfall mehr verfügbar als danach.
      expect(beforeRes.data.availableCents).toBeGreaterThan(afterRes.data.availableCents);

      // Und der Cost-Estimate-Wert spiegelt exakt die date-aware Quelle wider,
      // die auch die Buchung benutzt.
      const expBefore = await getAvailableForDate(scenario.customerId, beforeExpiry);
      const expAfter = await getAvailableForDate(scenario.customerId, afterExpiry);
      expect(beforeRes.data.availableCents).toBe(expBefore.totalCents);
      expect(afterRes.data.availableCents).toBe(expAfter.totalCents);
    });
  });
});
