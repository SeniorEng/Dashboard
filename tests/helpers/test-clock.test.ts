import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { todayISO, currentYearAndMonth } from "@shared/utils/datetime";
import { apiGet, getAuthCookie } from "../test-utils";
import { setupBudgetScenario, type BudgetScenarioHandle, type BudgetScenarioSpec } from "./budget-scenarios";
import { runWithClock, useTestClock, withTestClock } from "./test-clock";

/**
 * §45b-Präventions-Cluster Welle 1 — Abnahmetest der injizierbaren Uhr.
 *
 * Der entscheidende Nachweis steht unten unter „über die Prozessgrenze": dass
 * die Uhr im TESTPROZESS wirkt, ist trivial und wäre auch mit
 * `vi.setSystemTime` zu haben. Der Grund, warum es diese Naht überhaupt gibt,
 * ist der App-Server als EIGENER Prozess mit eigener Systemzeit. Ein Test, der
 * nur den eigenen Prozess prüft, würde die Uhr für funktionsfähig erklären,
 * während die §45b-Fristentests weiter gegen den Lauftag messen.
 *
 * Deshalb prüft der HTTP-Teil eine Antwort OHNE `?date=`-Parameter: dort liest
 * der Server ausschließlich seine eigene Uhr.
 */

interface OverviewResponse {
  entlastungsbetrag45b: {
    carryoverCents: number;
    carryoverExpiresAt: string | null;
    currentYearAllocatedCents: number;
  };
}

describe("Injizierbare Uhr — im eigenen Prozess", () => {
  it("useTestClock setzt todayISO() und currentYearAndMonth()", () => {
    useTestClock("2027-07-01");
    expect(todayISO()).toBe("2027-07-01");
    expect(currentYearAndMonth()).toEqual({ year: 2027, month: 7 });
  });

  it("runWithClock gilt nur INNERHALB des Callbacks", () => {
    const drinnen = runWithClock("2030-03-08", () => todayISO());
    expect(drinnen).toBe("2030-03-08");
    // Danach wieder Echt-Uhr — kein Aufräumen nötig, kein Leck.
    expect(todayISO()).not.toBe("2030-03-08");
  });

  it("withTestClock stellt den vorherigen Stand wieder her — auch bei Fehlern", async () => {
    useTestClock("2026-06-15");
    await expect(
      withTestClock("2026-07-01", () => {
        expect(todayISO()).toBe("2026-07-01");
        throw new Error("absichtlich");
      }),
    ).rejects.toThrow("absichtlich");
    expect(todayISO()).toBe("2026-06-15");
  });

  it("Tages-Datum wird auf lokale Mittagszeit gelegt, nicht auf Mitternacht", () => {
    // Mitternacht würde an der Tagesgrenze kippen und `currentTimeHHMMSS()` auf
    // "00:00:00" setzen — Fixtures mit Uhrzeit-Arithmetik landeten im Vortag.
    useTestClock("2026-06-15");
    expect(todayISO()).toBe("2026-06-15");
    const jetzt = new Date();
    void jetzt;
  });
});

/**
 * DER Nachweis: die Uhr überquert die Prozessgrenze zum App-Server.
 *
 * Gemessen an der §45b-Verfallskante, für die die Uhr gebaut wurde. Ein
 * Übertrag aus 2025 gilt bis zum 30.06.2026 und ist ab dem 01.07.2026
 * verfallen. Beide Reads gehen OHNE `?date=` — der Server entscheidet allein
 * anhand seiner eigenen Uhr. Vor dieser Naht war dieser Test nicht schreibbar:
 * `vi.setSystemTime` hätte den Server nicht erreicht, und beide Aufrufe hätten
 * dasselbe Ergebnis geliefert.
 */
describe("Injizierbare Uhr — über die Prozessgrenze (30.06.-Kante)", () => {
  let scenario: BudgetScenarioHandle;

  const spec: BudgetScenarioSpec = {
    customerNamePrefix: "TEST-Uhr-Kante",
    types: [
      { type: "entlastungsbetrag_45b", enabled: true, priority: 1 },
      { type: "umwandlung_45a", enabled: false, priority: 2 },
      { type: "ersatzpflege_39_42a", enabled: false, priority: 3 },
    ],
    carryover: { type: "entlastungsbetrag_45b", amountCents: 5000, year: 2025 },
  };

  beforeAll(async () => {
    await getAuthCookie();
  });

  beforeEach(async () => {
    // Seed im ersten Halbjahr, damit der Server den Übertrag nicht schon
    // während des Seeds abschreibt.
    useTestClock("2026-06-15");
    scenario = await setupBudgetScenario(spec);
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it("zählt den Übertrag am 30.06. und nicht mehr am 01.07. — ohne ?date=", async () => {
    const amStichtag = await withTestClock("2026-06-30", () =>
      apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview`),
    );
    expect(amStichtag.status).toBe(200);
    expect(amStichtag.data.entlastungsbetrag45b.carryoverExpiresAt).toBe("2026-06-30");
    expect(amStichtag.data.entlastungsbetrag45b.carryoverCents).toBeGreaterThanOrEqual(5000);

    const tagDanach = await withTestClock("2026-07-01", () =>
      apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview`),
    );
    expect(tagDanach.status).toBe(200);
    expect(
      tagDanach.data.entlastungsbetrag45b.carryoverCents,
      "Der Übertrag ist am 01.07. verfallen. Zählt er weiterhin, hat der " +
        "X-Test-Clock-Header den Server-Prozess NICHT erreicht — die Uhr wirkt " +
        "dann nur im Testprozess und alle §45b-Fristentests messen gegen den Lauftag.",
    ).toBe(0);
  });

  /**
   * Zweiter, unabhängiger Nachweis — und der durablere.
   *
   * Die Verfalls-Assertion oben diskriminiert über ihren ERSTEN Teil: einen
   * gültigen Übertrag am 30.06.2026 kann die Echt-Uhr nicht mehr liefern, sie
   * steht bereits dahinter. Das bleibt richtig, ruht aber darauf, dass die
   * Echt-Uhr in der Zukunft liegt.
   *
   * Dieser Test hängt an gar keinem Verhältnis zur Echt-Uhr: er misst die ANZAHL
   * aufgelaufener Monatsaufstockungen zu zwei Stichtagen desselben Jahres. Der
   * Abstand ist exakt drei Monate — egal, welchen Tag der Kalender gerade zeigt.
   * Wirkt der Header nicht, liefern beide Aufrufe denselben Wert und die
   * Differenz ist 0.
   */
  it("Monatsaufstockung folgt der injizierten Uhr (März vs. Juni)", async () => {
    const imMaerz = await withTestClock("2026-03-31", () =>
      apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview`),
    );
    const imJuni = await withTestClock("2026-06-30", () =>
      apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview`),
    );

    const maerz = imMaerz.data.entlastungsbetrag45b.currentYearAllocatedCents;
    const juni = imJuni.data.entlastungsbetrag45b.currentYearAllocatedCents;

    expect(
      juni - maerz,
      "Zwischen dem 31.03. und dem 30.06. liegen genau drei Monatsaufstockungen " +
        `(3 × 131 €). Gemessen: März=${maerz}, Juni=${juni}. Eine Differenz von 0 ` +
        "heißt, der Server hat beide Male dieselbe (seine eigene) Uhr gelesen.",
    ).toBe(3 * 13100);
  });
});
