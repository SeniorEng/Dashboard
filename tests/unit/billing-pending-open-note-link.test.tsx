// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import type { BillingCustomerItem } from "@shared/api";
import { PendingInvoicesCard } from "@/features/billing/components/pending-invoices-card";

/**
 * Task #1747 — Absicherung des Absprungs vom „noch X geplante Termine“-Hinweis.
 *
 * Task #1744 hat den Hinweis in der „Noch zu erstellen"-Karte klickbar gemacht.
 * Er verlinkt auf `/service-records/open?customerId=<id>&year=<selectedYear>&month=<selectedMonth>`.
 * Dieser Test stellt sicher, dass der Link
 *   1. für einen Kunden mit offenen Terminen als `<a>` mit korrektem href rendert,
 *   2. GENAU die customerId dieses Kunden trägt,
 *   3. den auf der Abrechnungsseite gewählten Monat/Jahr (nicht den Termin-Monat)
 *      als Scope mitgibt,
 * damit ein späteres Refactoring den Absprung nicht still zerbricht.
 */

const BASE_CUSTOMER: Omit<BillingCustomerItem, "id"> = {
  name: "Kunde",
  vorname: "Max",
  nachname: "Muster",
  billingType: "selbstzahler",
  status: "aktiv",
  completedAppointments: 0,
  coveredAppointments: 0,
  openAppointments: 0,
  eligibility: { status: "eligible", reason: null },
};

function makeCustomer(
  overrides: Partial<BillingCustomerItem> & { id: number },
): BillingCustomerItem {
  return { ...BASE_CUSTOMER, ...overrides };
}

function renderCard(
  customers: BillingCustomerItem[],
  selectedMonth: number,
  selectedYear: number,
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router>
        <PendingInvoicesCard
          customers={customers}
          isLoading={false}
          onCreateForCustomer={vi.fn()}
          selectedMonth={selectedMonth}
          selectedYear={selectedYear}
        />
      </Router>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Abrechnung — „noch X geplante Termine“-Absprung (Task #1747)", () => {
  it("rendert den Hinweis als Link mit customerId und gewähltem Monat/Jahr", () => {
    const customer = makeCustomer({ id: 4711, openAppointments: 3 });
    renderCard([customer], 5, 2026);

    const note = screen.getByTestId(`text-pending-open-note-${customer.id}`);
    // Es ist ein echter Link (Absprung, kein Button).
    expect(note.tagName).toBe("A");
    expect(note.getAttribute("href")).toBe(
      "/service-records/open?customerId=4711&year=2026&month=5",
    );
    // Sichtbarer Text spiegelt die offene Termin-Zahl.
    expect(note.textContent).toContain("noch 3 geplante Termine");
  });

  it("verwendet den auf der Abrechnungsseite gewählten Monat, nicht einen Termin-Monat", () => {
    const customer = makeCustomer({ id: 99, openAppointments: 1 });
    // Anderer Monat/Jahr als im ersten Test, um Hardcoding auszuschließen.
    renderCard([customer], 11, 2025);

    const note = screen.getByTestId(`text-pending-open-note-${customer.id}`);
    expect(note.getAttribute("href")).toBe(
      "/service-records/open?customerId=99&year=2025&month=11",
    );
    // Singular bei genau einem offenen Termin.
    expect(note.textContent).toContain("noch 1 geplanter Termin");
  });

  it("zeigt keinen Absprung für Kunden ohne offene Termine", () => {
    const ready = makeCustomer({ id: 7, openAppointments: 0 });
    renderCard([ready], 5, 2026);

    expect(screen.queryByTestId(`text-pending-open-note-${ready.id}`)).toBeNull();
  });
});
