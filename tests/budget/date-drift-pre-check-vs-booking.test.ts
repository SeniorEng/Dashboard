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
import { appointments, appointmentServices, budgetAllocations, budgetTransactions } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { getAvailableForDate } from "../../server/storage/budget/import-availability";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { apiGet, getAuthCookie, runCleanup } from "../test-utils";
import {
  billingReferenceMonth,
  carryoverAnchor,
  pastWeekdayInBillingMonth,
  snapToWeekday,
} from "../helpers/billing-month";

beforeAll(async () => { await getAuthCookie(); });
afterAll(async () => { await runCleanup(); });

/** Kalenderjahr des Abrechnungs-Ankers — ERSETZT die hartkodierte `2026`. */
const ANCHOR_YEAR = billingReferenceMonth().year;
/** Jahresanfang des Ankerjahrs (Pflegegrad-Beginn / Startwert-`validFrom`). */
const ANCHOR_YEAR_START = `${ANCHOR_YEAR}-01-01`;

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

/**
 * Der 15. des Monats mit `monthOffset` Abstand zum Abrechnungs-Anker, auf einen
 * Werktag gezogen.
 *
 * ERSETZT die beiden lokalen `weekdayInPrevMonth`/`weekdayInNextMonth`-Kopien
 * mit ihren eigenen Wochenend-Schleifen. Die trugen zwei Fehler:
 *  - `new Date()` behielt die aktuelle UHRZEIT, `toISOString()` rechnete danach
 *    nach UTC um. In der Nacht (lokal 00:00–02:00 MESZ) fiel das ISO-Datum damit
 *    auf den VORTAG zurück — die Wochenend-Korrektur hatte aber gegen den
 *    lokalen Tag gerechnet, sodass am Ende doch ein Samstag/Sonntag heraus-
 *    kommen konnte. Die Termin-Anlage lehnt Wochenenden mit 400 ab.
 *  - Der Bezugspunkt war „heute" statt des Abrechnungs-Ankers, sodass Termin
 *    und Abrechnungsmonat am Monatsanfang auseinanderlaufen konnten.
 *
 * `snapToWeekday` (aus #50) rechnet rein auf lokalen Kalenderdaten und ist damit
 * zeitzonen-neutral. Richtung bewusst gegenläufig: der Vormonats-Termin wird
 * rückwärts gezogen, der Folgemonats-Termin vorwärts — beide bleiben so sicher
 * im gemeinten Monat.
 */
