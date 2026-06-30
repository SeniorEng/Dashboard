// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

/**
 * Task #1512 — UI-Verteidigungslinie für die Lohn-/Personalkosten-Oberflächen.
 *
 * Serverseitig sind die lohn-tragenden Endpunkte superadmin-gegated
 * (`requireWageDataAccess`, siehe tests/security/wage-endpoints-superadmin-only.test.ts).
 * Dieser Test pinnt die ZWEITE Verteidigungslinie im Frontend: ein normaler
 * Admin bekommt die Lohn-Flächen gar nicht erst zu sehen, ein Superadmin schon.
 *
 * Abgedeckte Flächen:
 *   - SuperAdminRoute (Route-Guard für /admin/hours-overview + /admin/statistics/performance)
 *   - Cockpit-Kacheln „Geleistete Stunden" / „Ø Termine je Kunde" (Sprung auf die
 *     gesperrte Profitabilitäts-Seite)
 *   - Wirtschaftlicher Überblick (EconomicsOverviewCard) auf der Abrechnungsseite
 *     inkl. abgeschalteter Economics-Query für Nicht-Superadmins.
 */

let mockIsSuperAdmin = false;
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: 1, isAdmin: true, isSuperAdmin: mockIsSuperAdmin },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

beforeEach(() => {
  mockIsSuperAdmin = false;
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

// ---------------------------------------------------------------------------
// 1) SuperAdminRoute — Route-Guard der beiden Lohn-Seiten
// ---------------------------------------------------------------------------
describe("SuperAdminRoute — Route-Guard (Task #1512)", () => {
  it("Normaler Admin: geschützte Seite wird NICHT gerendert (Redirect)", async () => {
    mockIsSuperAdmin = false;
    const { SuperAdminRoute } = await import("@/components/route-guards");
    const Secret = () => <div data-testid="wage-page-content">Lohn-Inhalt</div>;
    const { hook } = memoryLocation({ path: "/admin/hours-overview" });

    render(
      <Router hook={hook}>
        <SuperAdminRoute component={Secret} />
      </Router>,
    );

    expect(screen.queryByTestId("wage-page-content")).toBeNull();
  });

  it("Superadmin: geschützte Seite wird gerendert", async () => {
    mockIsSuperAdmin = true;
    const { SuperAdminRoute } = await import("@/components/route-guards");
    const Secret = () => <div data-testid="wage-page-content">Lohn-Inhalt</div>;
    const { hook } = memoryLocation({ path: "/admin/hours-overview" });

    render(
      <Router hook={hook}>
        <SuperAdminRoute component={Secret} />
      </Router>,
    );

    expect(await screen.findByTestId("wage-page-content")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2) Cockpit — Sprung-Kacheln auf die Profitabilitäts-Seite
// ---------------------------------------------------------------------------
const kpi = (current = 0) => ({
  current,
  previous: null,
  deltaAbs: null,
  deltaPct: null,
  previousYear: null,
  deltaYearAbs: null,
  deltaYearPct: null,
});
const spark = () => [] as { period: string; value: number }[];

const COCKPIT = {
  period: { year: 2026, month: 6 },
  revenueByStage: { planned: kpi(), documented: kpi(), proven: kpi(), invoiced: kpi() },
  activeCustomers: kpi(),
  netCustomerGrowth: kpi(),
  totalMinutes: kpi(),
  minutesByServiceType: { hauswirtschaft: 0, alltagsbegleitung: 0, erstberatung: 0, sonstige: 0 },
  appointmentsPerCustomer: kpi(),
  revenuePerCustomer: kpi(),
  sparklines: {
    revenueDocumented: spark(),
    activeCustomers: spark(),
    totalMinutes: spark(),
    appointmentsPerCustomer: spark(),
    revenuePerCustomer: spark(),
  },
};

const HEALTH = {
  period: { year: 2026, month: 6 },
  customersWithoutEmployee: kpi(),
  customersWithoutAppointments: kpi(),
  undocumentedAppointments: kpi(),
  appointmentsWithoutRecord: kpi(),
  recordsWithoutInvoice: kpi(),
  total: kpi(),
  healthScore: "gruen" as const,
  thresholds: { yellow: 3, red: 6 },
  sparklines: {
    customersWithoutEmployee: spark(),
    customersWithoutAppointments: spark(),
    undocumentedAppointments: spark(),
    appointmentsWithoutRecord: spark(),
    recordsWithoutInvoice: spark(),
  },
};

vi.mock("@/lib/api/client", () => ({
  api: {
    get: vi.fn((path: string) => {
      if (path.includes("/statistics/v2/cockpit")) return Promise.resolve({ ok: true, data: COCKPIT });
      if (path.includes("/statistics/v2/process-health")) return Promise.resolve({ ok: true, data: HEALTH });
      if (path.includes("/statistics/v2/alerts")) return Promise.resolve({ ok: true, data: [] });
      return Promise.resolve({ ok: true, data: null });
    }),
  },
  unwrapResult: (r: { ok: boolean; data: unknown }) => {
    if (!r.ok) throw new Error("unwrap on error result");
    return r.data;
  },
}));

describe("Cockpit-Kacheln — Profitabilitäts-Sprung nur für Superadmin (Task #1512)", () => {
  async function renderCockpit() {
    const { CockpitV2Tab } = await import("@/pages/admin/statistics/v2/cockpit-v2-tab");
    return render(
      <QueryClientProvider client={makeQc()}>
        <Router>
          <CockpitV2Tab selectedYear={2026} selectedMonth="6" />
        </Router>
      </QueryClientProvider>,
    );
  }

  it("Normaler Admin: Stunden-/Termine-Kachel verlinken NICHT auf die Profitabilität", async () => {
    mockIsSuperAdmin = false;
    await renderCockpit();
    await screen.findByTestId("cockpit-v2-tiles");

    // Kacheln existieren, aber ohne klickbaren Link auf die gesperrte Seite.
    expect(screen.getByTestId("kpi-total-minutes")).toBeTruthy();
    expect(screen.getByTestId("kpi-appointments-per-customer")).toBeTruthy();
    expect(screen.queryByTestId("kpi-total-minutes-link")).toBeNull();
    expect(screen.queryByTestId("kpi-appointments-per-customer-link")).toBeNull();
  });

  it("Superadmin: Stunden-/Termine-Kachel verlinken auf die Profitabilität", async () => {
    mockIsSuperAdmin = true;
    await renderCockpit();
    await screen.findByTestId("cockpit-v2-tiles");

    expect(screen.getByTestId("kpi-total-minutes-link")).toBeTruthy();
    expect(screen.getByTestId("kpi-appointments-per-customer-link")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3) Abrechnungsseite — Wirtschaftlicher Überblick (EconomicsOverviewCard)
// ---------------------------------------------------------------------------
const useBillingEconomicsMock = vi.fn(() => ({ data: undefined, isLoading: false }));
const emptyList = () => ({ data: [], isLoading: false });
const noop = () => ({ data: undefined, isLoading: false, isError: false, error: null });
const stub = () => null;
const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });

vi.mock("@/components/layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/features/billing", () => ({
  useBillingInvoices: emptyList,
  useEligibleCustomers: emptyList,
  useInvoicePreview: noop,
  useBlockingDrafts: () => ({ data: undefined }),
  usePayers: () => ({ data: [] }),
  useInvoiceDetail: noop,
  useDeliveryHistory: () => ({ data: undefined }),
  useBillingPipeline: () => ({ data: undefined, isLoading: false }),
  useBillingEconomics: (...args: unknown[]) => useBillingEconomicsMock(...(args as [])),
  useBillingTermine: emptyList,
  useActiveEmployees: () => ({ data: [] }),
  useBillingMutations: () => ({
    generateMutation: mutation(),
    discardDraftsMutation: mutation(),
    statusMutation: mutation(),
    bulkDeleteMutation: mutation(),
    bulkStatusMutation: mutation(),
    sendInvoiceMutation: mutation(),
    markSentMutation: mutation(),
    generateAllMutation: mutation(),
    batchSendMutation: mutation(),
    bulkSendMutation: mutation(),
    bulkPrintPreviewMutation: mutation(),
    lexwareExportMutation: mutation(),
    sendingInvoiceId: null,
    batchSending: false,
    generateAllProgress: null,
    setGenerateAllProgress: vi.fn(),
    bulkSendResult: null,
    setBulkSendResult: vi.fn(),
    bulkActionProgress: null,
  }),
  BillingFilterBar: stub,
  EconomicsOverviewCard: () => <div data-testid="stub-economics-card">Wirtschaftlicher Überblick</div>,
  StatusPipelineCard: stub,
  TermineTab: stub,
  MissingSignaturesCard: stub,
  InvoiceList: stub,
  PendingInvoicesCard: stub,
  BulkSendDialog: stub,
  GenerateAllDialog: stub,
  NewInvoiceDialog: stub,
  StornoDialog: stub,
  MarkPaidDialog: stub,
  DiscardDraftsDialog: stub,
}));

describe("Abrechnung — Wirtschaftlicher Überblick nur für Superadmin (Task #1512)", () => {
  async function renderBilling() {
    const AdminBilling = (await import("@/pages/admin/billing")).default;
    return render(
      <QueryClientProvider client={makeQc()}>
        <Router>
          <AdminBilling />
        </Router>
      </QueryClientProvider>,
    );
  }

  it("Normaler Admin: keine Economics-Karte + Economics-Query disabled", async () => {
    mockIsSuperAdmin = false;
    await renderBilling();

    await waitFor(() => expect(useBillingEconomicsMock).toHaveBeenCalled());
    expect(screen.queryByTestId("stub-economics-card")).toBeNull();
    // Letztes Argument der Economics-Query ist das enabled-Flag = isSuperAdmin.
    const lastCall = useBillingEconomicsMock.mock.calls.at(-1) as unknown[];
    expect(lastCall.at(-1)).toBe(false);
  });

  it("Superadmin: Economics-Karte sichtbar + Economics-Query enabled", async () => {
    mockIsSuperAdmin = true;
    await renderBilling();

    expect(await screen.findByTestId("stub-economics-card")).toBeTruthy();
    const lastCall = useBillingEconomicsMock.mock.calls.at(-1) as unknown[];
    expect(lastCall.at(-1)).toBe(true);
  });
});
