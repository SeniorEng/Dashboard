import { describe, it, expect, afterAll } from "vitest";
import { apiGet, apiPost, resetAuthCache } from "./test-utils";

afterAll(() => {
  resetAuthCache();
});

describe("LetterXpress Admin-Routen", () => {
  describe("POST /api/admin/document-delivery/test-letterxpress", () => {
    it("liefert ein Verbindungstest-Ergebnis mit success-Flag zurück", async () => {
      const { status, data } = await apiPost<{ success: boolean; error?: string; balance?: number }>(
        "/api/admin/document-delivery/test-letterxpress",
        {}
      );

      expect([200, 400]).toContain(status);
      if (status === 200) {
        expect(data).toHaveProperty("success");
        expect(typeof data.success).toBe("boolean");
        if (data.success === false) {
          expect(typeof data.error).toBe("string");
        }
      } else {
        expect(data).toHaveProperty("error");
      }
    });

    it("verweigert Zugriff ohne Authentifizierung", async () => {
      const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
      const response = await fetch(`${BASE_URL}/api/admin/document-delivery/test-letterxpress`, {
        method: "POST",
      });
      expect([401, 403]).toContain(response.status);
    });
  });

  describe("GET /api/admin/document-delivery/letterxpress-health", () => {
    it("liefert ein Health-Check-Ergebnis", async () => {
      const { status, data } = await apiGet<{ success: boolean; error?: string }>(
        "/api/admin/document-delivery/letterxpress-health"
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("success");
      expect(typeof data.success).toBe("boolean");
    });
  });
});
