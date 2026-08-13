// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import type { BillingCustomerItem } from "@shared/api";
import { PendingInvoicesCard } from "@/features/billing/components/pending-invoices-card";

/**
 * Task #1905 — Karte „Noch zu erstellen": drei Cluster, IST/PLAN-Beträge.
 *
 * ERSETZT `billing-pending-open-note-link.test.tsx` (Task #1747). Jener Test
 * sicherte den Absprung am Inline-Hinweis „noch X geplante Termine" ab. Der
 * Hinweis entfällt mit #1905: die Gruppe „Dokumentation ausstehend" trägt ihre
 * Begründung in der Sektions-Überschrift, nicht mehr je Zeile. Ein Test, der
 * einen entfernten Absprung prüft, wäre nur noch rot — die schützenswerte
 * Eigenschaft ist jetzt die CLUSTER-Zuordnung.
 *
 * Kern (das Geld-Leck): ein Pflegekassen-Kunde, dem die Kundenunterschrift
 * fehlt, darf NICHT unter „Bereit zum Abrechnen" stehen — auch dann nicht, wenn
 * ein anderer Teil seiner Termine abrechenbar ist (`eligibility === "eligible"`).
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
  signedAppointmentCount: 0,
  unbilledAppointmentCount: 0,
  actualAmountCents: 0,
  plannedAmountCents: 0,
};

function makeCustomer(
  overrides: Partial<BillingCustomerItem> & { id: number },
): BillingCustomerItem {
  return { ...BASE_CUSTOMER, ...overrides };
}

function renderCard(customers: BillingCustomerItem[]) {
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
        />
      </Router>
    </QueryClientProvider>,
  );
}

/** Die IDs der Kunden, die in einer Sektion gerendert wurden. */
function idsInSection(testIdKey: string): number[] {
  const section = screen.queryByTestId(`section-pending-${testIdKey}`);
  if (!section) return [];
  return Array.from(section.querySelectorAll("[data-testid^='row-pending-customer-']"))
    .map((el) => Number(el.getAttribute("data-testid")!.replace("row-pending-customer-", "")));
}

/** Der Juli-2026-Fall aus der Referenz-DB: 5 dokumentiert, 5 abgedeckt, 4 signiert. */
const AWAITING_SIGNATURE_CUSTOMER = {
  id: 96,
  billingType: "pflegekasse_gesetzlich",
  completedAppointments: 5,
  coveredAppointments: 5,
  signedAppointmentCount: 4,
  unbilledAppointmentCount: 4,
  openAppointments: 0,
  // Genau der Punkt: der signierte Teil IST abrechenbar.
  eligibility: { status: "eligible" as const, reason: null },
  actualAmountCents: 30206,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Task #1905 — drei Cluster in der Karte „Noch zu erstellen“", () => {
  it("Kundenunterschrift fehlt ⇒ „Leistungsnachweis fehlt“, NICHT „Bereit“", () => {
    const c = makeCustomer(AWAITING_SIGNATURE_CUSTOMER);
    renderCard([c]);

    expect(idsInSection("proof")).toEqual([c.id]);
    expect(idsInSection("ready")).toEqual([]);
    expect(screen.queryByTestId("section-pending-ready")).toBeNull();
  });

  it("Kundenunterschrift fehlt ⇒ nicht auswählbar (keine Sammel-Abrechnung)", () => {
    const c = makeCustomer(AWAITING_SIGNATURE_CUSTOMER);
    renderCard([c]);

    // Die Auswahl-Leiste erscheint nur, wenn es erstellbare („Bereit")-Kunden gibt.
    expect(screen.queryByTestId("bar-pending-selection")).toBeNull();
    expect(screen.queryByTestId(`checkbox-pending-${c.id}`)).toBeNull();
  });

  it("Kundenunterschrift fehlt ⇒ „Erstellen“ bleibt erreichbar (bewusste Teil-Abrechnung, #1883)", () => {
    // Der signierte Teil ist abrechenbar; der Knopf führt in den Dialog, der die
    // ausgeschlossenen Termine ausweist und eine Bestätigung verlangt.
    const c = makeCustomer(AWAITING_SIGNATURE_CUSTOMER);
    renderCard([c]);
    expect(screen.queryByTestId(`button-create-pending-${c.id}`)).not.toBeNull();
  });

  it("gar nichts abzurechnen ⇒ kein „Erstellen“-Knopf", () => {
    const c = makeCustomer({
      id: 300,
      completedAppointments: 2,
      coveredAppointments: 0,
      unbilledAppointmentCount: 0,
      eligibility: { status: "blocked", reason: "not_signed" },
      actualAmountCents: 4200,
    });
    renderCard([c]);
    expect(screen.queryByTestId(`button-create-pending-${c.id}`)).toBeNull();
  });

  it("offene Termine ⇒ „Dokumentation ausstehend“ ohne Inline-Begründung", () => {
    const c = makeCustomer({
      id: 200,
      openAppointments: 3,
      plannedAmountCents: 12600,
    });
    renderCard([c]);

    expect(idsInSection("documentation")).toEqual([c.id]);
    // Kein Inline-Sub-Detail in diesem Cluster (die Sektion erklärt es).
    expect(screen.queryByTestId(`text-pending-partial-${c.id}`)).toBeNull();
    expect(screen.queryByTestId(`text-pending-ln-missing-${c.id}`)).toBeNull();
    expect(screen.queryByTestId(`text-pending-awaiting-signature-${c.id}`)).toBeNull();
    expect(screen.queryByTestId(`text-pending-block-${c.id}`)).toBeNull();
  });

  it("vollständig dokumentiert + signiert ⇒ „Bereit zum Abrechnen“", () => {
    const c = makeCustomer({
      id: 400,
      completedAppointments: 2,
      coveredAppointments: 2,
      signedAppointmentCount: 2,
      unbilledAppointmentCount: 2,
      actualAmountCents: 8400,
    });
    renderCard([c]);
    expect(idsInSection("ready")).toEqual([c.id]);
  });

  it("Cluster-Summe = Σ (IST + PLAN) der Gruppe", () => {
    const a = makeCustomer({ id: 501, openAppointments: 1, plannedAmountCents: 1000 });
    const b = makeCustomer({
      id: 502,
      openAppointments: 1,
      completedAppointments: 2,
      coveredAppointments: 1,
      actualAmountCents: 2500,
      plannedAmountCents: 500,
    });
    renderCard([a, b]);

    // 10,00 + 25,00 + 5,00 = 40,00 €
    expect(screen.getByTestId("text-pending-documentation-total").textContent).toContain("40,00");
  });

  it("„vorläufig“-Marker ist standardmäßig aus", () => {
    const c = makeCustomer({ id: 600, openAppointments: 1, plannedAmountCents: 1000 });
    renderCard([c]);
    expect(screen.queryByTestId(`text-pending-provisional-${c.id}`)).toBeNull();
    expect(screen.queryByTestId("text-pending-documentation-provisional")).toBeNull();
  });
});
