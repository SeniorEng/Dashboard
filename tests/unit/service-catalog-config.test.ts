import { describe, it, expect } from "vitest";
import {
  SERVICE_CATALOG,
  SERVICE_CATALOG_CODES,
  SERVICE_BUDGET_POTS,
} from "@shared/config/services";

/**
 * Phase 3.4: `shared/config/services.ts` ist die EINZIGE Quelle der realen
 * Dienstleistungen. Reine Invarianten-Tests (keine DB, kein Server) — der
 * Konfig↔DB-Abgleich passiert beim Start über `syncServiceCatalog()`.
 */
describe("Service-Katalog Konfiguration (shared/config/services.ts)", () => {
  it("hat eindeutige Codes (keine Duplikate)", () => {
    const codes = SERVICE_CATALOG.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("hat für jeden Eintrag einen nicht-leeren Code", () => {
    for (const svc of SERVICE_CATALOG) {
      expect(svc.code.trim().length).toBeGreaterThan(0);
    }
  });

  it("SERVICE_CATALOG_CODES ist deckungsgleich mit den Katalog-Codes", () => {
    expect([...SERVICE_CATALOG_CODES].sort()).toEqual(
      SERVICE_CATALOG.map((s) => s.code).sort(),
    );
  });

  it("verwendet ausschließlich gültige Budget-Töpfe", () => {
    const allowed = new Set<string>(SERVICE_BUDGET_POTS);
    for (const svc of SERVICE_CATALOG) {
      for (const pot of svc.budgetPots) {
        expect(allowed.has(pot)).toBe(true);
      }
      // Budget-Töpfe pro Service ebenfalls eindeutig.
      expect(new Set(svc.budgetPots).size).toBe(svc.budgetPots.length);
    }
  });

  it("hält Geldbeträge als nicht-negative Integer-Cents (SSoT-Regel)", () => {
    for (const svc of SERVICE_CATALOG) {
      expect(Number.isInteger(svc.defaultPriceCents)).toBe(true);
      expect(svc.defaultPriceCents).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(svc.employeeRateCents)).toBe(true);
      expect(svc.employeeRateCents).toBeGreaterThanOrEqual(0);
    }
  });
});
