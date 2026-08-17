// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem } from "@shared/api";
import { InvoiceList } from "@/features/billing/components/invoice-list";

/**
 * Task #1632 — Absicherung der Cluster-Auswahl in der Rechnungsliste.
 *
 * Die Handlungs-Cluster-Kopfzeile (Task #1630) trägt eine eigene
 * Auswahl-Checkbox (alle/teils/keine) NEBEN dem Ein-/Ausklapp-Button. Der
 * Regress, der hier verhindert wird: ein Klick auf die Cluster-Checkbox
 * darf ausschließlich die Auswahl der Rechnungen dieses Clusters umschalten
 * und NIEMALS das Ein-/Ausklappen des Clusters auslösen (Checkbox + Klapp-
 * Button sind Geschwister, keine Verschachtelung).
 *
 * Abgedeckte Fälle:
 *   1. Klick auf die Cluster-Checkbox wählt GENAU die Rechnungen dieses
 *      Clusters aus (alle) — andere Cluster bleiben unberührt.
 *   2. Der Klick löst das Ein-/Ausklappen NICHT aus (aria-expanded und die
 *      sichtbaren Zeilen bleiben unverändert).
 *   3. Erneuter Klick wählt exakt diesen Cluster wieder ab (teils/keine
 *      korrekt abgeleitet).
 *   4. Auch bei einem eingeklappten Cluster klappt der Checkbox-Klick nicht
 *      auf.
 */

const BASE_INVOICE: Omit<InvoiceItem, "id" | "invoiceNumber" | "status" | "billingType"> = {
  customerId: 1,
  invoiceType: "rechnung",
  billingMonth: 1,
  billingYear: 2026,
  recipientName: "Empfänger",
  customerName: "Kunde",
  customerVorname: "Max",
  customerNachname: "Muster",
  netAmountCents: 1000,
  vatAmountCents: 0,
  grossAmountCents: 1000,
  vatRate: 0,
  sentAt: null,
  dueDate: null,
  pdfPath: "/objects/invoices/x.pdf",
  createdAt: "2026-01-10T00:00:00.000Z",
  billingRunId: null,
  budgetType: null,
};

function makeInvoice(overrides: Partial<InvoiceItem> & { id: number }): InvoiceItem {
  return {
    ...BASE_INVOICE,
    invoiceNumber: `RE-${overrides.id}`,
    status: "entwurf",
    billingType: "selbstzahler",
    ...overrides,
  };
}

// Stub-Mutationen: InvoiceRow liest beim Rendern nur `.isPending` / `.mutate`.
const stubMutation = { isPending: false, mutate: vi.fn() } as unknown as UseMutationResult<
  never,
  Error,
  never,
  unknown
>;

/**
 * Zustands-Wrapper: hält `selectedIds` wie die echte Billing-Seite, damit die
 * Checkbox-Zustände (checked/indeterminate) sich beim Klick tatsächlich
 * aktualisieren und assertierbar sind.
 */
function Harness({ invoices }: { invoices: InvoiceItem[] }) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  return (
    <InvoiceList
      invoices={invoices}
      invoicesLoading={false}
      expandedInvoiceId={null}
      onToggleDetail={vi.fn()}
      expandedDetail={null}
      detailLoading={false}
      deliveryHistory={undefined}
      sendingInvoiceId={null}
      sendInvoiceMutation={stubMutation}
      markSentMutation={stubMutation}
      statusMutation={stubMutation as never}
      onStorno={vi.fn()}
      onMarkPaid={vi.fn()}
      selectedIds={selectedIds}
      onToggleSelect={(id, checked) =>
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (checked) next.add(id);
          else next.delete(id);
          return next;
        })
      }
      onToggleSelectAll={(checked) =>
        setSelectedIds(checked ? new Set(invoices.map((i) => i.id)) : new Set())
      }
      onToggleSelectCluster={(ids, checked) =>
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) {
            if (checked) next.add(id);
            else next.delete(id);
          }
          return next;
        })
      }
      onBulkDelete={vi.fn()}
      onBulkStatus={vi.fn()}
      onBulkPrint={vi.fn()}
      bulkPrintPending={false}
      singlePdfExportPending={false}
      bulkActionPending={false}
      bulkActionProgress={null}
    />
  );
}

