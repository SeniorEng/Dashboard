import { describe, it, expect, afterAll } from "vitest";
import {
  getAuthCookie,
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  uniqueId,
} from "./test-utils";

let createdServiceId: number;
let createdOverrideId: number;
let testServiceName: string;
let firstCustomerId: number;

afterAll(async () => {
  try {
    if (createdOverrideId && firstCustomerId) {
      await apiDelete(`/api/services/customer/${firstCustomerId}/overrides/${createdOverrideId}`);
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

      const today = new Date().toISOString().split("T")[0];
      const { status, data } = await apiPost<any>(
        `/api/services/customer/${firstCustomerId}/overrides`,
        {
          serviceId: createdServiceId,
          priceCents: 3500,
          validFrom: today,
        }
      );
      expect(status).toBe(201);
      expect(data).toHaveProperty("id");
      expect(data.priceCents).toBe(3500);
      expect(data.serviceId).toBe(createdServiceId);
      expect(data.customerId).toBe(firstCustomerId);
      createdOverrideId = data.id;
    });

    it("sollte den Sonderpreis über GET overrides abrufen können", async () => {
      const { status, data } = await apiGet<any[]>(
        `/api/services/customer/${firstCustomerId}/overrides`
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
        `/api/services/customer/${firstCustomerId}/prices`
      );
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      const resolved = data.find((p: any) => p.service?.id === createdServiceId || p.serviceId === createdServiceId);
      expect(resolved).toBeDefined();
      expect(resolved.priceCents).toBe(3500);
      expect(resolved.isOverride).toBe(true);
    });
  });

  describe("Sonderpreis löschen", () => {
    it("sollte den Sonderpreis löschen können", async () => {
      const { status } = await apiDelete(
        `/api/services/customer/${firstCustomerId}/overrides/${createdOverrideId}`
      );
      expect(status).toBe(200);
    });

    it("sollte den gelöschten Sonderpreis nicht mehr anzeigen", async () => {
      const { status, data } = await apiGet<any[]>(
        `/api/services/customer/${firstCustomerId}/overrides`
      );
      expect(status).toBe(200);
      const override = data.find((o: any) => o.id === createdOverrideId);
      expect(override).toBeUndefined();
      createdOverrideId = 0;
    });
  });
});
