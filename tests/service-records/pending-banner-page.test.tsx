// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MonthlyServiceRecord } from "../../shared/schema";

let mockSearch = "";

vi.mock("wouter", () => ({
  Link: ({ children, href, ...props }: any) =>
    React.createElement("a", { href, ...props }, children),
  useLocation: () => ["/", vi.fn()],
  useSearch: () => mockSearch,
}));

vi.mock("@/components/layout", () => ({
  Layout: ({ children }: any) =>
    React.createElement("div", { "data-testid": "layout" }, children),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: 1, role: "employee" } }),
}));

vi.mock("@/hooks/use-view-as-employee", () => ({
  useViewAsEmployee: () => ({ viewAsEmployeeId: null }),
}));

vi.mock("@/lib/api/client", () => ({
  api: { get: vi.fn(async () => ({ ok: true, data: [] })), post: vi.fn() },
  unwrapResult: (r: any) => (r && "data" in r ? r.data : []),
}));

// Radix-UI components used by Sheet/Select rely on ResizeObserver, which jsdom does not provide.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? RO;

import ServiceRecordsPage from "../../client/src/pages/service-records";

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

// Die Seite leitet selectedYear/selectedMonth aus `window.location.search` ab
// (nicht aus dem gemockten wouter-`useSearch`); in jsdom ist die URL leer, also
// fällt sie auf den AKTUELLEN Monat zurück. Der Records-Query-Key enthält genau
// diesen Monat — pre-seeden wir mit einem festen Monat (z. B. Mai), greift am
// Monatsersten anderer Monate (z. B. 1. Juni) der Cache nicht, der Query bleibt
// ohne queryFn ewig pending und die Seite zeigt nur den Loader statt des Banners
// (Task #894). Wir pre-seeden daher mit dem aktuellen Monat.
const NOW = new Date();
const CURRENT_YEAR = NOW.getFullYear();
const CURRENT_MONTH = NOW.getMonth() + 1;

function renderPage({
  search,
  selectedYear,
  selectedMonth,
  customerIdForCacheKey,
}: {
  search: string;
  selectedYear: number;
  selectedMonth: number;
  customerIdForCacheKey: number | null;
}) {
  mockSearch = search;
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });

  // Pre-seed the cache as if the user had previously visited the overview page,
  // which loaded a foreign customer's pending record into the cross-customer cache.
  qc.setQueryData(["/api/service-records/pending", null], [foreignPending]);

  // Pre-seed the per-page month list so the page exits its isLoading branch
  // and actually renders the banner section under test.
  qc.setQueryData(
    [
      "/api/service-records",
      selectedYear,
      selectedMonth,
      customerIdForCacheKey,
      null,
    ],
    [],
  );

  // Pre-seed the overview list (only used when customerId is null) so the overview branch
  // does not flicker through a loader.
  qc.setQueryData(
    ["/api/service-records/overview", selectedYear, selectedMonth, null],
    [],
  );

  // Pre-seed the period check (only used when customerId is set) so the customer branch renders.
  if (customerIdForCacheKey !== null) {
    qc.setQueryData(
      [
        "/api/service-records/check-period",
        customerIdForCacheKey,
        selectedYear,
        selectedMonth,
        null,
      ],
      {
        existingRecord: null,
        documentedCount: 0,
        undocumentedCount: 0,
        coveredBySingleCount: 0,
        coveredByMonthlyCount: 0,
        uncoveredDocumentedCount: 0,
        canCreateRecord: false,
      },
    );
    // Selected customer (so the title doesn't crash)
    qc.setQueryData(["customer", customerIdForCacheKey], {
      id: customerIdForCacheKey,
      vorname: "Marvin",
      nachname: "Schröder",
    });
  }

  return render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(ServiceRecordsPage),
    ),
  );
}

beforeEach(() => {
  mockSearch = "";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ServiceRecordsPage — pending banner is suppressed on customer pages (Task #581)", () => {
  it("does NOT render banner-pending on a customer page even when the query cache holds another customer's pending record", () => {
    renderPage({
      search: "customerId=100",
      selectedYear: CURRENT_YEAR,
      selectedMonth: CURRENT_MONTH,
      customerIdForCacheKey: 100,
    });
    expect(screen.queryByTestId("banner-pending")).toBeNull();
  });

  it("DOES render banner-pending on the overview page (no customerId) with the same cached pending record", () => {
    renderPage({
      search: "",
      selectedYear: CURRENT_YEAR,
      selectedMonth: CURRENT_MONTH,
      customerIdForCacheKey: null,
    });
    expect(screen.getByTestId("banner-pending")).toBeTruthy();
  });
});
