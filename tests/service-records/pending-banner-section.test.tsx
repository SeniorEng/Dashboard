// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PendingBannerSection } from "../../client/src/features/service-records/pending-banner-section";
import type { MonthlyServiceRecord } from "../../shared/schema";

afterEach(cleanup);

function makeRecord(overrides: Partial<MonthlyServiceRecord>): MonthlyServiceRecord {
  return {
    id: 1,
    customerId: 100,
    employeeId: 1,
    year: 2026,
    month: 3,
    status: "pending_signature",
    ...overrides,
  } as unknown as MonthlyServiceRecord;
}

const foreignPending = makeRecord({ id: 42, customerId: 999, year: 2026, month: 3 });

describe("PendingBannerSection — customer-scoped pages must not show foreign pending banners (Task #581)", () => {
  it("does NOT render the banner on a customer page even when the query cache still holds another customer's pending record", () => {
    const onSingle = vi.fn();
    const onMulti = vi.fn();
    render(
      <PendingBannerSection
        pendingRecords={[foreignPending]}
        selectedYear={2026}
        selectedMonth={5}
        customerId={100}
        onSingleClick={onSingle}
        onMultiClick={onMulti}
        renderSingleLabel={() => <span data-testid="label">Kunde</span>}
      />,
    );
    expect(screen.queryByTestId("banner-pending")).toBeNull();
    expect(screen.queryByTestId("label")).toBeNull();
  });

  it("renders the banner on the overview page (no customerId) when a pending record sits outside the selected month", () => {
    render(
      <PendingBannerSection
        pendingRecords={[foreignPending]}
        selectedYear={2026}
        selectedMonth={5}
        customerId={null}
        onSingleClick={() => {}}
        onMultiClick={() => {}}
        renderSingleLabel={() => <span data-testid="label">Foreign Kunde</span>}
      />,
    );
    const banner = screen.getByTestId("banner-pending");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("1 Leistungsnachweis offen");
    expect(screen.getByTestId("label")).toBeTruthy();
  });

  it("hides the banner on the overview page when the pending record's customer is already surfaced in an awaiting-signature overview group (Task #718)", () => {
    render(
      <PendingBannerSection
        pendingRecords={[foreignPending]}
        selectedYear={2026}
        selectedMonth={3}
        customerId={null}
        overview={[
          {
            customerId: 999,
            undocumentedCount: 0,
            uncoveredDocumentedCount: 0,
            // Seit #1914 entscheidet der NACHWEIS, nicht der Kunde: das Banner
            // blendet genau die Nachweise aus, die der Abschnitt als Karte zeigt.
            monthlyRecords: [{ id: 42, status: "pending" }],
          },
        ]}
        onSingleClick={() => {}}
        onMultiClick={() => {}}
        renderSingleLabel={() => null}
      />,
    );
    expect(screen.queryByTestId("banner-pending")).toBeNull();
  });

  it("STILL renders the banner on the overview page when overview data is not yet loaded — no open record may disappear (Task #718)", () => {
    render(
      <PendingBannerSection
        pendingRecords={[foreignPending]}
        selectedYear={2026}
        selectedMonth={3}
        customerId={null}
        onSingleClick={() => {}}
        onMultiClick={() => {}}
        renderSingleLabel={() => <span data-testid="label">x</span>}
      />,
    );
    expect(screen.getByTestId("banner-pending")).toBeTruthy();
  });
});
