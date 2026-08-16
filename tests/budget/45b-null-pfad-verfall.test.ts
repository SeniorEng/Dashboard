import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiGet, getAuthCookie, runCleanup } from "../test-utils";
import { netAvailable45bAt } from "../../server/storage/budget/net-available-45b";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { assertTestClockActive, useTestClock, withTestClock } from "../helpers/test-clock";
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";

/**
 * Task #1927 — §45b-NULL-Pfad-Verfall: Verbrauch gegen die virtuelle
 * Monatsaufstockung muss aus dem Abzug fallen, sobald seine Monate aus
 * `Allocated` fallen.
 *
 * ── Der Defekt ──────────────────────────────────────────────────────────
 * Die FIFO-Buchung (`consumption-engine.ts`) verbraucht zuerst die
 * Spezial-Allocations (Übertrag, Startwert), jede mit ihrer `allocation_id`.
 * Was danach übrig bleibt, wird als EINE Zeile mit `allocation_id = NULL`
 * gebucht — das Monatsaufstockungs-Leg. Es hat keine materialisierte Zeile, auf
 * die es zeigen könnte.
 *
 * `getExcluded45bConsumption` schloss Verbrauch bis dahin ausschließlich über
 * `inArray(allocationId, excludedIds)` aus. Diese Bedingung trifft `NULL` per
 * SQL-Semantik NIE. Wandert der Verfalls-Boden zum 01.07. auf das laufende
 * Jahr, fallen die Aufstockungen des Vorjahres aus `Allocated` — ihr Verbrauch
 * blieb aber abgezogen und belastete den neuen Topf dauerhaft.
 *
 * ── Warum das vorher nicht prüfbar war ──────────────────────────────────
 * Der Defekt zeigt sich NUR an der Jahres-/Halbjahresgrenze. Ohne bewegliche
 * Uhr hätte dieser Test auf den 01.07. warten müssen; der App-Server ist ein
 * eigener Prozess und las bis Welle 1 (#97) ausschließlich seine Systemzeit.
 * `withTestClock` stellt Testprozess UND Server — deshalb ist Welle 2 auf
 * Welle 1 aufgebaut.
 */

interface OverviewResponse {
  entlastungsbetrag45b: {
    totalAllocatedCents: number;
    totalUsedCents: number;
    availableCents: number;
  };
}

/** Stichtag im Vorjahr, an dem der Verbrauch gebucht wird (Montag). */
const VERBRAUCHS_TAG = "2026-06-15";
/** Letzter Tag, an dem die 2026er Aufstockungen noch zum Topf beitragen. */
const VOR_DER_KANTE = "2027-06-30";
/** Erster Tag, an dem der Boden auf 2027 springt und 2026 herausfällt. */
const NACH_DER_KANTE = "2027-07-01";

const MONATLICH = BUDGET_45B_MAX_MONTHLY_CENTS;

