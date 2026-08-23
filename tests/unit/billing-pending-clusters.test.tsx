// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** Minimale Auswahl-Hülle (#1376-Form) mit fest gesetzten IDs. */
function makeSelection(selected: number[]) {
  const set = new Set(selected);
  return {
    has: (id: number) => set.has(id),
    toggle: vi.fn(),
    toggleMany: vi.fn(),
    setAll: vi.fn(),
    clear: vi.fn(),
    size: set.size,
    ids: [...set],
  } as unknown as Parameters<typeof PendingInvoicesCard>[0]["selection"];
}

/**
 * 6hJRF6h8 — die Karte holt die Betraege NICHT mehr aus der Listen-Antwort,
 * sondern per Batch (`GET /billing/customer-amounts`), wenn eine Gruppe
 * geoeffnet wird. Der Mock beantwortet genau diesen Aufruf aus denselben
 * Fixture-Werten, die vorher als Prop hereinkamen.
 *
 * Die Tests fahren damit den ECHTEN Pfad: zugeklappt -> keine Zahl, geoeffnet
 * -> Batch -> Zahl. Die frueheren Fassungen pruefen dieselbe Aussage, aber ueber
 * einen Transportweg, den es in Produktion nicht mehr gibt.
 */
function mockAmounts(customers: BillingCustomerItem[]) {
  const body: Record<string, { actualAmountCents: number | null; plannedAmountCents: number | null }> = {};
  for (const c of customers) {
    body[String(c.id)] = {
      actualAmountCents: c.actualAmountCents,
      plannedAmountCents: c.plannedAmountCents,
    };
  }
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/billing/customer-amounts")) {
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }));
}

function renderCard(
  customers: BillingCustomerItem[],
  selection?: Parameters<typeof PendingInvoicesCard>[0]["selection"],
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router>
        <PendingInvoicesCard
          selectedYear={2026}
          selectedMonth={7}
          customers={customers.map((c) => ({ ...c, actualAmountCents: null, plannedAmountCents: null }))}
          isLoading={false}
          onCreateForCustomer={vi.fn()}
          selection={selection}
        />
      </Router>
    </QueryClientProvider>,
  );
}

/**
 * Rendert und OEFFNET Karte + alle Gruppen — erst dann laedt der Betrags-Batch.
 * Das ist der Weg, den ein Nutzer geht; zugeklappt gibt es per Konstruktion
 * keine Zahlen (6hJRF6h8).
 */
