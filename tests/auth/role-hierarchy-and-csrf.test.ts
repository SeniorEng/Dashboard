import { describe, it, expect, afterAll } from "vitest";
import {
  apiPatchAs,
  apiPatch,
  createTestEmployee,
  deactivateTestEmployee,
  loginAs,
  resetAuthCache,
} from "../test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const TEST_EMAIL = process.env.TEST_USER_EMAIL || "alrikdegenkolb@seniorenengel-alltagsbegleitung.de";
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD!;

interface ErrorResponse {
  error: string;
  message?: string;
}

interface UserResponse {
  id: number;
  roles?: string[];
}

const createdIds: number[] = [];

afterAll(async () => {
  for (const id of createdIds) await deactivateTestEmployee(id);
  resetAuthCache();
});

describe("Auth: Rollen-Hierarchie + CSRF/Session-Fixation (Task #492)", () => {
  // ---------------------------------------------------------------
  // 1) setUserRoles — Hierarchie-Check
  // ---------------------------------------------------------------
  describe("PATCH /api/admin/users/:id (roles) — Hierarchie-Check", () => {
    it("ein normaler Admin kann KEINE Rollen eines Admin-Accounts ändern (403)", async () => {
      const normalAdmin = await createTestEmployee({ isAdmin: true, nachnamePrefix: "RoleTestActor" });
      const targetAdmin = await createTestEmployee({ isAdmin: true, nachnamePrefix: "RoleTestTarget" });
      createdIds.push(normalAdmin.id, targetAdmin.id);

      const actorAuth = await loginAs(normalAdmin.email, normalAdmin.password);

      const res = await apiPatchAs<ErrorResponse>(actorAuth, `/api/admin/users/${targetAdmin.id}`, {
        roles: ["hauswirtschaft"],
      });

      expect(res.status).toBe(403);
      expect(res.data.error).toBe("FORBIDDEN");
    });

    it("der Hauptadministrator kann Rollen eines anderen Admins ändern (200)", async () => {
      const targetAdmin = await createTestEmployee({ isAdmin: true, nachnamePrefix: "RoleTestSuperOk" });
      createdIds.push(targetAdmin.id);

      const res = await apiPatch<UserResponse>(`/api/admin/users/${targetAdmin.id}`, {
        roles: ["alltagsbegleitung"],
      });

      expect(res.status).toBe(200);
      expect(res.data.roles).toContain("alltagsbegleitung");
    });
  });

  // ---------------------------------------------------------------
  // 2) CSRF — keine Cookie-Ausstellung auf unsafe-method ohne Cookie
  // ---------------------------------------------------------------
  describe("CSRF-Middleware — Token-Fixation-Defense", () => {
    it("POST ohne CSRF-Cookie setzt KEINEN neuen Cookie (Token-Fixation-Defense)", async () => {
      // `/api/auth/password-reset/request` ist mit csrfProtection geschützt,
      // braucht aber keine Authentifizierung — der ideale Negativ-Pfad.
      const res = await fetch(`${BASE_URL}/api/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "anyone@example.test" }),
      });
      expect(res.status).toBe(403);
      const setCookie = res.headers.get("set-cookie") || "";
      expect(setCookie).not.toMatch(/careconnect_csrf=/);
      const data = (await res.json()) as ErrorResponse;
      expect(data.error).toBe("CSRF_TOKEN_MISSING");
    });

    it("GET /api/csrf-token stellt einen frischen Cookie aus (safe method, erlaubt)", async () => {
      const res = await fetch(`${BASE_URL}/api/csrf-token`);
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") || "";
      expect(setCookie).toMatch(/careconnect_csrf=/);
    });
  });

  // ---------------------------------------------------------------
  // 3) Login regeneriert Session + CSRF-Token
  // ---------------------------------------------------------------
  describe("POST /api/auth/login — Session-Fixation-Defense", () => {
    it("Login stellt frische Session- und CSRF-Cookies aus", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") || "";
      expect(setCookie).toMatch(/careconnect_session=/);
      expect(setCookie).toMatch(/careconnect_csrf=/);
    });

    it("Login invalidiert eine zuvor untergeschobene Session (Session-Fixation)", async () => {
      const auth1 = await loginAs(TEST_EMAIL, TEST_PASSWORD);
      const sessionMatch1 = auth1.cookie.match(/careconnect_session=([^;]+)/);
      const sessionToken1 = sessionMatch1 ? sessionMatch1[1] : "";
      expect(sessionToken1).toBeTruthy();

      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `careconnect_session=${sessionToken1}`,
        },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") || "";
      const newSessionMatch = setCookie.match(/careconnect_session=([^;]+)/);
      const newSessionToken = newSessionMatch ? newSessionMatch[1] : "";
      expect(newSessionToken).toBeTruthy();
      expect(newSessionToken).not.toBe(sessionToken1);

      const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { Cookie: `careconnect_session=${sessionToken1}` },
      });
      expect(meRes.status).toBe(401);

      resetAuthCache();
    });
  });
});
