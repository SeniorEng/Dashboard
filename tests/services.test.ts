import { describe, it, expect, afterAll } from "vitest";
import {
  getAuthCookie,
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  uniqueId,
  getFutureDate,
} from "./test-utils";

let createdServiceId: number;
let createdOverrideId: number;
let testServiceName: string;
let firstCustomerId: number;

afterAll(async () => {
  try {
    if (createdOverrideId && firstCustomerId) {
      await apiDelete(`/api/customers/${firstCustomerId}/service-prices/${createdOverrideId}`);
    }
  } catch {}
  try {
    if (createdServiceId) {
      await apiPut(`/api/services/${createdServiceId}`, { isActive: true });
    }
  } catch {}
});

describe("Dienstleistungskatalog", () => {
  describe("GET /api/services", () => {
    it("sollte eine Liste aktiver Dienstleistungen zurückgeben", async () => {
      const { status, data } = await apiGet<any[]>("/api/services");
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      const service = data[0];
      expect(service).toHaveProperty("id");
      expect(service).toHaveProperty("name");
      expect(service).toHaveProperty("code");
      expect(service).toHaveProperty("unitType");
      expect(service).toHaveProperty("defaultPriceCents");
      expect(service).toHaveProperty("vatRate");
    });
  });

  describe("GET /api/services/all", () => {
    it("sollte alle Dienstleistungen inklusive inaktiver zurückgeben", async () => {
      const { status, data } = await apiGet<any[]>("/api/services/all");
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });
  });

  describe("POST /api/services", () => {
    it("sollte eine neue Dienstleistung erstellen", async () => {
      testServiceName = "QS-Test-Service_" + uniqueId();
      const { status, data } = await apiPost<any>("/api/services", {
        name: testServiceName,
        unitType: "hours",
        defaultPriceCents: 5000,
        vatRate: 19,
      });
      expect(status).toBe(201);
      expect(data).toHaveProperty("id");
      expect(data.name).toBe(testServiceName);
      expect(data.unitType).toBe("hours");
      expect(data.defaultPriceCents).toBe(5000);
      expect(data.vatRate).toBe(19);
      expect(data.isActive).toBe(true);
      createdServiceId = data.id;
    });
  });

  describe("PUT /api/services/:id", () => {
    it("sollte Name und Preis einer Dienstleistung aktualisieren", async () => {
      const updatedName = "QS-Test-Service-Updated_" + uniqueId();
      const { status, data } = await apiPut<any>(`/api/services/${createdServiceId}`, {
        name: updatedName,
        defaultPriceCents: 7500,
      });
      expect(status).toBe(200);
      expect(data.name).toBe(updatedName);
      expect(data.defaultPriceCents).toBe(7500);
      testServiceName = updatedName;
    });

    it("sollte eine Dienstleistung deaktivieren können", async () => {
      const { status, data } = await apiPut<any>(`/api/services/${createdServiceId}`, {
        isActive: false,
      });
      expect(status).toBe(200);
      expect(data.isActive).toBe(false);
    });
  });

  describe("Deaktivierte Dienstleistung filtern", () => {
    it("GET /api/services sollte die deaktivierte Dienstleistung NICHT enthalten", async () => {
      const { status, data } = await apiGet<any[]>("/api/services");
      expect(status).toBe(200);
      const found = data.find((s: any) => s.id === createdServiceId);
      expect(found).toBeUndefined();
    });

    it("GET /api/services/all sollte die deaktivierte Dienstleistung enthalten", async () => {
      const { status, data } = await apiGet<any[]>("/api/services/all");
      expect(status).toBe(200);
      const found = data.find((s: any) => s.id === createdServiceId);
      expect(found).toBeDefined();
      expect(found.isActive).toBe(false);
    });
  });

  describe("Kunden-Sonderpreise", () => {
    it("sollte einen Sonderpreis für den ersten Kunden anlegen", async () => {
      await apiPut(`/api/services/${createdServiceId}`, { isActive: true });

      const customersRes = await apiGet<any[]>("/api/customers");
      expect(customersRes.status).toBe(200);
      expect(customersRes.data.length).toBeGreaterThan(0);
      firstCustomerId = customersRes.data[0].id;

      const futureDate = getFutureDate(30);
      const { status, data } = await apiPost<any>(
        `/api/customers/${firstCustomerId}/service-prices`,
        {
          serviceId: createdServiceId,
          priceCents: 3500,
          validFrom: futureDate,
        }
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("id");
      expect(data.priceCents).toBe(3500);
      expect(data.serviceId).toBe(createdServiceId);
      expect(data.customerId).toBe(firstCustomerId);
      createdOverrideId = data.id;
    });

    it("sollte den Sonderpreis über GET service-prices abrufen können", async () => {
      const { status, data } = await apiGet<any[]>(
        `/api/customers/${firstCustomerId}/service-prices/all`
      );
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      const override = data.find((o: any) => o.id === createdOverrideId);
      expect(override).toBeDefined();
      expect(override.priceCents).toBe(3500);
    });
  });

  describe("Preisauflösung", () => {
    it("sollte den Sonderpreis bei der Preisauflösung anzeigen", async () => {
      const { status, data } = await apiGet<any[]>(
        `/api/customers/${firstCustomerId}/service-prices/all`
      );
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      const resolved = data.find((p: any) => p.serviceId === createdServiceId);
      expect(resolved).toBeDefined();
      expect(resolved.priceCents).toBe(3500);
    });
  });

  describe("Sonderpreis-Konflikt bei identischem Stichtag", () => {
    it("zweiter POST mit gleichem Stichtag liefert 409 PRICE_CONFLICT statt stiller Ersetzung", async () => {
      const conflictDate = getFutureDate(45);
      const first = await apiPost<any>(
        `/api/customers/${firstCustomerId}/service-prices`,
        { serviceId: createdServiceId, priceCents: 4200, validFrom: conflictDate }
      );
      expect(first.status).toBe(200);
      const firstId = first.data.id as number;

      const conflict = await apiPost<any>(
        `/api/customers/${firstCustomerId}/service-prices`,
        { serviceId: createdServiceId, priceCents: 4900, validFrom: conflictDate }
      );
      expect(conflict.status).toBe(409);
      expect(conflict.data?.code).toBe("PRICE_CONFLICT");
      expect(conflict.data?.details?.existing?.id).toBe(firstId);
      expect(conflict.data?.details?.existing?.priceCents).toBe(4200);

      const stillFirst = await apiGet<any[]>(
        `/api/customers/${firstCustomerId}/service-prices/all`
      );
      const stillActive = stillFirst.data.find((p: any) => p.id === firstId);
      expect(stillActive, "Erster Preis darf bei abgelehnter Ersetzung nicht weichen").toBeDefined();
      expect(stillActive.priceCents).toBe(4200);

      const replace = await apiPost<any>(
        `/api/customers/${firstCustomerId}/service-prices`,
        { serviceId: createdServiceId, priceCents: 4900, validFrom: conflictDate, confirmReplace: true }
      );
      expect(replace.status).toBe(200);
      expect(replace.data.priceCents).toBe(4900);
      const newId = replace.data.id as number;
      expect(newId).not.toBe(firstId);

      const after = await apiGet<any[]>(
        `/api/customers/${firstCustomerId}/service-prices/all`
      );
      const replacement = after.data.find((p: any) => p.id === newId);
      expect(replacement).toBeDefined();
      expect(replacement.priceCents).toBe(4900);

      const auditRes = await apiGet<{ entries: any[]; total: number }>(
        `/api/admin/audit-log?entityType=customer&action=customer_price_replaced&entityId=${firstCustomerId}&limit=10`
      );
      expect(auditRes.status).toBe(200);
      const replaceEntry = auditRes.data.entries.find(
        (e: any) => e.metadata?.replacedPriceId === firstId && e.metadata?.newPriceId === newId
      );
      expect(replaceEntry, "Audit-Log muss Eintrag für ersetzten Preis enthalten").toBeDefined();
      expect(replaceEntry.metadata.oldPriceCents).toBe(4200);
      expect(replaceEntry.metadata.newPriceCents).toBe(4900);
      expect(replaceEntry.metadata.serviceId).toBe(createdServiceId);

      await apiDelete(`/api/customers/${firstCustomerId}/service-prices/${newId}`);
    });

    it("zwei parallele POSTs mit identischem Stichtag: einer gewinnt mit 200, der andere bekommt 409 (DB-Constraint)", async () => {
      const conflictDate = getFutureDate(90);
      const [r1, r2] = await Promise.all([
        apiPost<any>(
          `/api/customers/${firstCustomerId}/service-prices`,
          { serviceId: createdServiceId, priceCents: 6100, validFrom: conflictDate }
        ),
        apiPost<any>(
          `/api/customers/${firstCustomerId}/service-prices`,
          { serviceId: createdServiceId, priceCents: 6200, validFrom: conflictDate }
        ),
      ]);
      const successes = [r1, r2].filter((r) => r.status === 200);
      const conflicts = [r1, r2].filter((r) => r.status === 409);
      expect(successes.length, `Genau ein POST darf gewinnen (got ${JSON.stringify([r1.status, r2.status])})`).toBe(1);
      expect(conflicts.length).toBe(1);
      expect(conflicts[0].data?.code).toBe("PRICE_CONFLICT");

      const after = await apiGet<any[]>(
        `/api/customers/${firstCustomerId}/service-prices/all`
      );
      const activeSameDay = after.data.filter(
        (p: any) => p.serviceId === createdServiceId && String(p.validFrom).startsWith(conflictDate)
      );
      expect(activeSameDay.length, "Höchstens ein aktiver Preis pro Stichtag").toBe(1);

      await apiDelete(`/api/customers/${firstCustomerId}/service-prices/${successes[0].data.id}`);
    });
  });

  describe("Sonderpreis löschen", () => {
    it("sollte den Sonderpreis löschen können", async () => {
      const { status } = await apiDelete(
        `/api/customers/${firstCustomerId}/service-prices/${createdOverrideId}`
      );
      expect(status).toBe(200);
    });

    it("sollte den gelöschten Sonderpreis nicht mehr anzeigen", async () => {
      const { status, data } = await apiGet<any[]>(
        `/api/customers/${firstCustomerId}/service-prices/all`
      );
      expect(status).toBe(200);
      const override = data.find((o: any) => o.id === createdOverrideId);
      expect(override).toBeUndefined();
      createdOverrideId = 0;
    });
  });
});
