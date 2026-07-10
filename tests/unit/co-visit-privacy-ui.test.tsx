// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

/**
 * Task #1736 — Zwei-Kräfte-Einsatz: Partner-Name auch für die beteiligte Kraft.
 *
 * Zuvor (Task #1614/#1618) war die „Zwei-Kräfte"-Kennzeichnung rein Admin-
 * sichtbar. Task #1736 lockert das: die am Einsatz BETEILIGTE Kraft soll den
 * Hinweis inkl. Partner-NAMEN auf ihrem EIGENEN Leg sehen, um sich mit der
 * zweiten Kraft abzustimmen. Der Partner-Name wird serverseitig abgeleitet
 * (`coVisitPartnerName`) und ist streng auf den Namen begrenzt — er erweitert
 * NICHT den Sichtbarkeits-/Doku-Scope.
 *
 * Die Privacy-Invariante bleibt: ein Mitarbeiter sieht ohnehin nur seinen
 * eigenen Leg (serverseitiger Zuordnungs-Filter, CV-3 in
 * tests/appointments/co-visit.test.ts). Fremde Einsätze bleiben unsichtbar,
 * weil die fremden Termine gar nicht erst geladen werden — nicht, weil die UI
 * den Hinweis unterdrückt.
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

const COVISIT_GROUP_ID = "co-visit-group-1736";
const PARTNER_NAME = "Partner Kraft";

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
    coVisitPartnerName: PARTNER_NAME,
    assignedEmployeeId: 42,
    assignedEmployeeName: "Test Kraft",
    customer: { id: 7, name: "Testkunde", address: "Musterweg 1", telefon: null, festnetz: null },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) AppointmentCard — Badge `pill-co-visit-<id>` in Kalender/Listen
// ---------------------------------------------------------------------------
describe("AppointmentCard — Zwei-Kräfte-Badge inkl. Partner-Name (Task #1736)", () => {
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

  it("Mitarbeiter (Nicht-Admin): sieht pill-co-visit inkl. Partner-Name auf dem eigenen Leg", async () => {
    mockIsAdmin = false;
    const appt = makeAppointment();
    await renderCard(appt);

    const pill = screen.getByTestId(`pill-co-visit-${appt.id}`);
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain(PARTNER_NAME);
  });

  it("Admin: pill-co-visit inkl. Partner-Name auf BEIDEN verknüpften Legs sichtbar", async () => {
    mockIsAdmin = true;
    const legA = makeAppointment({ id: 9001, assignedEmployeeId: 42, coVisitPartnerName: "Kraft B" });
    const legB = makeAppointment({ id: 9002, assignedEmployeeId: 43, coVisitPartnerName: "Kraft A" });

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

    expect(screen.getByTestId(`pill-co-visit-${legA.id}`).textContent).toContain("Kraft B");
    expect(screen.getByTestId(`pill-co-visit-${legB.id}`).textContent).toContain("Kraft A");
  });

  it("Fällt auf generisches «Zwei Kräfte» zurück, wenn kein Partner-Name vorliegt", async () => {
    mockIsAdmin = false;
    const appt = makeAppointment({ coVisitPartnerName: null });
    await renderCard(appt);

    const pill = screen.getByTestId(`pill-co-visit-${appt.id}`);
    expect(pill.textContent).toContain("Zwei Kräfte");
    expect(pill.textContent).not.toContain(PARTNER_NAME);
  });

  it("Einzeltermin (keine coVisitGroupId): KEIN Badge — für Admin wie Mitarbeiter", async () => {
    const appt = makeAppointment({ coVisitGroupId: null, coVisitPartnerName: null });

    mockIsAdmin = false;
    const { unmount } = await renderCard(appt);
    expect(screen.queryByTestId(`pill-co-visit-${appt.id}`)).toBeNull();
    unmount();

    mockIsAdmin = true;
    await renderCard(appt);
    expect(screen.queryByTestId(`pill-co-visit-${appt.id}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2) AppointmentTimeServicesCard — Zeile `row-co-visit` im Termin-Detail
// ---------------------------------------------------------------------------
describe("AppointmentTimeServicesCard — Zwei-Kräfte-Zeile inkl. Partner-Name (Task #1736)", () => {
  async function renderDetail(appointment: any) {
    const { AppointmentTimeServicesCard } = await import(
      "@/features/appointments/components/appointment-time-services-card"
    );
    return render(
      <AppointmentTimeServicesCard
        appointment={appointment}
        services={[]}
        isCompleted={false}
        isErstberatung={false}
      />,
    );
  }

  it("Beteiligte Kraft: row-co-visit inkl. Partner-Name sichtbar", async () => {
    const appt = makeAppointment();
    await renderDetail(appt);

    const row = screen.getByTestId("row-co-visit");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain(PARTNER_NAME);
  });

  it("Fällt auf generischen Text zurück, wenn kein Partner-Name vorliegt", async () => {
    const appt = makeAppointment({ coVisitPartnerName: null });
    await renderDetail(appt);

    const row = screen.getByTestId("row-co-visit");
    expect(row.textContent).toContain("Zwei-Kräfte-Einsatz");
    expect(row.textContent).not.toContain(PARTNER_NAME);
  });

  it("Einzeltermin (keine coVisitGroupId): keine row-co-visit", async () => {
    const appt = makeAppointment({ coVisitGroupId: null, coVisitPartnerName: null });
    await renderDetail(appt);

    expect(screen.queryByTestId("row-co-visit")).toBeNull();
  });
});
