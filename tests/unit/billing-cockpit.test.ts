import { describe, it, expect } from "vitest";
import {
  COCKPIT_FUNNEL_STAGES,
  mapPipelineStageToFunnel,
  summarizeCockpitFunnel,
  groupCockpitRows,
  summarizeLohnReadiness,
  resolveCockpitAmpel,
  isDocumentationOverdue48h,
  type CockpitDrillRow,
} from "@shared/domain/billing-cockpit";

/**
 * Task #1444 — Unit-Tests für das reine Cockpit-Domänenmodul (Phase 1).
 * Reine Funktionen, keine DB/kein Server: Trichter-Mapping, Aggregation,
 * Gruppierung, Lohn-Readiness, Ampel und 48h-Doku-Überfälligkeit.
 */

function makeRow(overrides: Partial<CockpitDrillRow>): CockpitDrillRow {
  return {
    id: Math.random().toString(36),
    kind: "appointment",
    stage: "geplant",
    minutes: 60,
    cents: 10000,
    employeeId: null,
    employeeName: null,
    customerId: 1,
    customerName: "Kunde A",
    invoiceId: null,
    invoiceNumber: null,
    invoiceStatus: null,
    billingType: null,
    appointmentId: 1,
    date: "2026-06-01",
    ...overrides,
  };
}

describe("mapPipelineStageToFunnel", () => {
  it("bildet jede Pipeline-Stufe auf eine der 5 Trichter-Stufen ab", () => {
    const mapped = [
      "offen",
      "dokumentiert",
      "unterschrieben",
      "rechnung_erstellt",
      "versendet",
      "avis_erhalten",
      "bezahlt",
    ].map((s) => mapPipelineStageToFunnel(s as never));
    for (const stage of mapped) {
      expect(COCKPIT_FUNNEL_STAGES).toContain(stage);
    }
  });
});

describe("summarizeCockpitFunnel", () => {
  it("liefert immer alle 5 Stufen, auch leere", () => {
    const summary = summarizeCockpitFunnel([]);
    expect(summary).toHaveLength(COCKPIT_FUNNEL_STAGES.length);
    for (const s of summary) {
      expect(s.itemCount).toBe(0);
      expect(s.totalCents).toBe(0);
      expect(s.totalMinutes).toBe(0);
    }
  });

  it("summiert counts, Minuten und Cents je Stufe (Integer-Cents)", () => {
    const rows = [
      makeRow({ stage: "geplant", cents: 5000, minutes: 30 }),
      makeRow({ stage: "geplant", cents: 2500, minutes: 15 }),
      makeRow({ stage: "bezahlt", cents: 9999, minutes: 90 }),
    ];
    const summary = summarizeCockpitFunnel(rows);
    const geplant = summary.find((s) => s.stage === "geplant")!;
    const bezahlt = summary.find((s) => s.stage === "bezahlt")!;
    expect(geplant.itemCount).toBe(2);
    expect(geplant.totalCents).toBe(7500);
    expect(geplant.totalMinutes).toBe(45);
    expect(bezahlt.itemCount).toBe(1);
    expect(bezahlt.totalCents).toBe(9999);
  });
});

describe("groupCockpitRows", () => {
  it("gruppiert nach Mitarbeiter und sortiert nach Σ Cents absteigend", () => {
    const rows = [
      makeRow({ employeeId: 1, employeeName: "Anna", cents: 1000 }),
      makeRow({ employeeId: 2, employeeName: "Bert", cents: 5000 }),
      makeRow({ employeeId: 1, employeeName: "Anna", cents: 2000 }),
    ];
    const groups = groupCockpitRows(rows, "mitarbeiter");
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("Bert");
    expect(groups[1].label).toBe("Anna");
    expect(groups[1].totalCents).toBe(3000);
    expect(groups[1].rowCount).toBe(2);
  });

  it("fasst Zeilen ohne Rechnung unter einem eigenen Schlüssel zusammen", () => {
    const rows = [
      makeRow({ kind: "invoice", invoiceId: null, invoiceNumber: null }),
      makeRow({ kind: "invoice", invoiceId: 7, invoiceNumber: "R-7" }),
    ];
    const groups = groupCockpitRows(rows, "rechnung");
    const keys = groups.map((g) => g.key);
    expect(keys).toContain("inv-none");
    expect(keys).toContain("inv-7");
  });
});

describe("summarizeLohnReadiness", () => {
  it("zählt lohnreif (ready oder geschlossen) vs. in Prüfung bei Aktivität", () => {
    const summary = summarizeLohnReadiness([
      { ready: true, isClosed: false, hasTimeEntries: true },
      { ready: false, isClosed: true, hasTimeEntries: true },
      { ready: false, isClosed: false, hasTimeEntries: true },
      { ready: false, isClosed: false, hasTimeEntries: false },
    ]);
    expect(summary.lohnreif).toBe(2);
    expect(summary.inPruefung).toBe(1);
    expect(summary.withActivity).toBe(3);
  });
});

describe("isDocumentationOverdue48h", () => {
  it("ist überfällig, wenn der Termin >= 2 Tage zurückliegt", () => {
    const now = new Date("2026-06-10T00:00:00");
    expect(isDocumentationOverdue48h({ date: "2026-06-08" }, now)).toBe(true);
    expect(isDocumentationOverdue48h({ date: "2026-06-09" }, now)).toBe(false);
  });
});

describe("resolveCockpitAmpel", () => {
  const base = {
    ueberfaelligeDokuCount: 0,
    zahlungsverzugCount: 0,
    lnPruefungCount: 0,
    abrechnungsPruefungCount: 0,
    lohnInPruefungCount: 0,
  };

  it("grün, wenn keine Ausnahmen vorliegen", () => {
    expect(resolveCockpitAmpel(base)).toBe("gruen");
  });

  it("gelb bei offenen Prüfungen/Lohn-Blockern", () => {
    expect(resolveCockpitAmpel({ ...base, lnPruefungCount: 1 })).toBe("gelb");
    expect(resolveCockpitAmpel({ ...base, abrechnungsPruefungCount: 1 })).toBe("gelb");
    expect(resolveCockpitAmpel({ ...base, lohnInPruefungCount: 1 })).toBe("gelb");
  });

  it("rot bei harten Rückständen (überfällige Doku oder Zahlungsverzug)", () => {
    expect(resolveCockpitAmpel({ ...base, ueberfaelligeDokuCount: 1, lnPruefungCount: 5 })).toBe("rot");
    expect(resolveCockpitAmpel({ ...base, zahlungsverzugCount: 1 })).toBe("rot");
  });
});
