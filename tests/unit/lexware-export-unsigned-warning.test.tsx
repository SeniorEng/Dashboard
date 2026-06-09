// @vitest-environment jsdom
/**
 * Task #1125 — Sicherstellen, dass die Unterschrift-Warnung in der
 * Stundenübersicht (`client/src/pages/admin/lexware-export.tsx`) korrekt
 * gerendert wird.
 *
 * Die Backend-Aggregation für `unsignedAppointmentCount` ist bereits über
 * `tests/lexware-export-signed-gate.test.ts` abgesichert. Hier pinnen wir das
 * tatsächliche Rendern der zwei Warn-Elemente im Frontend:
 *   1. den Zeilen-Indikator `warning-unsigned-<id>` (pro Mitarbeiter mit
 *      `unsignedAppointmentCount > 0`), und
 *   2. das Sammel-Banner `banner-unsigned-summary` (sobald mindestens ein
 *      Mitarbeiter unsignierte Termine hat).
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

// Radix-UI (Select) nutzt ResizeObserver, das jsdom nicht mitliefert.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? RO;

import HoursOverview from "../../client/src/pages/admin/lexware-export";

interface EmployeeRow {
  employeeId: number;
  nachname: string;
  vorname: string;
  stundenHauswirtschaft: number;
  stundenAlltagsbegleitung: number;
  stundenErstberatung: number;
  stundenAnfahrt: number;
  stundenSonstiges: number;
  stundenFeiertage: number;
  kilometer: number;
  kilometerAnfahrt: number;
  kilometerKunden: number;
  kilometerSonstige: number;
  tageUrlaub: number;
  tageKrankheit: number;
  isEuRentner: boolean;
  employmentType: string;
  weeklyWorkDays: number;
  monthlyWorkHours: number | null;
  bruttoCents: number | null;
  uebertragVormonatCents: number | null;
  auszahlbarCents: number | null;
  uebertragNeuCents: number | null;
  unsignedAppointmentCount: number;
  unsignedMinutes: number;
}

function makeRow(overrides: Partial<EmployeeRow> = {}): EmployeeRow {
  return {
    employeeId: 1,
    nachname: "Mustermann",
    vorname: "Max",
    stundenHauswirtschaft: 10,
    stundenAlltagsbegleitung: 0,
    stundenErstberatung: 0,
    stundenAnfahrt: 0,
    stundenSonstiges: 0,
    stundenFeiertage: 0,
    kilometer: 0,
    kilometerAnfahrt: 0,
    kilometerKunden: 0,
    kilometerSonstige: 0,
    tageUrlaub: 0,
    tageKrankheit: 0,
    isEuRentner: false,
    employmentType: "regular",
    weeklyWorkDays: 5,
    monthlyWorkHours: null,
    bruttoCents: null,
    uebertragVormonatCents: null,
    auszahlbarCents: null,
    uebertragNeuCents: null,
    unsignedAppointmentCount: 0,
    unsignedMinutes: 0,
    ...overrides,
  };
}

function renderOverview(rows: EmployeeRow[]) {
  apiGet.mockResolvedValue({
    ok: true,
    data: { rows, year: 2024, month: 5, earningsLimitCents: 53800 },
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(HoursOverview),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HoursOverview — Unterschrift-Warnung (Task #1125)", () => {
  it("rendert Zeilen-Indikator + Sammel-Banner, wenn ein Mitarbeiter unsignierte Termine hat", async () => {
    renderOverview([
      makeRow({ employeeId: 7, unsignedAppointmentCount: 2, unsignedMinutes: 180 }),
      makeRow({ employeeId: 8, nachname: "Sauber", unsignedAppointmentCount: 0 }),
    ]);

    // Warten bis die Tabelle (also die geladenen Daten) gerendert ist.
    await screen.findByTestId("table-hours-overview");

    // Zeilen-Indikator nur beim Mitarbeiter mit unsignierten Terminen.
    expect(screen.getByTestId("warning-unsigned-7")).toBeTruthy();
    expect(screen.queryByTestId("warning-unsigned-8")).toBeNull();

    // Sammel-Banner ist sichtbar.
    expect(screen.getByTestId("banner-unsigned-summary")).toBeTruthy();
  });

  it("rendert WEDER Zeilen-Indikator NOCH Sammel-Banner, wenn kein Mitarbeiter unsignierte Termine hat", async () => {
    renderOverview([
      makeRow({ employeeId: 7, unsignedAppointmentCount: 0 }),
      makeRow({ employeeId: 8, nachname: "Sauber", unsignedAppointmentCount: 0 }),
    ]);

    await screen.findByTestId("table-hours-overview");

    expect(screen.queryByTestId("warning-unsigned-7")).toBeNull();
    expect(screen.queryByTestId("warning-unsigned-8")).toBeNull();
    expect(screen.queryByTestId("banner-unsigned-summary")).toBeNull();
  });
});