function weekdayNearMonthMiddle(monthOffset: number): string {
  const ref = billingReferenceMonth().reference;
  const target = new Date(ref.getFullYear(), ref.getMonth() + monthOffset, 15);
  const iso = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-15`;
  return snapToWeekday(iso, monthOffset < 0 ? "backward" : "forward");
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
        pflegegradSeit: ANCHOR_YEAR_START,
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        initialBalance: {
          // Task #959 — §45b-Startwert ≤ Obergrenze: Pflegegrad-Beginn = Startmonat
          // → genau 1 berechtigter Monat = 131 €. Das laufende §45b-Budget kommt
          // ohnehin aus der Monats-Akkumulation.
          type: "entlastungsbetrag_45b",
          amountCents: 13_100,
          validFrom: ANCHOR_YEAR_START,
        },
        appointments: [
          {
            date: pastWeekdayInBillingMonth(),
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
      const futureDate = weekdayNearMonthMiddle(+1);
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
      const futureDate = weekdayNearMonthMiddle(+1);
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
        pflegegradSeit: ANCHOR_YEAR_START,
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        initialBalance: {
          // Task #959 — §45b-Startwert ≤ Obergrenze (1 berechtigter Monat = 131 €).
          type: "entlastungsbetrag_45b",
          amountCents: 13_100,
          validFrom: ANCHOR_YEAR_START,
        },
        appointments: [],
      });
    });

    afterAll(async () => { await scenario.cleanup(); });

    it("Pre-Check für Vormonat schließt heutige Buchungen aus dem netConsumed aus", async () => {
      const pastDate = weekdayNearMonthMiddle(-1);
      const availPastBefore = (await getAvailableForDate(scenario.customerId, pastDate)).totalCents;

      // Eine heutige Buchung darf die Verfügbarkeit für ein VERGANGENES
      // Termindatum nicht beeinflussen (netConsumed ist date-bounded auf
      // `transactionDate <= asOfDate`).
      const todayDate = pastWeekdayInBillingMonth();
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
      const pastDate = weekdayNearMonthMiddle(-1);
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

    // §45b-Übertrag kalender-relativ verankern (Helfer aus #51). Die FRIST bleibt
    // unangetastet — `expiresAt` ist weiterhin exakt der 30.06. des Zieljahres,
    // nur nicht mehr als Literal `2026-06-30`.
    const { sourceYear, targetYear, expiresAt } = carryoverAnchor();
    const CARRYOVER_CENTS = 50_000;
    const MONTHLY_45B_CENTS = 13_100;
    // Die beiden Stichtage liegen bewusst GENAU EINEN Monat auseinander und
    // klammern den 30.06. ein. Nur dadurch trennt sie höchstens EINE
    // Monatsaufstockung — die Untergrenze unten (`Übertrag − 1 Monatsrate`)
    // rechnet exakt damit. Ein Stichtag „irgendwo im H1" (z.B. `anchor.asOf`)
    // wäre je nach Lauftag mehrere Monatsraten entfernt und würde die
    // Untergrenze verwässern.
    const beforeExpiry = `${targetYear}-06-15`;  // vor dem 30.06.
    const afterExpiry = `${targetYear}-07-15`;   // nach dem 30.06.

    beforeAll(async () => {
      // Nur Carryover, kein initial_balance → Carryover wird NICHT durch
      // `!ibYears.has(carryover.year - 1)` herausgefiltert.
      scenario = await setupBudgetScenario({
        customerNamePrefix: "T424-CARRYOVER",
        pflegegrad: 2,
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        pflegegradSeit: `${targetYear}-01-01`,
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        carryover: {
          type: "entlastungsbetrag_45b",
          amountCents: CARRYOVER_CENTS,
          year: sourceYear,
        },
        appointments: [],
      });
    });

    afterAll(async () => { await scenario.cleanup(); });

    it("Der geseedete Übertrag verfällt exakt zum 30.06. des Zieljahres", async () => {
      // ERSETZT das frühere `UPDATE budget_allocations SET expires_at =
      // '2026-06-30'` im Setup. Das war ein hartkodiertes Zurechtbiegen der
      // Frist — und ab dem Folgejahr ein aktiver Fehler, weil es einen Übertrag
      // des Zieljahres Y auf die Frist des Jahres 2026 gezogen hätte. Die Frist
      // kommt aus der Produktivlogik (`carryoverWindowFor`); der Test PRÜFT sie
      // jetzt, statt sie zu setzen.
      const rows = await db.select()
        .from(budgetAllocations)
        .where(and(
          eq(budgetAllocations.customerId, scenario.customerId),
          eq(budgetAllocations.source, "carryover"),
        ));
      expect(rows).toHaveLength(1);
      expect(rows[0].expiresAt).toBe(expiresAt);
      expect(expiresAt).toBe(`${targetYear}-06-30`);
      expect(rows[0].amountCents).toBe(CARRYOVER_CENTS);
    });

    it("Pre-Check VOR Verfall sieht Carryover, Pre-Check NACH Verfall nicht mehr", async () => {
      const availBefore = (await getAvailableForDate(scenario.customerId, beforeExpiry)).total45b;
      const availAfter = (await getAvailableForDate(scenario.customerId, afterExpiry)).total45b;

      // Vor Verfall: Monats-Aufstockungen + Carryover
      // Nach Verfall: dieselben Monats-Aufstockungen (+ höchstens die Juli-
      // Aufstockung), ABER KEIN Carryover mehr.
      // → Differenz muss MINDESTENS die Carryover-Höhe minus eine Monatsrate
      //   sein. (Wir prüfen das robust über "vorher > nachher" plus eine
      //   absolute Untergrenze der Carryover-Beträge.)
      expect(availBefore).toBeGreaterThan(availAfter);
      expect(availBefore - availAfter).toBeGreaterThanOrEqual(CARRYOVER_CENTS - MONTHLY_45B_CENTS);
    });

    it("Die Verfalls-Abschreibung belastet den laufenden Topf NICHT zusätzlich", async () => {
      // ERSETZT das frühere `DELETE FROM budget_transactions … write_off` in den
      // beiden Tests unten. Das war ein Hard-Delete auf dem append-only
      // Finanz-Ledger und lief seit der GoBD-Sperre
      // (`budget_transactions_prevent_delete`) in eine Exception.
      //
      // Es war auch fachlich überholt: Seit #1306/#1340 rechnet
      // `getExcluded45bConsumption` den Verbrauch gegen eine aus `Allocated`
      // herausgefallene Allocation SYMMETRISCH heraus. Die auf den 01.07.
      // datierte Verfalls-Buchung darf den laufenden Topf also gar nicht mehr
      // belasten — genau das prüfen wir hier, statt die Zeile wegzuräumen.
      const afterSum = (await getAvailableForDate(scenario.customerId, afterExpiry)).total45b;

      const writeOffs = await db.select()
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.customerId, scenario.customerId),
          eq(budgetTransactions.transactionType, "write_off"),
        ));

      // Der Verfall wird erst materialisiert, wenn die Frist real abgelaufen ist
      // (`processExpiredCarryover` liest `todayISO()`). Läuft der Test im H1,
      // gibt es noch keine Zeile — dann ist nichts zu entlasten.
      if (writeOffs.length > 0) {
        expect(writeOffs).toHaveLength(1);
        expect(writeOffs[0].amountCents).toBe(-CARRYOVER_CENTS);
        // Die Zeile liegt im Fenster (`transactionDate <= afterExpiry`) und
        // würde ohne die symmetrische Exklusion ein zweites Mal abgezogen.
        expect(writeOffs[0].transactionDate <= afterExpiry).toBe(true);
      }

      // Kern-Assertion: Der Übertrag ist GENAU EINMAL weg — die Verfügbarkeit
      // nach dem Verfall besteht nur noch aus den Monats-Aufstockungen, ohne
      // einen zweiten Abzug in Höhe des Übertrags.
      expect(afterSum).toBeGreaterThanOrEqual(0);
      expect(afterSum % MONTHLY_45B_CENTS).toBe(0);
    });

    it("Cost-Estimate respektiert das übergebene `?date=` (selbe Quelle wie Buchung)", async () => {
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