function renderList(invoices: InvoiceItem[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router>
        <Harness invoices={invoices} />
      </Router>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Rechnungsliste — Cluster-Auswahl-Checkbox (Task #1632)", () => {
  it("Klick auf die Cluster-Checkbox wählt genau diesen Cluster aus, ohne einen anderen zu berühren", () => {
    // Zwei Rechnungen im expandierten Cluster „zu_versenden" (Entwurf), eine
    // im Cluster „zahlung_ausstehend" (versendet).
    //
    // Vorher war die dritte im Cluster „avis_ausstehend" — den gibt es seit
    // dem Status-Umbau nicht mehr: Kasse und Selbstzahler warten beide auf
    // Zahlung, der Avis ist eine Zuordnungs-Mechanik. Die Aussage des Tests
    // ist davon unberuehrt: ein Cluster-Klick darf keinen anderen anfassen.
    const inv1 = makeInvoice({ id: 101, status: "entwurf", billingType: "selbstzahler" });
    const inv2 = makeInvoice({ id: 102, status: "entwurf", billingType: "selbstzahler" });
    const invOther = makeInvoice({
      id: 201,
      status: "versendet",
      billingType: "pflegekasse_gesetzlich",
      sentAt: "2026-01-15T00:00:00.000Z",
    });
    renderList([inv1, inv2, invOther]);

    const clusterCheckbox = screen.getByTestId("checkbox-select-cluster-zu_versenden");
    // Vorher: nichts ausgewählt.
    expect(clusterCheckbox.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(clusterCheckbox);

    // Genau die zwei Rechnungen dieses Clusters sind ausgewählt.
    expect(screen.getByTestId("text-selection-count").textContent).toContain("2 ausgewählt");
    expect(screen.getByTestId("checkbox-select-cluster-zu_versenden").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("checkbox-select-101").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("checkbox-select-102").getAttribute("aria-checked")).toBe("true");

    // Der andere Cluster bleibt unberührt.
    expect(screen.getByTestId("checkbox-select-cluster-zahlung_ausstehend").getAttribute("aria-checked")).toBe("false");
  });

  it("Klick auf die Cluster-Checkbox löst das Ein-/Ausklappen NICHT aus", () => {
    const inv1 = makeInvoice({ id: 111, status: "entwurf" });
    const inv2 = makeInvoice({ id: 112, status: "entwurf" });
    renderList([inv1, inv2]);

    const toggleButton = screen.getByTestId("button-cluster-toggle-zu_versenden");
    // Standard: Cluster ist aufgeklappt, Zeilen sichtbar.
    expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("invoice-row-111")).toBeTruthy();
    expect(screen.getByTestId("invoice-row-112")).toBeTruthy();

    fireEvent.click(screen.getByTestId("checkbox-select-cluster-zu_versenden"));

    // Auswahl erfolgt, aber der Cluster bleibt aufgeklappt (kein Toggle).
    expect(screen.getByTestId("button-cluster-toggle-zu_versenden").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("invoice-row-111")).toBeTruthy();
    expect(screen.getByTestId("invoice-row-112")).toBeTruthy();
  });

  it("Erneuter Klick wählt exakt diesen Cluster wieder ab", () => {
    const inv1 = makeInvoice({ id: 121, status: "entwurf" });
    const inv2 = makeInvoice({ id: 122, status: "entwurf" });
    renderList([inv1, inv2]);

    const checkbox = () => screen.getByTestId("checkbox-select-cluster-zu_versenden");
    fireEvent.click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("true");

    fireEvent.click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("text-selection-count")).toBeNull();
    expect(screen.getByTestId("checkbox-select-121").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("checkbox-select-122").getAttribute("aria-checked")).toBe("false");
  });

  it("Teil-Auswahl innerhalb eines Clusters führt zu 'indeterminate'", () => {
    const inv1 = makeInvoice({ id: 131, status: "entwurf" });
    const inv2 = makeInvoice({ id: 132, status: "entwurf" });
    renderList([inv1, inv2]);

    // Nur eine der beiden Rechnungen einzeln auswählen.
    fireEvent.click(screen.getByTestId("checkbox-select-131"));

    const clusterCheckbox = screen.getByTestId("checkbox-select-cluster-zu_versenden");
    expect(clusterCheckbox.getAttribute("aria-checked")).toBe("mixed");
  });

  it("Bei eingeklapptem Cluster klappt der Checkbox-Klick den Cluster nicht auf", () => {
    // „abgeschlossen" (bezahlt) ist standardmäßig eingeklappt.
    const paid = makeInvoice({ id: 141, status: "bezahlt", billingType: "selbstzahler" });
    renderList([paid]);

    const toggle = screen.getByTestId("button-cluster-toggle-abgeschlossen");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Eingeklappt ⇒ keine Zeile gerendert.
    expect(screen.queryByTestId("invoice-row-141")).toBeNull();

    fireEvent.click(screen.getByTestId("checkbox-select-cluster-abgeschlossen"));

    // Ausgewählt, aber weiterhin eingeklappt.
    expect(screen.getByTestId("checkbox-select-cluster-abgeschlossen").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("button-cluster-toggle-abgeschlossen").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("invoice-row-141")).toBeNull();
  });
});
