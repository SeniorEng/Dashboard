// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Task #1511 — Lohn-Spalten + Lohn-Historie sind in der Wirtschaftlichkeits-
 * Tabelle (`/admin/services`) NUR für Superadmins sichtbar.
 *
 * Task #1510 hat die Lohn-Matrix Superadmin-exklusiv gemacht; serverseitig
 * sind die `/services/role-wage-rates*`-Routen superadmin-gegated (siehe
 * `tests/security/role-wage-rates-superadmin-only.test.ts`). Dieser Test pinnt
 * die ZWEITE Verteidigungslinie im UI: ein normaler Admin sieht
 *   - keine Lohn-Spaltenköpfe,
 *   - keine Lohn-Zellen,
 *   - keinen Lohn-Block in der aufgeklappten Historie,
 * und die Komponente LÄDT die Lohn-Daten erst gar nicht (kein `api.get` auf
 * `/services/role-wage-rates`). Für den Superadmin müssen genau diese Elemente
 * erscheinen — der Kontrast schützt vor einem Refactor, der das `isSuperAdmin`-
 * Gate versehentlich entfernt.
 */

type ApiResult<T> = { ok: true; data: T } | { ok: false; data: null };

const apiGetMock = vi.fn<(path: string) => Promise<ApiResult<unknown>>>();

vi.mock("@/lib/api", () => ({
  api: {
    get: (path: string) => apiGetMock(path),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  unwrapResult: (r: ApiResult<unknown>) => {
    if (!r.ok) throw new Error("unwrap on error result");
    return r.data;
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

let mockIsSuperAdmin = false;
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: 1, isSuperAdmin: mockIsSuperAdmin } }),
}));

import { ServiceEconomicsSection } from "@/features/services/components/service-economics-section";

const SERVICE = {
  id: 501,
  name: "Hauswirtschaft",
  code: "HW",
  isActive: true,
  isBillable: true,
  unitType: "hours",
  defaultPriceCents: 3500,
  employeeRateCents: 1500,
  budgetPots: [],
} as any;

function mockApiByPath(overrides: Record<string, unknown> = {}) {
  apiGetMock.mockImplementation((path: string) => {
    if (path in overrides) {
      return Promise.resolve({ ok: true, data: overrides[path] });
    }
    return Promise.resolve({ ok: true, data: [] });
  });
}

function renderSection() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(ServiceEconomicsSection, { services: [SERVICE], isLoading: false }),
    ),
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ServiceEconomicsSection — Lohn nur für Superadmin (Task #1511)", () => {
  it("Normaler Admin: keine Lohn-Spalten/Zellen + kein Lohn-Daten-Fetch", async () => {
    mockIsSuperAdmin = false;
    mockApiByPath();
    renderSection();

    // Tabelle ist da (Preis-Spalte für alle Admins sichtbar).
    await screen.findByTestId("service-economics-section");
    expect(screen.getByTestId(`text-price-${SERVICE.id}`)).toBeTruthy();

    // Keine Lohn-Spaltenköpfe, keine Lohn-Zellen.
    expect(screen.queryByText(/Lohn Verwaltung/)).toBeNull();
    expect(screen.queryByText(/Lohn Teamleitung/)).toBeNull();
    expect(screen.queryByText(/Lohn Mitarbeiter/)).toBeNull();
    expect(screen.queryByTestId(`text-wage-employee-${SERVICE.id}`)).toBeNull();
    expect(screen.queryByTestId(`text-wage-admin-${SERVICE.id}`)).toBeNull();
    expect(screen.queryByTestId(`button-edit-wage-employee-${SERVICE.id}`)).toBeNull();

    // Lohn-Daten werden NICHT geladen (Query disabled für Nicht-Superadmins).
    const calledPaths = apiGetMock.mock.calls.map(c => c[0]);
    expect(calledPaths.some(p => p.startsWith("/services/role-wage-rates"))).toBe(false);
  });

  it("Normaler Admin: aufgeklappte Historie zeigt KEINEN Lohn-Block", async () => {
    mockIsSuperAdmin = false;
    mockApiByPath();
    renderSection();

    await screen.findByTestId("service-economics-section");
    fireEvent.click(screen.getByTestId(`button-toggle-history-${SERVICE.id}`));

    // Preis-Historie erscheint (für alle Admins), aber kein Lohn-Block.
    await screen.findByTestId(`history-${SERVICE.id}`);
    expect(screen.queryByText("Lohnsätze")).toBeNull();
    expect(screen.queryByText(/Keine Lohn-Phasen/)).toBeNull();

    const calledPaths = apiGetMock.mock.calls.map(c => c[0]);
    expect(calledPaths.some(p => p.startsWith("/services/role-wage-rates"))).toBe(false);
  });

  it("Superadmin: Lohn-Spalten + Lohn-Zellen werden gerendert und geladen", async () => {
    mockIsSuperAdmin = true;
    mockApiByPath();
    renderSection();

    await screen.findByTestId("service-economics-section");

    // Lohn-Spaltenköpfe + Lohn-Zelle (Katalog-Standard, da keine aktive Zeile).
    expect(screen.getByText(/Lohn Verwaltung/)).toBeTruthy();
    expect(screen.getByText(/Lohn Mitarbeiter/)).toBeTruthy();
    expect(screen.getByTestId(`text-wage-employee-${SERVICE.id}`)).toBeTruthy();
    expect(screen.getByTestId(`button-edit-wage-employee-${SERVICE.id}`)).toBeTruthy();

    // Lohn-Daten werden geladen.
    await waitFor(() => {
      const calledPaths = apiGetMock.mock.calls.map(c => c[0]);
      expect(calledPaths).toContain("/services/role-wage-rates");
    });
  });

  it("Superadmin: aufgeklappte Historie zeigt den Lohn-Block", async () => {
    mockIsSuperAdmin = true;
    mockApiByPath();
    renderSection();

    await screen.findByTestId("service-economics-section");
    fireEvent.click(screen.getByTestId(`button-toggle-history-${SERVICE.id}`));

    await screen.findByTestId(`history-${SERVICE.id}`);
    expect(screen.getByText("Lohnsätze")).toBeTruthy();
  });
});