describe("Task #1927 — NULL-verlinkter Verbrauch verfällt mit seinen Monaten", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    await getAuthCookie();
  });

  beforeEach(async () => {
    // `beforeEach`, nicht `beforeAll`: `tests/setup.ts#afterEach` stellt nach
    // JEDEM Test die Echt-Uhr her (Gate-2-Fund S1 aus Welle 1).
    useTestClock(VERBRAUCHS_TAG);
    assertTestClockActive();

    // Bewusst OHNE Übertrag und OHNE Startwert: dann gibt es keine
    // Spezial-Allocation, gegen die FIFO buchen könnte, und der GESAMTE
    // Verbrauch landet im NULL-Leg — genau dem Pfad, den dieser Test prüft.
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T1927-NULLPFAD",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: "2026-01-01",
      types: [
        { type: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
        { type: "umwandlung_45a", enabled: false, priority: 2 },
        { type: "ersatzpflege_39_42a", enabled: false, priority: 3 },
      ],
      appointments: [
        {
          date: VERBRAUCHS_TAG,
          scheduledStart: "09:00:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
        },
      ],
    });
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it("belastet den Topf von 2027 nicht mehr mit dem Verbrauch aus 2026", async () => {
    const vorher = await withTestClock(VOR_DER_KANTE, () =>
      apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview`),
    );
    const nachher = await withTestClock(NACH_DER_KANTE, () =>
      apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview`),
    );
    expect(vorher.status).toBe(200);
    expect(nachher.status).toBe(200);

    const v = vorher.data.entlastungsbetrag45b;
    const n = nachher.data.entlastungsbetrag45b;

    // Vorbedingung: am 30.06.2027 ist der Verbrauch aus 2026 noch abgezogen —
    // seine Monate tragen bis dahin bei. Ohne diese Zusage misst der Test unten
    // nichts (er könnte auch grün sein, weil gar kein Verbrauch existiert).
    expect(
      v.totalUsedCents,
      "Am 30.06.2027 muss der Verbrauch aus 2026 noch zählen — sonst ist die " +
        "Fixture kaputt und die Aussage unten wertlos.",
    ).toBeGreaterThan(0);

    // Die Kante selbst: am 01.07.2027 ist der Boden auf 2027 gesprungen, die
    // 2026er Aufstockungen sind aus `Allocated` gefallen. Ihr Verbrauch MUSS
    // symmetrisch mitfallen — die VERFÜGBARKEIT ist damit die ungeschmälerte
    // Aufstockung Jan–Jul 2027.
    //
    // Geprüft wird `availableCents`, nicht `totalUsedCents`: letzteres ist die
    // Roh-Verbrauchssumme der Karte und kennt die symmetrische Exklusion
    // bewusst nicht (sie sitzt im Verfügbarkeits-Reader). Wer hier
    // `totalUsedCents` prüft, misst am Fix vorbei.
    expect(
      n.availableCents,
      "Der Verbrauch aus 2026 schmälert den Topf von 2027 weiter. Genau das ist " +
        "der NULL-Pfad-Defekt: `inArray(allocationId, …)` trifft die " +
        "NULL-verlinkte Aufstockungs-Zeile nicht, deshalb fiel sie nie aus dem " +
        "Abzug, obwohl ihre Monate aus `Allocated` verschwunden sind.",
    ).toBe(7 * MONATLICH);
  });

  /**
   * Symmetrie-Invariante über einen Stichtags-Sweep.
   *
   * ── Warum das UNGEFLOORT gemessen wird (Gate-2-Funde S2/S3) ─────────────
   * Die erste Fassung prüfte über die API `availableCents >= 0` und
   * `totalUsedCents <= totalAllocatedCents`. Beides war wertlos:
   *
   *  - `availableCents` ist `Math.max(0, …)` (`computeNetAvailable45b`) und kann
   *    konstruktionsbedingt nie negativ werden — die Assertion konnte gar nicht
   *    fehlschlagen.
   *  - `totalUsedCents` ist die ROHE Verbrauchssumme der Karte; sie kennt die
   *    symmetrische Exklusion bewusst nicht. Nach genau diesem Fix DARF sie die
   *    Zuteilung übersteigen (`BudgetLedgerSection` rechnet damit als
   *    `expiredUsedCents`). Die Assertion hätte ab ~25 Terminen in 2026 einen
   *    Phantom-Regress gemeldet — bei völlig korrektem Code.
   *
   * Tragfähig ist nur die ungefloorte Beziehung aus dem Verfügbarkeits-Reader:
   * der Verbrauch, der NACH der Exklusion noch zählt, darf die Zuteilung nie
   * übersteigen. Ein Verbrauch, dessen Topf verschwunden ist, bräche das sofort.
   * Deshalb hier in-process gegen `netAvailable45bAt` statt über die API.
   */
  it("Symmetrie hält über die Stichtage hinweg (Sweep über zwei Jahreskanten)", async () => {
    const stichtage = [
      "2026-06-30", "2026-07-01", "2026-12-31",
      "2027-01-01", "2027-06-30", "2027-07-01", "2027-12-31",
    ];

    for (const tag of stichtage) {
      const r = await netAvailable45bAt(scenario.customerId, tag, { projectFuture: true });
      // `rawConsumedNetCents`, NICHT `consumedNetCents`: letzteres ist bereits
      // `max(0, raw − excluded)` und würde eine Über-Exklusion wieder verstecken
      // — dieselbe Floor-Falle wie bei `availableCents`.
      const gezaehlterVerbrauch = r.rawConsumedNetCents - r.excludedConsumedNetCents;

      expect(
        gezaehlterVerbrauch,
        `Stichtag ${tag}: nach der Exklusion bleibt mehr Verbrauch stehen ` +
          `(${gezaehlterVerbrauch}) als überhaupt zugeteilt ist (${r.allocatedCents}). ` +
          "Genau die Asymmetrie, die der NULL-Pfad erzeugte: Monate fallen aus " +
          "`Allocated`, ihr Verbrauch bleibt abgezogen.",
      ).toBeLessThanOrEqual(r.allocatedCents);

      expect(
        r.excludedConsumedNetCents,
        `Stichtag ${tag}: mehr Verbrauch exkludiert als überhaupt gebucht wurde — ` +
          "Über-Exklusion würde die Verfügbarkeit fälschlich anheben.",
      ).toBeLessThanOrEqual(r.rawConsumedNetCents);
    }
  });
});

afterEach(async () => {
  await runCleanup();
});
