// @ts-nocheck
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Task #738 — Banner-Sichtbarkeit „Budget-Töpfe noch nicht eingerichtet"
// gegen Regression absichern. Spiegelt die vier Pfade aus
// `computeBudgetSetupMarkers` (server/routes/admin/customers.ts) im UI:
//   1. Selbstzahler / PG<2  → kein Banner, kein API-Call.
//   2. Pflegekasse + PG≥2 ohne aktive Topf-Zeile → Banner sichtbar.
//   3. Pflegekasse + PG≥2 mit aktiver Topf-Zeile → kein Banner.
//   4. Nach Save (Cache-Invalidierung) wechselt der Banner von sichtbar
//      → unsichtbar, sobald `/budget/:id/type-settings` eine aktive Zeile
//      liefert.
//
// Hintergrund: die Default-Response von `GET /api/budget/:customerId/type-
// settings` liefert für nicht-konfigurierte Kunden Platzhalter mit `id=null`.
// Würde ein Refactor die Platzhalter mit einer echten id befüllen, fiele
// der Banner unbemerkt dauerhaft weg — dieser Test fixiert den Vertrag.

type ApiResult<T> = { ok: true; data: T } | { ok: false; data: null };

const apiGetMock = vi.fn<(path: string) => Promise<ApiResult<unknown>>>();

vi.mock("@/lib/api/client", () => ({
  api: {
    get: (path: string) => apiGetMock(path),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  unwrapResult: (r: ApiResult<unknown>) => {
    if (!r.ok) throw new Error("unwrap on error result");
    return r.data;
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { BudgetSetupRequiredBanner } from "@/features/customers/components/admin/customer-detail-sections";

const DEFAULT_PLACEHOLDERS = [
  { id: null, budgetType: "entlastungsbetrag_45b", enabled: false, validTo: null },
  { id: null, budgetType: "umwandlung_45a", enabled: false, validTo: null },
  { id: null, budgetType: "ersatzpflege_39_42a", enabled: false, validTo: null },
];

const ACTIVE_ROWS = [
  { id: 77, budgetType: "entlastungsbetrag_45b", enabled: true, validTo: null },
  { id: null, budgetType: "umwandlung_45a", enabled: false, validTo: null },
  { id: null, budgetType: "ersatzpflege_39_42a", enabled: false, validTo: null },
];

function renderBanner(props: {
  customerId?: number;
  billingType: string | null;
  pflegegrad: number | null;
  onSetup?: () => void;
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const customerId = props.customerId ?? 4242;
  const onSetup = props.onSetup ?? vi.fn();
  const utils = render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(BudgetSetupRequiredBanner, {
        customerId,
        billingType: props.billingType as any,
        pflegegrad: props.pflegegrad,
        onSetup,
      }),
    ),
  );
  return { qc, customerId, onSetup, ...utils };
}

afterEach(() => {
  cleanup();
  apiGetMock.mockReset();
});

describe("BudgetSetupRequiredBanner (Task #738)", () => {
  it("Pfad 1: Selbstzahler → kein Banner, kein API-Call auf type-settings", async () => {
    renderBanner({ billingType: "selbstzahler", pflegegrad: 4 });
    // Mikro-Tick, falls der QueryClient async startet.
    await Promise.resolve();
    expect(screen.queryByTestId("banner-budget-setup-required")).toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("Pfad 1: Pflegekasse + PG1 → kein Banner, kein API-Call (kein Anspruch auf §45a)", async () => {
    renderBanner({ billingType: "pflegekasse_gesetzlich", pflegegrad: 1 });
    await Promise.resolve();
    expect(screen.queryByTestId("banner-budget-setup-required")).toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("Pfad 2: Pflegekasse + PG≥2 ohne aktive Zeile → Banner sichtbar, Button löst onSetup aus", async () => {
    apiGetMock.mockResolvedValue({ ok: true, data: DEFAULT_PLACEHOLDERS });
    const onSetup = vi.fn();
    renderBanner({ billingType: "pflegekasse_gesetzlich", pflegegrad: 4, onSetup });

    const banner = await screen.findByTestId("banner-budget-setup-required");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("Budget-Töpfe noch nicht eingerichtet");
    expect(apiGetMock).toHaveBeenCalledWith("/budget/4242/type-settings");

    fireEvent.click(screen.getByTestId("button-budget-setup-open"));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("Pfad 2: Pflegekasse_privat + PG2 ohne aktive Zeile → Banner sichtbar (gleicher Vertrag wie gesetzlich)", async () => {
    apiGetMock.mockResolvedValue({ ok: true, data: DEFAULT_PLACEHOLDERS });
    renderBanner({ billingType: "pflegekasse_privat", pflegegrad: 2 });

    const banner = await screen.findByTestId("banner-budget-setup-required");
    expect(banner).toBeTruthy();
  });

  it("Pfad 3: Pflegekasse + PG≥2 mit aktiver Zeile (id!=null, validTo=null) → kein Banner", async () => {
    apiGetMock.mockResolvedValue({ ok: true, data: ACTIVE_ROWS });
    renderBanner({ billingType: "pflegekasse_gesetzlich", pflegegrad: 4 });

    // Warten, bis die Query fertig ist; danach darf der Banner nicht
    // auftauchen. `waitFor` mit not-Assertion stellt sicher, dass wir nicht
    // einfach den initial-leeren Render erwischen.
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("banner-budget-setup-required")).toBeNull();
  });

  it("Pfad 3 (Drift-Wächter): aktive Zeile MIT validTo zählt nicht als aktiv → Banner muss bleiben", async () => {
    // Verhindert, dass jemand den Aktiv-Check auf `id != null` allein
    // verkürzt: eine geschlossene Zeile (validTo gesetzt) darf den Banner
    // nicht unterdrücken, sonst driftet das UI vom Server-Marker weg.
    apiGetMock.mockResolvedValue({
      ok: true,
      data: [
        { id: 11, budgetType: "entlastungsbetrag_45b", enabled: true, validTo: "2025-12-31" },
        { id: null, budgetType: "umwandlung_45a", enabled: false, validTo: null },
        { id: null, budgetType: "ersatzpflege_39_42a", enabled: false, validTo: null },
      ],
    });
    renderBanner({ billingType: "pflegekasse_gesetzlich", pflegegrad: 3 });
    expect(await screen.findByTestId("banner-budget-setup-required")).toBeTruthy();
  });

  it("Pfad 4: Banner verschwindet nach Save + Query-Invalidierung", async () => {
    // 1. Render: noch keine Zeile → Banner sichtbar.
    apiGetMock.mockResolvedValueOnce({ ok: true, data: DEFAULT_PLACEHOLDERS });
    // 2. Render nach Invalidate: aktive Zeile → Banner muss weg.
    apiGetMock.mockResolvedValueOnce({ ok: true, data: ACTIVE_ROWS });

    const { qc, customerId } = renderBanner({
      billingType: "pflegekasse_gesetzlich",
      pflegegrad: 4,
    });

    expect(await screen.findByTestId("banner-budget-setup-required")).toBeTruthy();

    // Simuliert das, was BudgetTypeSettings nach erfolgreichem Save tut:
    // die Query für diesen Kunden invalidieren.
    await qc.invalidateQueries({ queryKey: ["budget-type-settings", customerId] });

    await waitFor(() =>
      expect(screen.queryByTestId("banner-budget-setup-required")).toBeNull(),
    );
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });
});
