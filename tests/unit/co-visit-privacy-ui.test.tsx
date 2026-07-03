// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

/**
 * Task #1618 — Privacy-Invariante des Zwei-Kräfte-Hinweises (UI-Verteidigungslinie).
 *
 * Task #1614 zeigt die „Zwei-Kräfte-Einsatz"-Kennzeichnung ausschließlich für
 * Admins/Teamleitung (Gate über `user?.isAdmin` in der Karte bzw. den `isAdmin`-
 * Prop in der Detailkarte). Die Privacy-Invariante besagt: die gemeinsame
 * `coVisitGroupId` darf die Sichtbarkeit einer einzelnen Pflegekraft NICHT
 * erweitern. Serverseitig ist das über die Zuordnungs-Filterung abgesichert
 * (siehe CV-3 in tests/appointments/co-visit.test.ts). Dieser Test pinnt die
 * ZWEITE Verteidigungslinie im Frontend: eine Pflegekraft (Nicht-Admin) sieht
 * die Partner-Kennzeichnung gar nicht erst, ein Admin schon — auf beiden
 * verknüpften Legs.
 *
 * Abgedeckte Flächen:
 *   - AppointmentCard (Badge `pill-co-visit-<id>` in Kalender/Listen)
 *   - AppointmentTimeServicesCard (Zeile `row-co-visit` im Termin-Detail)
 */

let mockIsAdmin = false;
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: 1, isAdmin: mockIsAdmin, isSuperAdmin: false },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

beforeEach(() => {
  mockIsAdmin = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
}

const COVISIT_GROUP_ID = "co-visit-group-1618";

function makeAppointment(overrides: Record<string, unknown> = {}): any {
  return {
    id: 9001,
    date: "2026-07-20",
    scheduledStart: "09:00",
    scheduledEnd: "10:00",
    actualStart: null,
    actualEnd: null,
    status: "scheduled",
    appointmentType: "kundentermin",
    serviceType: null,
    durationPromised: 60,
    isFahrtdienst: false,
    seriesId: null,
    coVisitGroupId: COVISIT_GROUP_ID,
    assignedEmployeeId: 42,
    assignedEmployeeName: "Test Kraft",
    customer: { id: 7, name: "Testkunde", address: "Musterweg 1", telefon: null, festnetz: null },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) AppointmentCard — Badge `pill-co-visit-<id>` in Kalender/Listen
// ---------------------------------------------------------------------------
describe("AppointmentCard — Zwei-Kräfte-Badge nur für Admin (Task #1618)", () => {
  async function renderCard(appointment: any) {
    const { AppointmentCard } = await import(
      "@/features/appointments/components/appointment-card"
    );
    return render(
      <QueryClientProvider client={makeQc()}>
        <Router>
          <AppointmentCard appointment={appointment} />
        </Router>
      </QueryClientProvider>,
    );
  }

  it("Pflegekraft (Nicht-Admin): KEIN pill-co-visit trotz gesetzter coVisitGroupId", async () => {
    mockIsAdmin = false;
    const appt = makeAppointment();
    await renderCard(appt);

    // Karte wird gerendert …
    expect(screen.getByTestId(`card-appointment-${appt.id}`)).toBeTruthy();
    // … aber die Partner-Kennzeichnung fehlt.
    expect(screen.queryByTestId(`pill-co-visit-${appt.id}`)).toBeNull();
  });

  it("Admin: pill-co-visit auf BEIDEN verknüpften Legs sichtbar", async () => {
    mockIsAdmin = true;
    const legA = makeAppointment({ id: 9001, assignedEmployeeId: 42 });
    const legB = makeAppointment({ id: 9002, assignedEmployeeId: 43 });

    const { AppointmentCard } = await import(
      "@/features/appointments/components/appointment-card"
    );
    render(
      <QueryClientProvider client={makeQc()}>
        <Router>
          <AppointmentCard appointment={legA} />
          <AppointmentCard appointment={legB} />
        </Router>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId(`pill-co-visit-${legA.id}`)).toBeTruthy();
    expect(screen.getByTestId(`pill-co-visit-${legB.id}`)).toBeTruthy();
  });

  it("Admin: kein Badge, wenn coVisitGroupId fehlt (Einzeltermin)", async () => {
    mockIsAdmin = true;
    const appt = makeAppointment({ coVisitGroupId: null });
    await renderCard(appt);

    expect(screen.queryByTestId(`pill-co-visit-${appt.id}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2) AppointmentTimeServicesCard — Zeile `row-co-visit` im Termin-Detail
// ---------------------------------------------------------------------------
describe("AppointmentTimeServicesCard — Zwei-Kräfte-Zeile nur für Admin (Task #1618)", () => {
  async function renderDetail(isAdmin: boolean, appointment: any) {
    const { AppointmentTimeServicesCard } = await import(
      "@/features/appointments/components/appointment-time-services-card"
    );
    return render(
      <AppointmentTimeServicesCard
        appointment={appointment}
        services={[]}
        isCompleted={false}
        isErstberatung={false}
        isAdmin={isAdmin}
      />,
    );
  }

  it("Pflegekraft (Nicht-Admin): KEINE row-co-visit trotz gesetzter coVisitGroupId", async () => {
    const appt = makeAppointment();
    await renderDetail(false, appt);

    expect(screen.queryByTestId("row-co-visit")).toBeNull();
  });

  it("Admin: row-co-visit sichtbar", async () => {
    const appt = makeAppointment();
    await renderDetail(true, appt);

    expect(screen.getByTestId("row-co-visit")).toBeTruthy();
  });

  it("Admin: keine Zeile, wenn coVisitGroupId fehlt (Einzeltermin)", async () => {
    const appt = makeAppointment({ coVisitGroupId: null });
    await renderDetail(true, appt);

    expect(screen.queryByTestId("row-co-visit")).toBeNull();
  });
});
