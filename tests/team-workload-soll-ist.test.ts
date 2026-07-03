import { describe, it, expect } from "vitest";
import {
  computeTeamWorkload,
  REISEPUFFER_HOURS,
  DEFAULT_PER_CLIENT_HOURS,
  type TeamWorkloadInputs,
} from "@shared/domain/team-workload";
import { computeGlobalAvgFromAggregates } from "../server/lib/team-workload";

/**
 * Task #1640 — Regressionsschutz für die EINE SSoT der Kapazitäts-/
 * Auslastungsrechnung (`computeTeamWorkload`). Sie ersetzt die drei zuvor
 * parallel gepflegten Rechner (server `computeSollIst`, client `deriveSollIst`,
 * client `computeWorkloadMetrics`). Beide Anzeige-Consumer UND diese Tests
 * importieren ausschließlich diese Funktion.
 */

function makeInputs(overrides: Partial<TeamWorkloadInputs> = {}): TeamWorkloadInputs {
  return {
    monthlyWorkHours: 100,
    avgProdPerformedHwMinutes: 0,
    avgProdPerformedAllMinutes: 0,
    avgProdHvMinutes: 0,
    avgOverheadMinutes: 0,
    avgSickVacMinutes: 0,
    hvCount: 0,
    v1Count: 0,
    v2Count: 0,
    monthsConsidered: 3,
    ...overrides,
  };
}

describe("computeTeamWorkload", () => {
  it("monthlyWorkHours = null → status 'no-soll', alle Soll-abhängigen Kennzahlen null", () => {
    const m = computeTeamWorkload(makeInputs({ monthlyWorkHours: null }));
    expect(m.status).toBe("no-soll");
    expect(m.sollHours).toBeNull();
    expect(m.pct).toBeNull();
    expect(m.freeHours).toBeNull();
    expect(m.overHours).toBeNull();
    expect(m.addClients).toBeNull();
    expect(m.hasSoll).toBe(false);
    expect(m.isOverloaded).toBe(false);
  });

  it("monthlyWorkHours = 0 → status 'no-soll'", () => {
    const m = computeTeamWorkload(makeInputs({ monthlyWorkHours: 0 }));
    expect(m.status).toBe("no-soll");
    expect(m.pct).toBeNull();
  });

  it("monthsConsidered = 0 (keine Ist-Basis) → status 'no-basis', pct null, freeHours = Soll", () => {
    const m = computeTeamWorkload(makeInputs({ monthsConsidered: 0 }));
    expect(m.status).toBe("no-basis");
    expect(m.sollHours).toBe(100);
    expect(m.pct).toBeNull();
    expect(m.freeHours).toBe(100);
    expect(m.overHours).toBe(0);
    expect(m.addClients).toBeNull();
    expect(m.hasIstBasis).toBe(false);
  });

  it("committed = geleistete produktive Zeit + Overhead; pct = committed / soll", () => {
    // 40h HW + 20h AB + 0 Overhead = 60h committed bei 100h Soll = 60%.
    const m = computeTeamWorkload(
      makeInputs({
        avgProdPerformedHwMinutes: 40 * 60,
        avgProdPerformedAllMinutes: 20 * 60,
        monthlyWorkHours: 100,
      }),
    );
    expect(m.committedHours).toBe(60);
    expect(m.pct).toBe(60);
    expect(m.freeHours).toBe(40);
    expect(m.overHours).toBe(0);
    expect(m.status).toBe("free");
  });

  it("Overhead zählt in die Auslastung (committed = produktiv + overhead)", () => {
    // 50h produktiv + 20h Fahrt/Büro = 70h committed bei 100h Soll = 70%.
    const m = computeTeamWorkload(
      makeInputs({
        avgProdPerformedHwMinutes: 50 * 60,
        avgOverheadMinutes: 20 * 60,
        monthlyWorkHours: 100,
      }),
    );
    expect(m.committedHours).toBe(70);
    expect(m.pct).toBe(70);
  });

  it("Krank/Urlaub reduziert freie Zeit, aber NICHT die Auslastung", () => {
    // 60h committed, 30h Krank/Urlaub, 100h Soll.
    // pct bleibt 60 (nur committed); free = 100 - (60+30) = 10.
    const m = computeTeamWorkload(
      makeInputs({
        avgProdPerformedHwMinutes: 60 * 60,
        avgSickVacMinutes: 30 * 60,
        monthlyWorkHours: 100,
      }),
    );
    expect(m.pct).toBe(60);
    expect(m.usedAllHours).toBe(90);
    expect(m.freeHours).toBe(10);
  });

  it("Überlastung: committed > soll → overHours > 0, freeHours 0, status 'over', addClients 0", () => {
    const m = computeTeamWorkload(
      makeInputs({
        avgProdPerformedHwMinutes: 80 * 60,
        avgProdPerformedAllMinutes: 50 * 60,
        monthlyWorkHours: 100,
      }),
    );
    expect(m.committedHours).toBe(130);
    expect(m.pct).toBe(130);
    expect(m.freeHours).toBe(0);
    expect(m.overHours).toBe(30);
    expect(m.status).toBe("over");
    expect(m.isOverloaded).toBe(true);
    expect(m.addClients).toBe(0);
  });

  it("Kapazität pro Kunde HV-basiert: perClientOwn = prodHV / hvCount, + Reisepuffer", () => {
    // prodHV = 8 Kunden × 4h = 32h; perClientOwn = 4h; perClient = 4 + 1 = 5h.
    // committed 60h, soll 100h → 40h frei → floor(40/5) = 8 mögliche Kunden.
    const m = computeTeamWorkload(
      makeInputs({
        avgProdPerformedHwMinutes: 60 * 60,
        avgProdHvMinutes: 32 * 60,
        hvCount: 8,
        monthlyWorkHours: 100,
      }),
    );
    expect(m.perClientOwnHours).toBe(4);
    expect(m.perClientHours).toBe(4 + REISEPUFFER_HOURS);
    expect(m.perClientOwnIsApprox).toBe(false);
    expect(m.freeHours).toBe(40);
    expect(m.addClients).toBe(8);
  });

  it("ohne HV-Kunden, aber mit geleisteter Zeit → Näherung prodPerformed / totalCustomers", () => {
    // Nur Vertretungen: 4 Kunden (0 HV + 3 V1 + 1 V2), 40h produktiv.
    // perClientOwn = 40 / 4 = 10h (Näherung).
    const m = computeTeamWorkload(
      makeInputs({
        avgProdPerformedHwMinutes: 40 * 60,
        hvCount: 0,
        v1Count: 3,
        v2Count: 1,
        monthlyWorkHours: 200,
      }),
    );
    expect(m.perClientOwnIsApprox).toBe(true);
    expect(m.perClientOwnHours).toBe(10);
  });

  it("weder HV noch geleistete Zeit → Fallback DEFAULT_PER_CLIENT_HOURS", () => {
    const m = computeTeamWorkload(makeInputs({ monthlyWorkHours: 100 }));
    expect(m.perClientOwnHours).toBe(DEFAULT_PER_CLIENT_HOURS);
    expect(m.perClientHours).toBe(DEFAULT_PER_CLIENT_HOURS + REISEPUFFER_HOURS);
  });

  it("status 'limit': freie Stunden vorhanden, reichen aber nicht für einen ganzen Kunden", () => {
    // perClient = 4 + 1 = 5h; nur 3h frei → floor(3/5)=0 → limit.
    const m = computeTeamWorkload(
      makeInputs({
        avgProdPerformedHwMinutes: 97 * 60,
        avgProdHvMinutes: 4 * 60,
        hvCount: 1,
        monthlyWorkHours: 100,
      }),
    );
    expect(m.freeHours).toBe(3);
    expect(m.addClients).toBe(0);
    expect(m.status).toBe("limit");
  });

  it("Minijobber (35h) und SV-pflichtige (160h) identisch gerechnet — nur Soll unterscheidet sich", () => {
    const ist = { avgProdPerformedHwMinutes: 20 * 60, avgProdPerformedAllMinutes: 5 * 60 };
    const minijob = computeTeamWorkload(makeInputs({ ...ist, monthlyWorkHours: 35 }));
    const svPflicht = computeTeamWorkload(makeInputs({ ...ist, monthlyWorkHours: 160 }));
    expect(minijob.committedHours).toBe(svPflicht.committedHours);
    expect(minijob.committedHours).toBe(25);
    expect(minijob.freeHours).toBe(10);
    expect(svPflicht.freeHours).toBe(135);
  });
});

