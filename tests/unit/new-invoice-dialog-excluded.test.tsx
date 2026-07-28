// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { BillingInvoicePreview } from "@shared/api";
import { NewInvoiceDialog } from "@/features/billing/components/new-invoice-dialog";

/**
 * Task #1869 — Der „Neue Rechnung erstellen"-Dialog muss bei einer Null-/Teil-
 * Summe konkret erklären, WARUM dokumentierte Termine nicht abgerechnet werden
 * (fehlende Kundenunterschrift vs. bereits abgerechnet) und die betroffenen
 * Termine nennen. Wortlaut aus derselben SSoT (`BILLING_BLOCK_SHORT_LABELS`)
 * wie die Kundenzeile der Karte „Noch zu erstellen".
 */

const BASE_PREVIEW: BillingInvoicePreview = {
  serviceRecordCount: 1,
  coveredAppointments: 1,
  completedAppointments: 4,
  alreadyBilledAppointments: 0,
  totalCents: 0,
  splitInvoices: false,
  splitPots: [],
  excludedAppointments: [],
};

function Harness({ preview }: { preview: BillingInvoicePreview }) {
  const mutation = { mutate: vi.fn(), isPending: false } as never;
  return (
    <NewInvoiceDialog
      open
      setOpen={vi.fn()}
      setSelectedCustomerId={vi.fn()}
      customers={[]}
      selectedCustomerId="1"
      selectedMonth={5}
      selectedYear={2026}
      previewCustomerId={1}
      invoicePreview={preview}
      previewLoading={false}
      previewError={false}
      previewErrorObj={null}
      blockingDrafts={[]}
      onDiscardClick={vi.fn()}
      discardDraftsMutation={mutation}
      generateMutation={mutation}
      onGenerate={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NewInvoiceDialog — Erklärung der Null-/Teil-Summe (Task #1869)", () => {
  it("nennt fehlende Kundenunterschrift mit betroffenen Terminen bei Null-Summe", () => {
    render(
      <Harness
        preview={{
          ...BASE_PREVIEW,
          excludedAppointments: [
            { date: "2026-05-20", reason: "customer_signature_required" },
            { date: "2026-05-06", reason: "customer_signature_required" },
          ],
        }}
      />,
    );

    const block = screen.getByTestId("block-excluded-customer_signature_required");
    expect(block.textContent).toContain("Kundenunterschrift fehlt");
    // Datumsangaben aufsteigend sortiert.
    expect(block.textContent).toContain("06.05.2026");
    expect(block.textContent).toContain("20.05.2026");
    expect(block.textContent?.indexOf("06.05.2026")).toBeLessThan(
      block.textContent?.indexOf("20.05.2026") ?? -1,
    );
  });

  it("unterscheidet „bereits abgerechnet“ von fehlender Unterschrift", () => {
    render(
      <Harness
        preview={{
          ...BASE_PREVIEW,
          coveredAppointments: 1,
          alreadyBilledAppointments: 1,
          excludedAppointments: [
            { date: "2026-05-06", reason: "customer_signature_required" },
            { date: "2026-05-10", reason: "already_billed" },
          ],
        }}
      />,
    );

    expect(
      screen.getByTestId("block-excluded-customer_signature_required").textContent,
    ).toContain("Kundenunterschrift fehlt");
    expect(
      screen.getByTestId("block-excluded-already_billed").textContent,
    ).toContain("Bereits abgerechnet");
  });

  it("zeigt bei „alles bereits abgerechnet + weitere ohne Unterschrift“ die Aufschlüsselung statt generischer Meldung (Task #1881)", () => {
    render(
      <Harness
        preview={{
          ...BASE_PREVIEW,
          // Nichts abrechenbar (0 abgedeckt ⇒ Summe 0 €), aber es GIBT dokumentierte
          // Termine: einer bereits abgerechnet, zwei warten auf Kundenunterschrift.
          coveredAppointments: 0,
          completedAppointments: 3,
          alreadyBilledAppointments: 1,
          totalCents: 0,
          excludedAppointments: [
            { date: "2026-05-04", reason: "already_billed" },
            { date: "2026-05-06", reason: "customer_signature_required" },
            { date: "2026-05-20", reason: "customer_signature_required" },
          ],
        }}
      />,
    );

    // Konkrete Aufschlüsselung beider Gründe (keine generische Einzelmeldung).
    expect(
      screen.getByTestId("block-excluded-customer_signature_required").textContent,
    ).toContain("Kundenunterschrift fehlt");
    expect(
      screen.getByTestId("block-excluded-already_billed").textContent,
    ).toContain("Bereits abgerechnet");
    // Kein leerer Lauf: „Rechnung erstellen" ist deaktiviert, wenn nichts abrechenbar ist.
    expect(
      (screen.getByTestId("button-generate-invoice") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("zeigt keinen Erklär-Block, wenn alles dokumentierte abgerechnet wird", () => {
    render(
      <Harness
        preview={{
          ...BASE_PREVIEW,
          coveredAppointments: 4,
          completedAppointments: 4,
          totalCents: 12000,
          excludedAppointments: [],
        }}
      />,
    );

    expect(screen.queryByTestId("block-excluded-appointments")).toBeNull();
  });
});
