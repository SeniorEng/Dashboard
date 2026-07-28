// @vitest-environment jsdom
/**
 * Sicherstellen, dass die Unterschrift-Warnung in der konsolidierten
 * Mitarbeiterabrechnung (`client/src/pages/admin/mitarbeiterabrechnung.tsx`)
 * korrekt gerendert wird.
 *
 * Diese Seite ERSETZT die frühere Stundenübersicht/Lexware-Export-Seite
 * (Ersetzungs-Regel, Task #1555). Die Backend-Aggregation für
 * `unsignedAppointmentCount` ist über `tests/lexware-export-signed-gate.test.ts`
 * abgesichert. Hier pinnen wir das tatsächliche Rendern der Warn-Flächen:
 *   1. den Zeilen-Indikator `button-unsigned-<id>` (pro Mitarbeiter mit
 *      `unsignedAppointmentCount > 0`), und
 *   2. die aggregierte KPI-Kachel `kpi-offene-termine` (Summe der noch nicht
 *      abrechenbaren, dokumentierten aber unsignierten Termine).
 *
 * Ohne diesen Test könnte ein künftiger Umbau die Warnung still entfernen,
 * sodass nicht unterschriebene Termine im Lohnlauf untergehen.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("wouter", () => ({
  Link: ({ children, href, ...props }: any) =>
    React.createElement("a", { href, ...props }, children),
  useLocation: () => ["/", vi.fn()],
}));

vi.mock("@/components/layout", () => ({
  Layout: ({ children }: any) =>
    React.createElement("div", { "data-testid": "layout" }, children),
}));

vi.mock("@/lib/api/client", () => ({
  api: { get: apiGet },
  unwrapResult: (r: any) => (r && typeof r === "object" && "data" in r ? r.data : r),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Radix-UI (Select) nutzt ResizeObserver, das jsdom nicht mitliefert.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? RO;

import Mitarbeiterabrechnung from "../../client/src/pages/admin/mitarbeiterabrechnung";

interface OverviewRow {
  employeeId: number;
  vorname: string;
  nachname: string;
  employmentType: string;
  isEuRentner: boolean;
  erfasst: { hw: number; ab: number; feiertage: number; kilometer: number };
  abwesenheiten: { typ: "urlaub" | "krankheit"; von: string; bis: string; tage: number }[];
  saldo: { hw: number; ab: number; feiertage: number; kilometer: number };
  stundenkontoSaldo: number;
  kilometerSaldo: number;
  unsignedAppointmentCount: number;
  unsignedMinutes: number;
  minijob: null;
  isClosed: boolean;
}

function makeRow(overrides: Partial<OverviewRow> = {}): OverviewRow {
  return {
    employeeId: 1,
    vorname: "Max",
    nachname: "Mustermann",
    employmentType: "minijobber",
    isEuRentner: false,
    erfasst: { hw: 10, ab: 0, feiertage: 0, kilometer: 0 },
    abwesenheiten: [],
    saldo: { hw: 0, ab: 0, feiertage: 0, kilometer: 0 },
    stundenkontoSaldo: 0,
    kilometerSaldo: 0,
    unsignedAppointmentCount: 0,
    unsignedMinutes: 0,
    minijob: null,
    isClosed: false,
    ...overrides,
  };
}

function renderOverview(rows: OverviewRow[]) {
  const unsignedCount = rows.reduce((s, r) => s + r.unsignedAppointmentCount, 0);
  const unsignedMinutes = rows.reduce((s, r) => s + r.unsignedMinutes, 0);
  apiGet.mockResolvedValue({
    ok: true,
    data: {
      year: 2024,
      month: 5,
      earningsLimitCents: 53800,
      standDate: "2024-05-31",
      kpis: {
        erfassteStunden: { current: 10, previous: 0, deltaPct: null },
        abrechenbareStunden: { current: 10, previous: 0, deltaPct: null },
        produktivquote: { current: 100, gemeinkostenStunden: 0 },
        wachstum: { produktivDeltaPct: null, gemeinkostenDeltaPct: null },
        stundenkontoSaldo: 0,
        offeneTermine: { hours: Math.round((unsignedMinutes / 60) * 100) / 100, count: unsignedCount },
        activeEmployees: rows.length,
        minijobKappung: { count: 0 },
      },
      rows,
    },
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Mitarbeiterabrechnung),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Mitarbeiterabrechnung — Unterschrift-Warnung (Task #1555)", () => {
  it("rendert Zeilen-Indikator + KPI-Kachel, wenn ein Mitarbeiter unsignierte Termine hat", async () => {
    renderOverview([
      makeRow({ employeeId: 7, unsignedAppointmentCount: 2, unsignedMinutes: 180 }),
      makeRow({ employeeId: 8, nachname: "Sauber", unsignedAppointmentCount: 0 }),
    ]);

    // Warten bis die Tabelle (also die geladenen Daten) gerendert ist.
    await screen.findByTestId("row-employee-7");

    // Zeilen-Indikator nur beim Mitarbeiter mit unsignierten Terminen.
    expect(screen.getByTestId("button-unsigned-7")).toBeTruthy();
    expect(screen.queryByTestId("button-unsigned-8")).toBeNull();

    // Aggregierte KPI-Kachel ist sichtbar und zählt die unsignierten Termine.
    const kpi = screen.getByTestId("kpi-offene-termine");
    expect(kpi).toBeTruthy();
    expect(kpi.textContent).toContain("2 dokumentiert, nicht unterschrieben");
  });

  it("rendert KEINEN Zeilen-Indikator, wenn kein Mitarbeiter unsignierte Termine hat", async () => {
    renderOverview([
      makeRow({ employeeId: 7, unsignedAppointmentCount: 0 }),
      makeRow({ employeeId: 8, nachname: "Sauber", unsignedAppointmentCount: 0 }),
    ]);

    await screen.findByTestId("row-employee-7");

    expect(screen.queryByTestId("button-unsigned-7")).toBeNull();
    expect(screen.queryByTestId("button-unsigned-8")).toBeNull();
    // KPI-Kachel bleibt sichtbar, meldet aber 0 unsignierte Termine.
    expect(screen.getByTestId("kpi-offene-termine").textContent).toContain("0 dokumentiert, nicht unterschrieben");
  });
});