describe("computeGlobalAvgFromAggregates", () => {
  it("liefert 0 wenn keine Kunden-Monate vorhanden sind (keine Datenbasis)", () => {
    expect(computeGlobalAvgFromAggregates(0, 0)).toBe(0);
    expect(computeGlobalAvgFromAggregates(12345, 0)).toBe(0);
  });

  it("teilt Gesamtminuten durch 60 und durch Kunden-Monate", () => {
    expect(computeGlobalAvgFromAggregates(18000, 30)).toBe(10);
  });

  it("rechnet bei einem Kunden über 3 Monate à 7,5h korrekt: 22,5h / 3 Kunden-Monate = 7,5", () => {
    const totalMinutes = 3 * 7.5 * 60;
    expect(computeGlobalAvgFromAggregates(totalMinutes, 3)).toBe(7.5);
  });

  it("liefert 0 bei nicht-finiten Werten (defensive)", () => {
    expect(computeGlobalAvgFromAggregates(Number.NaN, 5)).toBe(0);
    expect(computeGlobalAvgFromAggregates(100, Number.NaN)).toBe(0);
    expect(computeGlobalAvgFromAggregates(Number.POSITIVE_INFINITY, 5)).toBe(0);
  });

  it("ignoriert negative Kunden-Monate (Schutz vor unsauberen Eingaben)", () => {
    expect(computeGlobalAvgFromAggregates(1000, -1)).toBe(0);
  });
});
