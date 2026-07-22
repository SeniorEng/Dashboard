// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Task #738 / Task #1828 — Banner-Sichtbarkeit „Budget-Töpfe noch nicht
// eingerichtet" gegen Regression absichern. Spiegelt die Aktivierungs-SSoT
// (`hasActiveBudgetPot` / `computeBudgetSetupMarkers`, server/routes/admin/
// customers.ts) im UI:
//   1. Selbstzahler → kein Banner, kein API-Call (kein Anspruch).
//   2. Pflegekasse ohne AKTIVEN Topf (§45b bewusst deaktiviert, kein anderer
//      aktiver Topf) → Banner sichtbar.
//   3. Pflegekasse mit aktivem Topf (default-aktiver §45b, enabled=true) →
//      kein Banner — auch ohne persistierte Zeile (id=null).
//   4. Nach Save (Cache-Invalidierung) wechselt der Banner von sichtbar
//      → unsichtbar, sobald `/budget/:id/type-settings` einen aktiven Topf
//      liefert.
//
// Task #1828-Kern: Der Banner darf NICHT mehr auf „persistierte Zeile
// existiert" (id != null) prüfen — der Server liefert für default-aktiven §45b
// bereits `enabled: true` mit id=null. Aktiv = offene Zeile (validTo=null) mit
// enabled=true, identisch zur Server-SSoT.

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

// Kein aktiver Topf: §45b bewusst deaktiviert (offene Zeile enabled=false),
// §45a/§39 default-aus. Das ist der EINZIGE Fall, in dem der Banner noch feuert.
const NO_ACTIVE_POT = [
  { id: 91, budgetType: "entlastungsbetrag_45b", enabled: false, validTo: null },
  { id: null, budgetType: "umwandlung_45a", enabled: false, validTo: null },
  { id: null, budgetType: "ersatzpflege_39_42a", enabled: false, validTo: null },
];

// Default-aktiver §45b OHNE persistierte Zeile (id=null): so liefert der Server
// (GET type-settings via effectiveDefaultPots) einen normalen Pflegekassen-Kunden.
// Aktiv ⇒ KEIN Banner (Task #1828: id-Existenz ist irrelevant, enabled zählt).
const DEFAULT_ACTIVE_45B = [
  { id: null, budgetType: "entlastungsbetrag_45b", enabled: true, validTo: null },
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

describe("BudgetSetupRequiredBanner (Task #738 / Task #1828)", () => {
  it("Pfad 1: Selbstzahler → kein Banner, kein API-Call auf type-settings", async () => {
    renderBanner({ billingType: "selbstzahler", pflegegrad: 4 });
    // Mikro-Tick, falls der QueryClient async startet.
    await Promise.resolve();
    expect(screen.queryByTestId("banner-budget-setup-required")).toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("Task #1828: Pflegekasse + PG1 mit default-aktivem §45b → kein Banner (§45b gilt ab PG1)", async () => {
    // Früher: PG1 wurde per pflegegrad>=2-Gate hart ausgeblendet (kein API-Call).
    // Jetzt entscheidet die Aktivierungs-SSoT: §45b ist default-aktiv ⇒ kein
    // Banner. Der API-Call findet nun statt (kein Pflegegrad-Gate mehr).
    apiGetMock.mockResolvedValue({ ok: true, data: DEFAULT_ACTIVE_45B });
    renderBanner({ billingType: "pflegekasse_gesetzlich", pflegegrad: 1 });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("banner-budget-setup-required")).toBeNull();
  });

  it("Task #1828 (Kern-Regression): Pflegekasse + PG4 mit default-aktivem §45b (id=null) → kein Banner", async () => {
    // Reproduziert den Bug (Kunde Ullrich Bauer): §45b ist aktiv (enabled=true),
    // hat aber keine persistierte Zeile (id=null). Der Banner darf NICHT mehr
    // feuern, nur weil keine DB-Zeile existiert.
    apiGetMock.mockResolvedValue({ ok: true, data: DEFAULT_ACTIVE_45B });
    renderBanner({ billingType: "pflegekasse_gesetzlich", pflegegrad: 4 });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("banner-budget-setup-required")).toBeNull();
  });

  it("Pfad 2: Pflegekasse ohne aktiven Topf (§45b deaktiviert) → Banner sichtbar, Button löst onSetup aus", async () => {
    apiGetMock.mockResolvedValue({ ok: true, data: NO_ACTIVE_POT });
    const onSetup = vi.fn();
    renderBanner({ billingType: "pflegekasse_gesetzlich", pflegegrad: 4, onSetup });

    const banner = await screen.findByTestId("banner-budget-setup-required");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("Budget-Töpfe noch nicht eingerichtet");
    expect(apiGetMock).toHaveBeenCalledWith("/budget/4242/type-settings");

    fireEvent.click(screen.getByTestId("button-budget-setup-open"));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("Pfad 2: Pflegekasse_privat ohne aktiven Topf → Banner sichtbar (gleicher Vertrag wie gesetzlich)", async () => {
    apiGetMock.mockResolvedValue({ ok: true, data: NO_ACTIVE_POT });
    renderBanner({ billingType: "pflegekasse_privat", pflegegrad: 2 });

    const banner = await screen.findByTestId("banner-budget-setup-required");
    expect(banner).toBeTruthy();
  });

  it("Pfad 3: Pflegekasse mit aktiver persistierter Zeile (id!=null, validTo=null) → kein Banner", async () => {
    apiGetMock.mockResolvedValue({ ok: true, data: ACTIVE_ROWS });
    renderBanner({ billingType: "pflegekasse_gesetzlich", pflegegrad: 4 });

    // Warten, bis die Query fertig ist; danach darf der Banner nicht
    // auftauchen. `waitFor` mit not-Assertion stellt sicher, dass wir nicht
    // einfach den initial-leeren Render erwischen.
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("banner-budget-setup-required")).toBeNull();
  });

  it("Pfad 3 (Drift-Wächter): aktive §45b-Zeile MIT validTo zählt nicht als aktiv → Banner muss bleiben", async () => {
    // Eine geschlossene Zeile (validTo gesetzt) ist nicht wirksam; da hier auch
    // KEINE offene default-aktive §45b-Zeile geliefert wird (der Server würde
    // stattdessen die geschlossene Zeile zeigen), bleibt der Banner. Verhindert,
    // dass jemand den Aktiv-Check auf `enabled` allein (ohne validTo) verkürzt.
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
    // 1. Render: kein aktiver Topf (§45b deaktiviert) → Banner sichtbar.
    apiGetMock.mockResolvedValueOnce({ ok: true, data: NO_ACTIVE_POT });
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