async function renderCardOffen(
  customers: BillingCustomerItem[],
  selection?: Parameters<typeof PendingInvoicesCard>[0]["selection"],
) {
  mockAmounts(customers);
  const r = renderCard(customers, selection);
  fireEvent.click(screen.getByTestId("button-pending-toggle"));
  for (const key of ["ready", "ln-missing", "documentation"]) {
    const btn = screen.queryByTestId(`button-pending-section-toggle-${key}`);
    if (btn) fireEvent.click(btn);
  }
  // Auf die Betraege warten — vorher steht dort bewusst "lädt …"/"…".
  await waitFor(() => {
    expect(screen.queryByTestId("text-pending-amount-pending-" + customers[0].id)).toBeNull();
  });
  return r;
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
  // `mockAmounts` stubbt global.fetch — ohne dieses Zuruecksetzen leckt der Stub
  // in andere Dateien. Der Waechter `no-leaked-fetch-stub` (Task #1611) faengt
  // genau das und hat es hier auch getan.
  vi.unstubAllGlobals();
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

  it("Cluster-Summe = Σ (IST + PLAN) der Gruppe", async () => {
    const a = makeCustomer({ id: 501, openAppointments: 1, plannedAmountCents: 1000 });
    const b = makeCustomer({
      id: 502,
      openAppointments: 1,
      completedAppointments: 2,
      coveredAppointments: 1,
      actualAmountCents: 2500,
      plannedAmountCents: 500,
    });
    await renderCardOffen([a, b]);

    // 10,00 + 25,00 + 5,00 = 40,00 €
    expect(screen.getByTestId("text-pending-documentation-total").textContent).toContain("40,00");
  });

  it("nicht berechenbarer Betrag zeigt Fragezeichen statt 0 (fehlender Katalogpreis)", async () => {
    // `null` statt 0: eine 0 in einer Geld-Spalte liest sich wie „nichts offen"
    // und wäre eine stille Falschaussage. Die Gruppensumme weist sich zusätzlich
    // als unvollständig aus, statt still zu klein zu sein.
    const known = makeCustomer({
      id: 700,
      completedAppointments: 1,
      coveredAppointments: 1,
      signedAppointmentCount: 1,
      unbilledAppointmentCount: 1,
      actualAmountCents: 5000,
    });
    const unknown = makeCustomer({
      id: 701,
      completedAppointments: 1,
      coveredAppointments: 1,
      signedAppointmentCount: 1,
      unbilledAppointmentCount: 1,
      actualAmountCents: null,
    });
    await renderCardOffen([known, unknown]);

    expect(screen.getByTestId(`text-pending-amount-unknown-${unknown.id}`).textContent).toBe("?");
    expect(screen.queryByTestId(`text-pending-amount-unknown-${known.id}`)).toBeNull();
    // Summe = nur der bekannte Betrag, aber sichtbar als unvollständig markiert.
    expect(screen.getByTestId("text-pending-ready-total").textContent).toContain("50,00");
    expect(screen.getByTestId("text-pending-ready-incomplete")).not.toBeNull();
  });

  it("Auswahl-Summe glättet einen nicht berechenbaren Betrag NICHT zu 0", async () => {
    // Diese Zahl steht direkt neben dem Sammel-Schreibknopf. Sie still zu klein
    // zu zeigen wäre genau die Falschaussage, die Zeile und Gruppensumme
    // vermeiden — also weist sie sich ebenfalls als unvollständig aus.
    const known = makeCustomer({
      id: 800,
      completedAppointments: 1,
      coveredAppointments: 1,
      signedAppointmentCount: 1,
      unbilledAppointmentCount: 1,
      actualAmountCents: 5000,
    });
    const unknown = makeCustomer({
      id: 801,
      completedAppointments: 1,
      coveredAppointments: 1,
      signedAppointmentCount: 1,
      unbilledAppointmentCount: 1,
      actualAmountCents: null,
    });
    const selection = makeSelection([known.id, unknown.id]);
    await renderCardOffen([known, unknown], selection);

    const label = screen.getByTestId("text-pending-selected-count").textContent ?? "";
    expect(label).toContain("2 ausgewählt");
    expect(label).toContain("50,00");
    expect(screen.getByTestId("text-pending-selected-incomplete")).not.toBeNull();
  });

  it("PLAN-Anteil ist als „vorläufig“ gekennzeichnet — Zeile und Gruppensumme", async () => {
    // Tragend, nicht kosmetisch: PLAN wird bewusst konservativ gerechnet (keine
    // spekulative USt). Das ist nur vertretbar, solange der Prognose-Anteil als
    // solcher erkennbar ist und nicht als blanker Euro neben dem IST steht.
    const c = makeCustomer({ id: 600, openAppointments: 1, plannedAmountCents: 1000 });
    await renderCardOffen([c]);
    expect(screen.getByTestId(`text-pending-provisional-${c.id}`)).not.toBeNull();
    expect(screen.getByTestId("text-pending-documentation-provisional")).not.toBeNull();
  });

  it("ohne PLAN-Anteil KEINE „vorläufig“-Kennzeichnung (reines IST ist exakt)", async () => {
    const c = makeCustomer({
      id: 601,
      completedAppointments: 1,
      coveredAppointments: 1,
      signedAppointmentCount: 1,
      unbilledAppointmentCount: 1,
      actualAmountCents: 5000,
    });
    await renderCardOffen([c]);
    expect(screen.queryByTestId(`text-pending-provisional-${c.id}`)).toBeNull();
    expect(screen.queryByTestId("text-pending-ready-provisional")).toBeNull();
  });
});
