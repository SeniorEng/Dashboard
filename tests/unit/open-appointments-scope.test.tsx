// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Task #1749 — Absicherung der Ziel-Seite des Absprungs
 * `/service-records/open?customerId=<id>&year=<y>&month=<m>`.
 *
 * Task #1747 hat nur den LINK abgesichert (trägt die richtige
 * customerId/year/month). Dieser Test prüft die Gegenseite: Die Ziel-Seite
 * `CustomerUndocumentedAppointmentsPage` liest diese Query-Parameter WIRKLICH
 * aus und lädt genau den Scope (dieser Kunde, dieser Monat). Läse sie einen
 * Parameter falsch, „funktionierte" der Sprung (korrekte URL), landete aber auf
 * einer falschen/ungefilterten Liste.
 *
 * Da die eigentliche Filterung serverseitig passiert, spiegelt der gemockte
 * API-Client den Backend-Vertrag: Er filtert einen festen Datensatz anhand der
 * vom Page übergebenen Query-Parameter. So verifiziert der Test gleichzeitig,
 * dass die Seite (1) die richtigen Parameter aus der URL an die API weiterreicht
 * und (2) nur die zurückgelieferten (gescopten) Termine rendert.
 */

let mockSearch = "";

vi.mock("wouter", () => ({
  Link: ({ children, href, ...props }: any) =>
    React.createElement("a", { href, ...props }, children),
  useSearch: () => mockSearch,
}));

vi.mock("@/components/layout", () => ({
  Layout: ({ children }: any) =>
    React.createElement("div", { "data-testid": "layout" }, children),
}));

vi.mock("@/hooks/use-view-as-employee", () => ({
  useViewAsEmployee: () => ({ viewAsEmployeeId: null }),
}));

// AppointmentCard hat tiefe Abhängigkeiten (Budget-Fit, Design-System, …), die
// für diesen Scope-Test irrelevant sind — die Seite selbst rendert den
// `item-appointment-<id>`-Wrapper. Wir mocken die Karte schlank weg.
vi.mock("@/features/appointments/components/appointment-card", () => ({
  AppointmentCard: ({ appointment }: any) =>
    React.createElement(
      "div",
      { "data-testid": `card-appointment-${appointment.id}` },
      appointment.date,
    ),
}));

type FakeAppt = {
  id: number;
  customerId: number;
  date: string;
  scheduledStart: string;
};

// Datensatz über mehrere Kunden UND Monate hinweg. Der gemockte API-Client
// filtert daraus genau wie das Backend anhand customerId/year/month.
const TARGET_CUSTOMER = 100;
const OTHER_CUSTOMER = 999;

const ALL_APPTS: FakeAppt[] = [
  { id: 1, customerId: TARGET_CUSTOMER, date: "2026-03-15", scheduledStart: "10:00" },
  { id: 2, customerId: TARGET_CUSTOMER, date: "2026-03-05", scheduledStart: "09:00" },
  // Anderer Kunde, gleicher Monat → muss ausgeschlossen sein.
  { id: 3, customerId: OTHER_CUSTOMER, date: "2026-03-12", scheduledStart: "08:00" },
  // Gleicher Kunde, anderer Monat → muss ausgeschlossen sein.
  { id: 4, customerId: TARGET_CUSTOMER, date: "2026-04-02", scheduledStart: "11:00" },
  // Gleicher Kunde, anderes Jahr → muss ausgeschlossen sein.
  { id: 5, customerId: TARGET_CUSTOMER, date: "2025-03-20", scheduledStart: "12:00" },
];

const getMock = vi.fn(async (path: string) => {
  if (path.startsWith("/customers/")) {
    return { ok: true, data: { id: TARGET_CUSTOMER, name: "Test Kunde" } };
  }
  // /appointments/undocumented/by-customer?customerId=..&year=..&month=..
  const qs = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  const p = new URLSearchParams(qs);
  const cid = Number(p.get("customerId"));
  const year = Number(p.get("year"));
  const month = Number(p.get("month"));
  const filtered = ALL_APPTS.filter((a) => {
    const [ay, am] = a.date.split("-").map(Number);
    return a.customerId === cid && ay === year && am === month;
  });
  return { ok: true, data: filtered };
});

vi.mock("@/lib/api/client", () => ({
  api: { get: (path: string) => getMock(path) },
  unwrapResult: (r: any) => (r && "data" in r ? r.data : r),
}));

import CustomerUndocumentedAppointmentsPage from "../../client/src/pages/customer-undocumented-appointments";

function renderPage(search: string) {
  mockSearch = search;
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(CustomerUndocumentedAppointmentsPage),
    ),
  );
}

beforeEach(() => {
  mockSearch = "";
  getMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("CustomerUndocumentedAppointmentsPage — Scope-Filter (Task #1749)", () => {
  it("lädt genau den Kunden + Monat aus den Query-Parametern (API-Request)", async () => {
    renderPage(`customerId=${TARGET_CUSTOMER}&year=2026&month=3`);

    await waitFor(() => {
      expect(
        getMock.mock.calls.some(([path]) =>
          path.startsWith("/appointments/undocumented/by-customer"),
        ),
      ).toBe(true);
    });

    const apptCall = getMock.mock.calls.find(([path]) =>
      path.startsWith("/appointments/undocumented/by-customer"),
    )!;
    const qs = new URLSearchParams(apptCall[0].split("?")[1]);
    expect(qs.get("customerId")).toBe(String(TARGET_CUSTOMER));
    expect(qs.get("year")).toBe("2026");
    expect(qs.get("month")).toBe("3");
  });

  it("zeigt NUR die offenen Termine dieses Kunden für diesen Monat", async () => {
    renderPage(`customerId=${TARGET_CUSTOMER}&year=2026&month=3`);

    // Beide Termine des Zielkunden im März 2026.
    await waitFor(() => {
      expect(screen.getByTestId("item-appointment-1")).toBeTruthy();
    });
    expect(screen.getByTestId("item-appointment-2")).toBeTruthy();

    // Anderer Kunde / anderer Monat / anderes Jahr sind ausgeschlossen.
    expect(screen.queryByTestId("item-appointment-3")).toBeNull();
    expect(screen.queryByTestId("item-appointment-4")).toBeNull();
    expect(screen.queryByTestId("item-appointment-5")).toBeNull();

    // Zähler spiegelt exakt die zwei gescopten Termine.
    expect(screen.getByTestId("text-count").textContent).toContain("2 Termine");
  });

  it("scoped auf einen ANDEREN Monat → nur dessen Termin, nicht der März-Scope", async () => {
    renderPage(`customerId=${TARGET_CUSTOMER}&year=2026&month=4`);

    await waitFor(() => {
      expect(screen.getByTestId("item-appointment-4")).toBeTruthy();
    });
    // Die März-Termine desselben Kunden dürfen hier NICHT auftauchen.
    expect(screen.queryByTestId("item-appointment-1")).toBeNull();
    expect(screen.queryByTestId("item-appointment-2")).toBeNull();
    expect(screen.getByTestId("text-count").textContent).toContain("1 Termin");
  });

  it("ohne customerId → Fehlerhinweis statt ungefilterter Liste", () => {
    renderPage("year=2026&month=3");
    expect(screen.getByTestId("error-no-customer")).toBeTruthy();
    // Es darf gar keine Termin-Liste geladen werden.
    expect(
      getMock.mock.calls.some(([path]) =>
        path.startsWith("/appointments/undocumented/by-customer"),
      ),
    ).toBe(false);
  });
});
