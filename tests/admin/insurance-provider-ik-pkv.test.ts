/**
 * Task #1826 — IK-Nummer bei PKV wirklich optional
 *
 * Prüft schema- und route-seitig:
 *   - PKV (isPrivate=true): IK-Nummer darf leer ODER beliebig sein
 *     (auch nicht-9-stellig wie "4112") — kein 9-Ziffern-Fehler.
 *   - GKV (isPrivate=false): IK-Nummer bleibt Pflicht und muss genau
 *     9 Ziffern haben — sowohl beim Erstellen (POST) als auch Aktualisieren (PUT).
 */
import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { insuranceProviders } from "@shared/schema";
import { insertInsuranceProviderSchema } from "@shared/schema/insurance";
import { apiPost, apiPut, uniqueId } from "../test-utils";

const TAG = `t1826-${uniqueId()}`;
const createdIds: number[] = [];

interface ProviderResponse {
  id?: number;
  error?: string;
  message?: string;
}

afterAll(async () => {
  try {
    if (createdIds.length) {
      await db.delete(insuranceProviders).where(inArray(insuranceProviders.id, createdIds));
    }
  } catch {}
});

describe("Task #1826 — Shared-Schema: PKV-IK ist beliebig, GKV-IK bleibt 9 Ziffern", () => {
  it("akzeptiert PKV mit kurzer/beliebiger IK ('4112')", () => {
    const res = insertInsuranceProviderSchema.safeParse({ name: `PKV-${TAG}`, isPrivate: true, ikNummer: "4112" });
    expect(res.success).toBe(true);
  });

  it("akzeptiert PKV ohne IK", () => {
    const res = insertInsuranceProviderSchema.safeParse({ name: `PKV-${TAG}`, isPrivate: true, ikNummer: "" });
    expect(res.success).toBe(true);
  });

  it("lehnt GKV ohne gültige 9-stellige IK ab", () => {
    const short = insertInsuranceProviderSchema.safeParse({ name: `GKV-${TAG}`, isPrivate: false, ikNummer: "4112" });
    expect(short.success).toBe(false);
    const missing = insertInsuranceProviderSchema.safeParse({ name: `GKV-${TAG}`, isPrivate: false });
    expect(missing.success).toBe(false);
  });

  it("akzeptiert GKV mit gültiger 9-stelliger IK", () => {
    const res = insertInsuranceProviderSchema.safeParse({ name: `GKV-${TAG}`, isPrivate: false, ikNummer: "123456789" });
    expect(res.success).toBe(true);
  });
});

describe("Task #1826 — Route: POST/PUT /api/admin/insurance-providers PKV-IK", () => {
  it("POST akzeptiert PKV mit beliebiger IK ('4112')", async () => {
    const res = await apiPost<ProviderResponse>("/api/admin/insurance-providers", {
      name: `PKV-Post-${TAG}`,
      isPrivate: true,
      ikNummer: "4112",
    });
    expect(res.status).toBe(201);
    expect(res.data.id).toBeTruthy();
    createdIds.push(res.data.id!);
  });

  it("POST lehnt GKV mit ungültiger IK ab", async () => {
    const res = await apiPost<ProviderResponse>("/api/admin/insurance-providers", {
      name: `GKV-Post-${TAG}`,
      isPrivate: false,
      ikNummer: "4112",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("PUT akzeptiert PKV-Update mit beliebiger IK ('4112')", async () => {
    const [row] = await db
      .insert(insuranceProviders)
      .values({ name: `PKV-Put-${TAG}`, isPrivate: true } as any)
      .returning({ id: insuranceProviders.id });
    createdIds.push(row.id);

    const res = await apiPut<ProviderResponse>(`/api/admin/insurance-providers/${row.id}`, {
      ikNummer: "4113",
    });
    expect(res.status).toBe(200);

    const [updated] = await db
      .select({ ikNummer: insuranceProviders.ikNummer })
      .from(insuranceProviders)
      .where(eq(insuranceProviders.id, row.id));
    expect(updated.ikNummer).toBe("4113");
  });

  it("PUT lehnt GKV-Update mit ungültiger IK ab", async () => {
    const [row] = await db
      .insert(insuranceProviders)
      .values({ name: `GKV-Put-${TAG}`, isPrivate: false, ikNummer: "123456789" } as any)
      .returning({ id: insuranceProviders.id });
    createdIds.push(row.id);

    const res = await apiPut<ProviderResponse>(`/api/admin/insurance-providers/${row.id}`, {
      ikNummer: "4112",
    });
    expect(res.status).toBe(400);
  });
});

describe("Task #1831 — Kostenträger-Verwaltungsseite: PKV-IK auch nicht-numerisch beliebig", () => {
  it("Schema akzeptiert PKV mit alphanumerischer IK ('IK-4112a')", () => {
    const res = insertInsuranceProviderSchema.safeParse({ name: `PKV-${TAG}`, isPrivate: true, ikNummer: "IK-4112a" });
    expect(res.success).toBe(true);
  });

  it("POST der Verwaltungsseite akzeptiert PKV mit beliebiger IK ('IK-4112a')", async () => {
    const res = await apiPost<ProviderResponse>("/api/admin/insurance-providers", {
      name: `PKV-Mgmt-${TAG}`,
      isPrivate: true,
      ikNummer: "IK-4112a",
    });
    expect(res.status).toBe(201);
    expect(res.data.id).toBeTruthy();
    createdIds.push(res.data.id!);
  });

  it("PUT der Verwaltungsseite akzeptiert PKV-Update mit beliebiger IK ('IK-9x')", async () => {
    const [row] = await db
      .insert(insuranceProviders)
      .values({ name: `PKV-Mgmt-Put-${TAG}`, isPrivate: true } as any)
      .returning({ id: insuranceProviders.id });
    createdIds.push(row.id);

    const res = await apiPut<ProviderResponse>(`/api/admin/insurance-providers/${row.id}`, {
      ikNummer: "IK-9x",
    });
    expect(res.status).toBe(200);

    const [updated] = await db
      .select({ ikNummer: insuranceProviders.ikNummer })
      .from(insuranceProviders)
      .where(eq(insuranceProviders.id, row.id));
    expect(updated.ikNummer).toBe("IK-9x");
  });
});
