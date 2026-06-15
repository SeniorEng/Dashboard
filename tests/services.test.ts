import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  getFutureDate,
  createTestCustomer,
  cleanupCustomer,
} from "./test-utils";
import { SERVICE_CATALOG_CODES } from "@shared/config/services";

// Phase 3.4: Der Dienstleistungskatalog ist konfigurationsgesteuert
// (`shared/config/services.ts`). Es gibt keinen API-Schreibweg mehr — Anlage/
// Änderung passiert ausschließlich per Code-Änderung + Startup-Sync. Die Tests
// arbeiten daher gegen die vom Katalog geseedete `hauswirtschaft`-Leistung
// statt eine eigene Wegwerf-Leistung anzulegen.
let hauswirtschaftId: number;
let createdOverrideId: number;
let firstCustomerId: number;

beforeAll(async () => {
  const { status, data } = await apiGet<any[]>("/api/services");
  expect(status).toBe(200);
  const hw = data.find((s) => s.code === "hauswirtschaft");
  expect(hw, "Katalog-Leistung 'hauswirtschaft' muss vom Startup-Sync vorhanden sein").toBeDefined();
  hauswirtschaftId = hw.id;

  // Dedizierter Test-Kunde: die Sonderpreis-Tests dürfen nicht auf vorab
  // existierende Kunden bauen (frische Wegwerf-DB hat keine) und müssen gegen
  // Quer-Kontamination anderer Test-Dateien isoliert sein, da der Katalog-
  // Service 'hauswirtschaft' nun geteilt ist.
  const cust = await createTestCustomer();
  firstCustomerId = cust.id;
});

afterAll(async () => {
  try {
    if (createdOverrideId && firstCustomerId) {
      await apiDelete(`/api/customers/${firstCustomerId}/service-prices/${createdOverrideId}`);
    }
  } catch {}
  await cleanupCustomer(firstCustomerId);
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

    it("sollte deckungsgleich mit dem konfigurierten Katalog sein (keine Fremd-/Fehl-Leistungen)", async () => {
      const { status, data } = await apiGet<any[]>("/api/services/all");
      expect(status).toBe(200);
      const dbCodes = data.map((s: any) => s.code).filter((c: any): c is string => !!c).sort();
      const configCodes = [...SERVICE_CATALOG_CODES].sort();
      expect(dbCodes).toEqual(configCodes);
      // Es darf keine Leistung ohne code (Alt-/Fremddaten) übrig sein.
      expect(data.every((s: any) => !!s.code)).toBe(true);
    });
  });

  describe("Schreibwege gesperrt (konfigurationsgesteuerter Katalog)", () => {
    it("POST /api/services liefert 403 SERVICE_CATALOG_READONLY", async () => {
      const { status, data } = await apiPost<any>("/api/services", {
        name: "QS-Test-Service",
        unitType: "hours",
        defaultPriceCents: 5000,
        vatRate: 19,
      });
      expect(status).toBe(403);
      expect(data?.error).toBe("SERVICE_CATALOG_READONLY");
      expect(typeof data?.message).toBe("string");
    });

    it("PUT /api/services/:id liefert 403 SERVICE_CATALOG_READONLY", async () => {
      const { status, data } = await apiPut<any>(`/api/services/${hauswirtschaftId}`, {
        name: "QS-Test-Service-Updated",
        defaultPriceCents: 7500,
      });
      expect(status).toBe(403);
      expect(data?.error).toBe("SERVICE_CATALOG_READONLY");
    });
  });

  describe("Kunden-Sonderpreise mit Preis 0 (Task #563)", () => {
    it("akzeptiert priceCents=0 (kostenlose Leistung für diesen Kunden)", async () => {
      const futureDate = getFutureDate(120);
      const { status, data } = await apiPost<any>(
        `/api/customers/${firstCustomerId}/service-prices`,
        { serviceId: hauswirtschaftId, priceCents: 0, validFrom: futureDate },
      );
      expect(status).toBe(200);
      expect(data.priceCents).toBe(0);
      try {
        await apiDelete(`/api/customers/${firstCustomerId}/service-prices/${data.id}`);
      } catch {}
    });

    it("lehnt priceCents=-1 mit 400 weiterhin ab", async () => {
      const futureDate = getFutureDate(125);
      const { status } = await apiPost<any>(
        `/api/customers/${firstCustomerId}/service-prices`,
        { serviceId: hauswirtschaftId, priceCents: -1, validFrom: futureDate },
      );
      expect(status).toBe(400);
    });
  });

  describe("Kunden-Sonderpreise", () => {
    it("sollte einen Sonderpreis für den ersten Kunden anlegen", async () => {
      const futureDate = getFutureDate(30);
      const { status, data } = await apiPost<any>(
        `/api/customers/${firstCustomerId}/service-prices`,
        {
          serviceId: hauswirtschaftId,
          priceCents: 3500,
          validFrom: futureDate,
        }
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("id");
      expect(data.priceCents).toBe(3500);
      expect(data.serviceId).toBe(hauswirtschaftId);
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
      const resolved = data.find((p: any) => p.serviceId === hauswirtschaftId);
      expect(resolved).toBeDefined();
      expect(resolved.priceCents).toBe(3500);
    });
  });

  describe("Sonderpreis-Konflikt bei identischem Stichtag", () => {
    it("zweiter POST mit gleichem Stichtag liefert 409 PRICE_CONFLICT statt stiller Ersetzung", async () => {
      const conflictDate = getFutureDate(45);
      const first = await apiPost<any>(
        `/api/customers/${firstCustomerId}/service-prices`,
        { serviceId: hauswirtschaftId, priceCents: 4200, validFrom: conflictDate }
      );
      expect(first.status).toBe(200);
      const firstId = first.data.id as number;

      const conflict = await apiPost<any>(
        `/api/customers/${firstCustomerId}/service-prices`,
        { serviceId: hauswirtschaftId, priceCents: 4900, validFrom: conflictDate }
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
        { serviceId: hauswirtschaftId, priceCents: 4900, validFrom: conflictDate, confirmReplace: true }
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
      expect(replaceEntry.metadata.serviceId).toBe(hauswirtschaftId);

      await apiDelete(`/api/customers/${firstCustomerId}/service-prices/${newId}`);
    });

    it("zwei parallele POSTs mit identischem Stichtag: einer gewinnt mit 200, der andere bekommt 409 (DB-Constraint)", async () => {
      const conflictDate = getFutureDate(90);
      const [r1, r2] = await Promise.all([
        apiPost<any>(
          `/api/customers/${firstCustomerId}/service-prices`,
          { serviceId: hauswirtschaftId, priceCents: 6100, validFrom: conflictDate }
        ),
        apiPost<any>(
          `/api/customers/${firstCustomerId}/service-prices`,
          { serviceId: hauswirtschaftId, priceCents: 6200, validFrom: conflictDate }
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
        (p: any) => p.serviceId === hauswirtschaftId && String(p.validFrom).startsWith(conflictDate)
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
