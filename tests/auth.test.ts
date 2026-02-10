import { describe, it, expect, afterAll } from "vitest";
import {
  getAuthCookie,
  apiGet,
  apiPost,
  apiGetAs,
  apiPostAs,
  resetAuthCache,
  uniqueId,
} from "./test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const TEST_EMAIL = process.env.TEST_USER_EMAIL || "alrikdegenkolb@seniorenengel-alltagsbegleitung.de";
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD!;

afterAll(() => {
  resetAuthCache();
});

describe("Authentifizierung", () => {
  describe("POST /api/auth/login", () => {
    it("sollte sich mit korrekten Anmeldedaten einloggen können", async () => {
      const response = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.user).toBeDefined();
      expect(data.user.email).toBe(TEST_EMAIL);
      expect(data.user).toHaveProperty("isAdmin");
      expect(data.user).not.toHaveProperty("passwordHash");
    });

    it("sollte bei falschem Passwort 401 zurückgeben", async () => {
      const response = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: TEST_EMAIL, password: "falsches_passwort_" + uniqueId() }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("UNAUTHORIZED");
    });

    it("sollte bei nicht existierender E-Mail 401 zurückgeben", async () => {
      const response = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${uniqueId()}@nicht-vorhanden.de`, password: "irgendwas123" }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("UNAUTHORIZED");
    });
  });

  describe("GET /api/auth/me", () => {
    it("sollte Benutzerdaten mit isAdmin-Feld zurückgeben", async () => {
      const { status, data } = await apiGet<{ user: { email: string; isAdmin: boolean }; badgeCount: number }>("/api/auth/me");

      expect(status).toBe(200);
      expect(data.user).toBeDefined();
      expect(data.user.email).toBe(TEST_EMAIL);
      expect(typeof data.user.isAdmin).toBe("boolean");
      expect(typeof data.badgeCount).toBe("number");
    });

    it("sollte ohne Authentifizierung 401 zurückgeben", async () => {
      const response = await fetch(`${BASE_URL}/api/auth/me`);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("UNAUTHORIZED");
    });
  });

  describe("POST /api/auth/logout", () => {
    it("sollte die Sitzung nach dem Logout ungültig machen", async () => {
      const auth = await getAuthCookie();

      const logoutResponse = await fetch(`${BASE_URL}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: auth.cookie },
      });

      expect(logoutResponse.status).toBe(200);
      const logoutData = await logoutResponse.json();
      expect(logoutData.success).toBe(true);

      const meResponse = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { Cookie: auth.cookie },
      });

      expect(meResponse.status).toBe(401);

      resetAuthCache();
    });
  });

  describe("GET /api/auth/setup-required", () => {
    it("sollte zurückgeben, dass kein Setup erforderlich ist", async () => {
      const response = await fetch(`${BASE_URL}/api/auth/setup-required`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.setupRequired).toBe(false);
    });
  });
});
