/**
 * Task #705 — API-Catch-All vor Vite.
 *
 * Reproducer aus Bug-Report 2026-05-27: Unbekannte /api/*-Endpunkte ODER
 * existierende Pfade mit nicht-registrierter HTTP-Methode wurden vom Vite-
 * Wildcard als HTML-Index ausgeliefert (`text/html`, statt JSON-404).
 * Frontend-Clients konnten den Fehler nicht parsen → "Unexpected token <".
 *
 * Erwartung: `/api/*`-Requests, die KEINE Route matchen, antworten immer mit
 * `application/json` und Status 404 (Express liefert für falsche Methode auf
 * existierenden Pfaden automatisch 404, sofern keine andere `router.use`-
 * Mounting die Methode catched — beide Fälle landen hier).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getAuthCookie } from "../test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

beforeAll(async () => {
  await getAuthCookie();
});

async function rawRequest(method: string, path: string, auth: { cookie: string; csrfToken: string }) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Cookie: `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`,
      "x-csrf-token": auth.csrfToken,
      "Content-Type": "application/json",
    },
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({}),
  });
}

describe("API-Catch-All — unbekannte /api/*-Endpunkte liefern JSON-404", () => {
  it("GET /api/this-route-does-not-exist → 404 application/json", async () => {
    const auth = await getAuthCookie();
    const res = await rawRequest("GET", "/api/this-route-does-not-exist-705", auth);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
    const body = await res.json();
    expect(body.error).toBe("NOT_FOUND");
  });

  it("POST /api/totally-fake → 404 application/json (kein HTML-Fallback)", async () => {
    const auth = await getAuthCookie();
    const res = await rawRequest("POST", "/api/totally-fake-705", auth);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
  });

  it("PUT auf unbekanntem /api/-Subpfad → 404 JSON (kein vite-index.html)", async () => {
    const auth = await getAuthCookie();
    const res = await rawRequest("PUT", "/api/admin/no-such-thing-705", auth);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
    const text = await res.text();
    expect(text).not.toMatch(/<html/i);
  });
});
