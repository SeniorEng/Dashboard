import { describe, it, expect, vi } from "vitest";
import {
  isActionableDraft,
  isBulkActionableDraft,
  isPflegekasseBatchDraft,
  type BillingDraftLike,
} from "@shared/domain/billing-drafts";
import { invalidateRelated } from "../../client/src/lib/query-invalidation";

/**
 * Task #1198 Regressionstest.
 *
 * (a) Storno-Belege (`invoiceType="stornorechnung"`, `status="entwurf"`) dürfen
 *     NICHT in den Bulk-Send-/Bulk-Print-/Pflegekassen-Zählern bzw. -Mengen
 *     auftauchen.
 * (b) Eine Billing-Mutation muss die `eligible-customers`- und `payers`-Caches
 *     invalidieren, damit die „Alle offenen erstellen (N)"-Zahl und das
 *     Kassen-Dropdown sofort aktualisiert werden.
 */

function draft(overrides: Partial<BillingDraftLike>): BillingDraftLike {
  return {
    status: "entwurf",
    invoiceType: "rechnung",
    billingType: "selbstzahler",
    ...overrides,
  };
}

describe("Task #1198 (a): Storno-Belege fallen aus den Massen-Aktionen", () => {
  it("schließt Storno-Entwürfe aus dem typenübergreifenden Bulk-Set aus", () => {
    const stornoSelbstzahler = draft({ invoiceType: "stornorechnung", billingType: "selbstzahler" });
    const stornoKasse = draft({ invoiceType: "stornorechnung", billingType: "pflegekasse_gesetzlich" });
    const stornoPrivat = draft({ invoiceType: "stornorechnung", billingType: "pflegekasse_privat" });

    expect(isBulkActionableDraft(stornoSelbstzahler)).toBe(false);
    expect(isBulkActionableDraft(stornoKasse)).toBe(false);
    expect(isBulkActionableDraft(stornoPrivat)).toBe(false);
  });

  it("schließt Storno-Entwürfe aus dem Pflegekassen-Stapellauf aus", () => {
    const stornoKasse = draft({ invoiceType: "stornorechnung", billingType: "pflegekasse_gesetzlich" });
    expect(isPflegekasseBatchDraft(stornoKasse)).toBe(false);
  });

  it("zählt bei vollständig stornierten Rechnungen 0 (Liste leer == Zähler 0)", () => {
    // Original-Rechnungen sind storniert; pro Stornierung entsteht ein
    // Storno-Entwurf mit der ursprünglichen billingType.
    const invoices: BillingDraftLike[] = [
      draft({ status: "storniert", billingType: "pflegekasse_gesetzlich" }),
      draft({ status: "storniert", billingType: "selbstzahler" }),
      draft({ status: "entwurf", invoiceType: "stornorechnung", billingType: "pflegekasse_gesetzlich" }),
      draft({ status: "entwurf", invoiceType: "stornorechnung", billingType: "selbstzahler" }),
    ];

    expect(invoices.filter(isBulkActionableDraft)).toHaveLength(0);
    expect(invoices.filter(isPflegekasseBatchDraft)).toHaveLength(0);
  });

  it("lässt echte Entwürfe weiterhin durch", () => {
    const realSelbstzahler = draft({ billingType: "selbstzahler" });
    const realKasse = draft({ billingType: "pflegekasse_gesetzlich" });
    const realPrivat = draft({ billingType: "pflegekasse_privat" });

    expect(isActionableDraft(realSelbstzahler)).toBe(true);
    expect(isBulkActionableDraft(realSelbstzahler)).toBe(true);
    expect(isBulkActionableDraft(realKasse)).toBe(true);
    expect(isBulkActionableDraft(realPrivat)).toBe(true);
    expect(isPflegekasseBatchDraft(realKasse)).toBe(true);
    // Selbstzahler/privat sind kein Pflegekassen-Stapel.
    expect(isPflegekasseBatchDraft(realSelbstzahler)).toBe(false);
    expect(isPflegekasseBatchDraft(realPrivat)).toBe(false);
  });

  it("ignoriert versendete/bezahlte Rechnungen", () => {
    expect(isBulkActionableDraft(draft({ status: "versendet" }))).toBe(false);
    expect(isBulkActionableDraft(draft({ status: "bezahlt" }))).toBe(false);
  });
});

describe("Task #1198 (b): Billing-Invalidierung erneuert eligible-customers + payers", () => {
  it("invalidiert die eligible-customers- und payers-Caches", () => {
    const invalidated: unknown[][] = [];
    const queryClient = {
      invalidateQueries: vi.fn(({ queryKey }: { queryKey: unknown[] }) => {
        invalidated.push(queryKey);
      }),
    } as unknown as import("@tanstack/react-query").QueryClient;

    invalidateRelated(queryClient, "billing");

    const flat = invalidated.map((k) => JSON.stringify(k));
    expect(flat).toContain(JSON.stringify(["billing-eligible-customers"]));
    expect(flat).toContain(JSON.stringify(["billing-payers"]));
    // Bestehende Billing-Keys müssen weiterhin invalidiert werden.
    expect(flat).toContain(JSON.stringify(["billing-invoices"]));
  });
});
