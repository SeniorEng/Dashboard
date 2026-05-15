/**
 * Task #512 — Regression: Verhindere "Waisen-Kunden" mit
 * `status='erstberatung'` ohne `convertedFromProspectId`.
 *
 * Hintergrund: In Prod lagen 15 Kunden mit Status `erstberatung` ohne
 * Prospect-Verknüpfung (siehe docs/erstberatung-prod-analysis.md). Task #509
 * hat sie bereinigt. Damit die Liste nicht wieder volläuft, blockt der
 * Storage-Layer (`createCustomerDirect`/`updateCustomer`) den Schreibvorgang
 * hart, sobald `status='erstberatung'` ohne Prospect-Link reinkommt.
 */
import { describe, it, expect } from "vitest";
import { customerManagementStorage, assertErstberatungHasProspectLink } from "../server/storage/customer-management";
import { AppError } from "../server/lib/errors";
import type { InsertCustomer } from "@shared/schema";

function basePayload(overrides: Partial<InsertCustomer> = {}): InsertCustomer {
  return {
    name: "Waise, Test",
    vorname: "Test",
    nachname: "Waise-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    address: "Teststraße 1, 10115 Berlin",
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    billingType: "pflegekasse_gesetzlich",
    ...overrides,
  } as InsertCustomer;
}

describe("Task #512 — Erstberatung-Kunden brauchen Prospect-Link", () => {
  it("assertErstberatungHasProspectLink wirft, wenn status='erstberatung' und keine prospectId", () => {
    expect(() => assertErstberatungHasProspectLink("erstberatung", null)).toThrowError(AppError);
    expect(() => assertErstberatungHasProspectLink("erstberatung", undefined)).toThrowError(AppError);
  });

  it("assertErstberatungHasProspectLink passiert mit gültiger prospectId", () => {
    expect(() => assertErstberatungHasProspectLink("erstberatung", 42)).not.toThrow();
  });

  it("assertErstberatungHasProspectLink ignoriert andere Status", () => {
    expect(() => assertErstberatungHasProspectLink("aktiv", null)).not.toThrow();
    expect(() => assertErstberatungHasProspectLink("inaktiv", null)).not.toThrow();
    expect(() => assertErstberatungHasProspectLink(null, null)).not.toThrow();
  });

  it("createCustomerDirect lehnt status='erstberatung' ohne convertedFromProspectId ab", async () => {
    await expect(
      customerManagementStorage.createCustomerDirect(
        basePayload({ status: "erstberatung", convertedFromProspectId: null }),
      ),
    ).rejects.toMatchObject({
      name: "AppError",
      code: "ERSTBERATUNG_REQUIRES_PROSPECT",
      statusCode: 400,
    });
  });

  it("updateCustomer-Pfad ruft den Guard mit dem neuen Status auf", async () => {
    // Static-Source-Check: `updateCustomer` MUSS den Guard mit dem neuen
    // Status aufrufen, bevor die DB-Mutation ausgeführt wird. Wir prüfen das
    // durch String-Inspektion der Datei, weil ein voller Round-Trip-Test
    // hier einen funktionierenden DB-Migrationsstand voraussetzen würde.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../server/storage/customer-management.ts"),
      "utf8",
    );
    expect(src).toMatch(/if\s*\(\s*data\.status\s*===\s*"erstberatung"\s*\)/);
    expect(src).toMatch(/assertErstberatungHasProspectLink\(\s*data\.status\s*,\s*oldCustomer\.convertedFromProspectId/);
  });
});
