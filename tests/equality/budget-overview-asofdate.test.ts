/**
 * Task #911 — Read-Path-Stichtag für die Budget-Übersicht.
 *
 * NS-1: `GET /:customerId/overview` und `GET /:customerId/summary` akzeptieren
 *       jetzt einen optionalen `?date=`-Query-Param (YYYY-MM-DD, spiegelt die
 *       Konvention von `/cost-estimate`). Fehlt er, gilt heute; ungültige Werte
 *       werden mit 400 abgelehnt. Der Stichtag muss bis in die Topf-Mathematik
 *       durchgereicht werden (date-korrekte Zahlen).
 *
 * NS-4: §45b `monthlyLimitCents` wurde aus einer einzelnen
 *       `typeSettings.find()`-Zeile (for-today) abgeleitet, während die
 *       Allocation-Reduktion phasen-bewusst über das Monatsende rechnet. Lag
 *       der wirksame Limit-Wert in einer Phase, die der Single-Row-Lookup nicht
 *       traf, zeigte die UI `null`, obwohl der Topf real reduziert war.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { apiGet, getAuthCookie, runCleanup } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { todayISO } from "@shared/utils/datetime";

interface OverviewResponse {
  entlastungsbetrag45b: {
    monthlyLimitCents: number | null;
    totalAllocatedCents: number;
    totalUsedCents: number;
    availableCents: number;
    currentYearAllocatedCents: number;
    currentMonthUsedCents: number;
  };
  umwandlung45a: {
    monthlyBudgetCents: number;
    currentMonthAllocatedCents: number;
    currentMonthUsedCents: number;
    currentMonthAvailableCents: number;
    isCurrentlyActive: boolean;
  };
  ersatzpflege39_42a: {
    yearlyBudgetCents: number;
    currentYearAllocatedCents: number;
    currentYearUsedCents: number;
    currentYearAvailableCents: number;
  };
}

interface SummaryResponse {
  monthlyLimitCents: number | null;
}

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

describe("Task #911 — Budget-Overview Stichtag (?date=) + §45b monthlyLimit Phasen-Lookup", () => {
  it("NS-1+NS-4: §45b-Phase nur im Vergangenheits-Monat ⇒ Stichtag-Abfrage zeigt Limit, heute zeigt null", async () => {
    // Fest in der Vergangenheit, damit der Lauf unabhängig vom echten Heute
    // deterministisch ist und der `validFrom <= heute`-Normalpfad (kein
    // Phasen-Append) greift.
    const CONFIGURED_LIMIT_CENTS = 100_00; // < gesetzliches §45b-Maximum (131 €)
    const phaseMonth = "2025-03";
    const phaseValidFrom = `${phaseMonth}-20`;
    const phaseValidTo = `${phaseMonth}-31`;
    const queryDateInPhaseMonth = `${phaseMonth}-05`; // im Monat, VOR validFrom

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T911-ASOF",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      types: [
        {
          type: "entlastungsbetrag_45b",
          priority: 1,
          enabled: true,
          monthlyLimitCents: CONFIGURED_LIMIT_CENTS,
          validFrom: phaseValidFrom,
          validTo: phaseValidTo,
        },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      appointments: [],
    });

    try {
      const [withDate, withoutDate, withToday, summaryWithDate] = await Promise.all([
        apiGet<OverviewResponse>(
          `/api/budget/${scenario.customerId}/overview?date=${queryDateInPhaseMonth}`,
        ),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview`),
        apiGet<OverviewResponse>(
          `/api/budget/${scenario.customerId}/overview?date=${todayISO()}`,
        ),
        apiGet<SummaryResponse>(
          `/api/budget/${scenario.customerId}/summary?date=${queryDateInPhaseMonth}`,
        ),
      ]);

      expect(withDate.status).toBe(200);
      expect(withoutDate.status).toBe(200);
      expect(withToday.status).toBe(200);
      expect(summaryWithDate.status).toBe(200);

      // NS-4: konfigurierter, im Stichtag-Monat wirksamer Limit-Wert erscheint
      // (vor dem Fix: null, weil der for-today-Single-Row-Lookup die Phase nicht traf).
      expect(
        withDate.data.entlastungsbetrag45b.monthlyLimitCents,
        `Overview mit Stichtag ${queryDateInPhaseMonth} muss den konfigurierten ` +
          `§45b-Limit-Wert (${CONFIGURED_LIMIT_CENTS} ct) zeigen, nicht null. ` +
          `Sonst driftet die Anzeige von der phasen-bewussten Allocation-Reduktion.`,
      ).toBe(CONFIGURED_LIMIT_CENTS);

      // Gleiche Erwartung über den /summary-Pfad (mergeServed45b reicht den
      // Legacy-Limit-Wert durch).
      expect(summaryWithDate.data.monthlyLimitCents).toBe(CONFIGURED_LIMIT_CENTS);

      // NS-1: ohne Stichtag (= heute) ist die Phase abgelaufen → null. Beweist,
      // dass der Stichtag bis in die Monats-/Phasen-Auswahl durchgereicht wird.
      expect(
        withoutDate.data.entlastungsbetrag45b.monthlyLimitCents,
        `Ohne Stichtag (= heute) ist die §45b-Phase (${phaseValidFrom}..${phaseValidTo}) ` +
          `abgelaufen → monthlyLimitCents muss null sein.`,
      ).toBeNull();

      // Default == heute: omittierter Param und expliziter Heute-Stichtag liefern
      // denselben Wert.
      expect(withToday.data.entlastungsbetrag45b.monthlyLimitCents).toBe(
        withoutDate.data.entlastungsbetrag45b.monthlyLimitCents,
      );
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("NS-1: §45b-Allocation akkumuliert stichtag-korrekt (früherer Monat im laufenden Jahr ⇒ weniger Topf)", async () => {
    // §45b stockt monatlich auf. Der Runtime-Pfad bodet den Aufstockungs-Anker
    // bewusst aufs laufende Jahr (floorAutoAnchor45bToCurrentYear), daher muss
    // der Drift-Test mit Stichtagen IM laufenden Jahr arbeiten. Ein früherer
    // Monat (Stichtag < heutiger Monat ⇒ Horizont gekappt) MUSS strikt weniger
    // Allocation liefern als heute — beweist, dass der Stichtag bis in
    // `calculateAllocatedCents` (asOfDate-Horizont) UND in
    // `currentYearAllocatedCents` (year+asOfDate) durchgereicht wird. Vor dem
    // Fix wäre für beide Abfragen „heute" gerechnet worden ⇒ identische Werte.
    const now = new Date();
    const cy = now.getFullYear();
    const startDate = `${cy}-01-01`;
    const earlyDate = `${cy}-01-31`; // nur Januar akkumuliert
    const lateDate = todayISO(); // bis zum aktuellen Monat akkumuliert
    // Der Horizont kappt nur, wenn der Stichtag-Monat < aktueller Monat ist.
    // Im Januar (Monat 0) ist kein früherer Monat im laufenden Jahr möglich
    // (Vorjahr ist geboden) → Cross-Monats-Drift dort nicht beobachtbar.
    const canObserveDrift = now.getMonth() >= 1;

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T911-ACCRUAL",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: startDate,
      types: [
        {
          type: "entlastungsbetrag_45b",
          priority: 1,
          enabled: true,
          validFrom: startDate,
        },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      appointments: [],
    });

    try {
      const [early, late] = await Promise.all([
        apiGet<OverviewResponse>(
          `/api/budget/${scenario.customerId}/overview?date=${earlyDate}`,
        ),
        apiGet<OverviewResponse>(
          `/api/budget/${scenario.customerId}/overview?date=${lateDate}`,
        ),
      ]);

      expect(early.status).toBe(200);
      expect(late.status).toBe(200);

      const e = early.data.entlastungsbetrag45b;
      const l = late.data.entlastungsbetrag45b;

      // Ohne Buchungen ist alles akkumulierte Allocation verfügbar.
      expect(e.totalUsedCents).toBe(0);
      expect(l.totalUsedCents).toBe(0);
      expect(e.totalAllocatedCents).toBeGreaterThan(0);
      expect(l.availableCents).toBe(l.totalAllocatedCents);

      if (canObserveDrift) {
        // Kern-Assertion: späterer Stichtag ⇒ strikt mehr Allocation (mehr
        // Monate aufgestockt).
        expect(
          l.totalAllocatedCents,
          `totalAllocatedCents @${lateDate} (${l.totalAllocatedCents}) muss > ` +
            `@${earlyDate} (${e.totalAllocatedCents}) sein — Stichtag wird nicht durchgereicht.`,
        ).toBeGreaterThan(e.totalAllocatedCents);
        expect(l.currentYearAllocatedCents).toBeGreaterThan(e.currentYearAllocatedCents);
        expect(l.availableCents).toBeGreaterThan(e.availableCents);
      }
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("NS-1: §45b-Verbrauch wird stichtag-korrekt gezählt (Buchung erst ab ihrem Buchungsdatum sichtbar) + Default == heute", async () => {
    // Ein dokumentierter Termin bucht eine §45b-Konsumtion mit
    // transactionDate = Termindatum. Liegt der Termin in der nahen Zukunft,
    // darf ein Stichtag VOR dem Termin die Buchung NICHT zählen, ein Stichtag
    // AM Termin schon. Beweist die `transactionDate <= asOfDate`-Filter für
    // `totalUsedCents` UND `currentMonthUsedCents`.
    const now = new Date();
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    // Nächster Werktag (Mo–Fr) ab morgen, bleibt im laufenden Monat sicher
    // (max. wenige Tage in die Zukunft, Cutoff erst am 8. des Folgemonats).
    let apptDate: Date | null = null;
    for (let i = 1; i < 14 && !apptDate; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) apptDate = d;
    }
    const apptIso = fmt(apptDate!);

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T911-USED",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: firstOfMonth,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, validFrom: firstOfMonth },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      appointments: [
        {
          date: apptIso,
          scheduledStart: "09:00:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
        },
      ],
    });

    try {
      const [beforeAppt, atAppt, noDate, explicitToday] = await Promise.all([
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview?date=${todayISO()}`),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview?date=${apptIso}`),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview`),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview?date=${todayISO()}`),
      ]);

      expect(beforeAppt.status).toBe(200);
      expect(atAppt.status).toBe(200);

      const before = beforeAppt.data.entlastungsbetrag45b;
      const at = atAppt.data.entlastungsbetrag45b;

      // Vor dem Buchungsdatum ist die Konsumtion unsichtbar.
      expect(
        before.totalUsedCents,
        `Stichtag heute (${todayISO()}) < Termindatum (${apptIso}) ⇒ Konsumtion darf ` +
          `noch nicht in totalUsedCents zählen.`,
      ).toBe(0);
      expect(before.currentMonthUsedCents).toBe(0);

      // Am Buchungsdatum zählt sie.
      expect(at.totalUsedCents).toBeGreaterThan(0);
      expect(at.currentMonthUsedCents).toBeGreaterThan(0);

      // Default (kein Param) == expliziter Heute-Stichtag, über alle Kernfelder.
      const n = noDate.data.entlastungsbetrag45b;
      const t = explicitToday.data.entlastungsbetrag45b;
      expect(n.totalAllocatedCents).toBe(t.totalAllocatedCents);
      expect(n.totalUsedCents).toBe(t.totalUsedCents);
      expect(n.availableCents).toBe(t.availableCents);
      expect(n.currentMonthUsedCents).toBe(t.currentMonthUsedCents);
      expect(n.currentYearAllocatedCents).toBe(t.currentYearAllocatedCents);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("NS-1: §45a-Verbrauch & -Allocation sind monats-stichtag-korrekt (Verbrauchsmonat vs. anderer Monat) + Default == heute", async () => {
    // §45a ist ein MONATS-Topf. Sowohl die Allocation (calculateAllocated45a)
    // als auch der Verbrauch (computeCapSlot → getMonthRange) hängen am Monat
    // des Stichtags. Ein dokumentierter Termin bucht §45a-Konsumtion mit
    // transactionDate = Termindatum. Eine Stichtag-Abfrage IM Termin-Monat muss
    // den Verbrauch zeigen, eine Abfrage in einem ANDEREN (früheren) Monat des
    // laufenden Jahres NICHT — beweist, dass der Stichtag bis in die
    // Monats-Fenster-Wahl von Allocation UND Verbrauch durchgereicht wird. Vor
    // dem #911-Threading hätte für beide Abfragen „heute" gerechnet ⇒ identische
    // Zahlen.
    const now = new Date();
    const cy = now.getFullYear();
    const startDate = `${cy}-01-01`;
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    // Nächster Werktag (Mo–Fr) ab morgen.
    let apptDate: Date | null = null;
    for (let i = 1; i < 14 && !apptDate; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) apptDate = d;
    }
    const apptIso = fmt(apptDate!);
    const apptInCurrentMonth =
      apptDate!.getFullYear() === cy && apptDate!.getMonth() === now.getMonth();
    // Ein früherer Monat im laufenden Jahr (innerhalb des §45a-Fensters
    // Jan..heute) existiert nur ab Februar. Im Januar gibt es keinen früheren
    // Monat im laufenden Jahr → Cross-Monats-Drift dort nicht beobachtbar.
    const canObservePastMonth = now.getMonth() >= 1;
    const pastMonthDate = `${cy}-${String(now.getMonth()).padStart(2, "0")}-15`; // Vormonat (1-based = getMonth())

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T916-45A",
      pflegegrad: 3, // §45a erst ab Pflegegrad 2 (Task #722)
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: startDate,
      types: [
        { type: "entlastungsbetrag_45b", priority: 2, enabled: false },
        { type: "umwandlung_45a", priority: 1, enabled: true, validFrom: startDate },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      appointments: [
        {
          date: apptIso,
          scheduledStart: "09:00:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
        },
      ],
    });

    try {
      const [usedMonth, pastMonth, noDate, explicitToday] = await Promise.all([
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview?date=${apptIso}`),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview?date=${pastMonthDate}`),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview`),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview?date=${todayISO()}`),
      ]);

      expect(usedMonth.status).toBe(200);
      expect(pastMonth.status).toBe(200);

      const at = usedMonth.data.umwandlung45a;

      // Im Termin-Monat zählt die §45a-Konsumtion (Monatsfenster, NICHT durch
      // „heute" gedeckelt — die Buchung im selben Monat ist sichtbar).
      if (apptInCurrentMonth) {
        expect(
          at.currentMonthUsedCents,
          `Stichtag im Termin-Monat (${apptIso}) muss die §45a-Konsumtion zeigen.`,
        ).toBeGreaterThan(0);
        expect(at.currentMonthAllocatedCents).toBeGreaterThan(0);
      }

      if (canObservePastMonth) {
        const past = pastMonth.data.umwandlung45a;
        // Anderer (früherer) Monat im Fenster: Allocation vorhanden, aber KEIN
        // Verbrauch — der Termin liegt nicht in diesem Monatsfenster.
        expect(
          past.currentMonthUsedCents,
          `Stichtag in einem anderen Monat (${pastMonthDate}) darf die §45a-Konsumtion ` +
            `aus ${apptIso} NICHT zählen (Monatsfenster wird stichtag-korrekt gewählt).`,
        ).toBe(0);
        expect(
          past.currentMonthAllocatedCents,
          `Der frühere Monat liegt im §45a-Fenster (ab ${startDate}) → Allocation > 0.`,
        ).toBeGreaterThan(0);
        if (apptInCurrentMonth) {
          // Verfügbarkeit driftet zwischen den Monaten: ohne Verbrauch mehr frei.
          expect(past.currentMonthAvailableCents).toBeGreaterThan(
            at.currentMonthAvailableCents,
          );
        }
      }

      // Default (kein Param) == expliziter Heute-Stichtag über alle §45a-Felder.
      const n = noDate.data.umwandlung45a;
      const t = explicitToday.data.umwandlung45a;
      expect(n.monthlyBudgetCents).toBe(t.monthlyBudgetCents);
      expect(n.currentMonthAllocatedCents).toBe(t.currentMonthAllocatedCents);
      expect(n.currentMonthUsedCents).toBe(t.currentMonthUsedCents);
      expect(n.currentMonthAvailableCents).toBe(t.currentMonthAvailableCents);
      expect(n.isCurrentlyActive).toBe(t.isCurrentlyActive);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("NS-1: §39/§42a-Verbrauch ist jahres-stichtag-korrekt (Verbrauchsjahr vs. anderes Jahr) + Default == heute", async () => {
    // §39/§42a ist ein JAHRES-Topf. `currentYear` wird aus dem Stichtag
    // abgeleitet und sowohl in die Allocation (calculateAllocated39_42a {year})
    // als auch in das Verbrauchs-Fenster (computeCapSlot → getYearRange)
    // durchgereicht. Eine Year-Boundary-Regression (z.B. hartcodiertes
    // heutiges Jahr) bliebe ohne diesen Test unentdeckt: Ein dokumentierter
    // Termin im laufenden Jahr darf nur bei einer Stichtag-Abfrage in DIESEM
    // Jahr als Verbrauch zählen, nicht bei einer Abfrage in einem anderen Jahr.
    const now = new Date();
    const cy = now.getFullYear();
    const startDate = `${cy - 1}-01-01`; // Fenster deckt Vorjahr UND laufendes Jahr
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    // Nächster Werktag (Mo–Fr) ab morgen.
    let apptDate: Date | null = null;
    for (let i = 1; i < 14 && !apptDate; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) apptDate = d;
    }
    const apptIso = fmt(apptDate!);
    // Der Termin muss im laufenden Jahr liegen, damit er gegen §39 (endYear =
    // heutiges Jahr) Kapazität hat und in das laufende Jahr fällt. Das ist nur
    // an einem Jahreswechsel (Ende Dezember) potenziell verletzt.
    const apptInCurrentYear = apptDate!.getFullYear() === cy;
    const currentYearDate = `${cy}-06-15`;
    const otherYearDate = `${cy - 1}-06-15`;

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T916-39",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: startDate,
      types: [
        { type: "entlastungsbetrag_45b", priority: 2, enabled: false },
        { type: "umwandlung_45a", priority: 3, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 1, enabled: true, validFrom: startDate },
      ],
      appointments: [
        {
          date: apptIso,
          scheduledStart: "09:00:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
        },
      ],
    });

    try {
      const [currentYear, otherYear, noDate, explicitToday] = await Promise.all([
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview?date=${currentYearDate}`),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview?date=${otherYearDate}`),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview`),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview?date=${todayISO()}`),
      ]);

      expect(currentYear.status).toBe(200);
      expect(otherYear.status).toBe(200);

      const thisYear = currentYear.data.ersatzpflege39_42a;
      const lastYear = otherYear.data.ersatzpflege39_42a;

      // Beide Jahre liegen im Fenster (ab Vorjahr) → Allocation in beiden Jahren
      // vorhanden und identisch (gesetzlicher Jahresbetrag).
      expect(thisYear.currentYearAllocatedCents).toBeGreaterThan(0);
      expect(lastYear.currentYearAllocatedCents).toBeGreaterThan(0);
      expect(thisYear.currentYearAllocatedCents).toBe(lastYear.currentYearAllocatedCents);

      // Kern-Assertion (Year-Boundary): der Termin im laufenden Jahr zählt NUR
      // bei der Stichtag-Abfrage im laufenden Jahr — nicht im Vorjahr.
      expect(
        lastYear.currentYearUsedCents,
        `Stichtag im Vorjahr (${otherYearDate}) darf den §39/§42a-Verbrauch aus ` +
          `${apptIso} NICHT zählen (Jahres-Fenster wird stichtag-korrekt gewählt).`,
      ).toBe(0);
      expect(lastYear.currentYearAvailableCents).toBe(
        lastYear.currentYearAllocatedCents,
      );

      if (apptInCurrentYear) {
        expect(
          thisYear.currentYearUsedCents,
          `Stichtag im laufenden Jahr (${currentYearDate}) muss den §39/§42a-Verbrauch ` +
            `aus ${apptIso} zählen.`,
        ).toBeGreaterThan(0);
        expect(thisYear.currentYearAvailableCents).toBeLessThan(
          lastYear.currentYearAvailableCents,
        );
      }

      // Default (kein Param) == expliziter Heute-Stichtag über alle §39-Felder.
      const n = noDate.data.ersatzpflege39_42a;
      const t = explicitToday.data.ersatzpflege39_42a;
      expect(n.yearlyBudgetCents).toBe(t.yearlyBudgetCents);
      expect(n.currentYearAllocatedCents).toBe(t.currentYearAllocatedCents);
      expect(n.currentYearUsedCents).toBe(t.currentYearUsedCents);
      expect(n.currentYearAvailableCents).toBe(t.currentYearAvailableCents);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("NS-1: ?date= wird validiert (400 bei Müll/ungültigem Kalenderdatum, 200 bei gültig/leer)", async () => {
    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T911-VALID",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      appointments: [],
    });

    try {
      const cid = scenario.customerId;
      const [
        overviewGarbage,
        overviewBadCalendar,
        overviewValid,
        overviewEmpty,
        summaryGarbage,
      ] = await Promise.all([
        apiGet(`/api/budget/${cid}/overview?date=not-a-date`),
        apiGet(`/api/budget/${cid}/overview?date=2025-02-30`),
        apiGet(`/api/budget/${cid}/overview?date=2025-03-05`),
        apiGet(`/api/budget/${cid}/overview?date=`),
        apiGet(`/api/budget/${cid}/summary?date=13-37-2025`),
      ]);

      expect(overviewGarbage.status).toBe(400);
      expect(overviewBadCalendar.status).toBe(400);
      expect(overviewValid.status).toBe(200);
      expect(overviewEmpty.status).toBe(200);
      expect(summaryGarbage.status).toBe(400);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
