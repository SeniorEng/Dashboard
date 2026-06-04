/**
 * Task #984 — Unit-Tests für die einmalige CSRF-Auto-Heilung im API-Client.
 *
 * Auf der veröffentlichten App schlug das Unterschreiben eines Leistungsnachweises
 * auf Mobilgeräten mit einem 403 fehl, weil der `careconnect_csrf`-Cookie
 * abgelaufen/nicht vorhanden war (Server: `CSRF_TOKEN_MISSING`/`CSRF_TOKEN_INVALID`).
 * Der Client holt jetzt bei genau diesem Fehler EINMAL einen frischen Token und
 * wiederholt die Schreibanfrage transparent. Diese Tests sichern:
 *  - Bei CSRF-403 wird der Token neu geholt und die Anfrage erfolgreich wiederholt.
 *  - Es wird höchstens EINMAL wiederholt (kein Endlos-Retry), sonst der echte Fehler.
 *  - Ein „normaler" 403 (kein CSRF) löst KEINEN Retry aus.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "../../client/src/lib/api/client";

const CSRF_HEADER = "x-csrf-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("API-Client CSRF Auto-Heilung (Task #984)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalDocument: unknown;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalDocument = (globalThis as Record<string, unknown>).document;
    // Kein vorhandener CSRF-Cookie → ensureCsrfToken muss /api/csrf-token holen.
    (globalThis as Record<string, unknown>).document = { cookie: "" };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as Record<string, unknown>).document = originalDocument;
    vi.restoreAllMocks();
  });

  it("holt bei CSRF_TOKEN_MISSING einen frischen Token und wiederholt die Anfrage erfolgreich", async () => {
    const headersSeen: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/csrf-token")) {
        // 1. Bootstrap → tok1, 2. Force-Refresh → tok2
        const token = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/api/csrf-token")).length === 1
          ? "tok1"
          : "tok2";
        return jsonResponse({ csrfToken: token });
      }
      // POST /api/service-records/1/sign
      const sent = (init?.headers as Record<string, string>)?.[CSRF_HEADER];
      headersSeen.push(sent);
      if (sent === "tok1") {
        return jsonResponse({ error: "CSRF_TOKEN_MISSING", message: "CSRF-Token fehlt. Bitte laden Sie die Seite neu." }, 403);
      }
      return jsonResponse({ id: 1, signed: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await api.post<{ id: number; signed: boolean }>("/service-records/1/sign", { signatureData: "x" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ id: 1, signed: true });
    }
    // Erst mit tok1 (403), dann nach Refresh mit tok2 (200).
    expect(headersSeen).toEqual(["tok1", "tok2"]);
  });

  it("wiederholt höchstens einmal und gibt sonst den echten CSRF-Fehler zurück", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/csrf-token")) {
        return jsonResponse({ csrfToken: "tok" });
      }
      return jsonResponse({ error: "CSRF_TOKEN_INVALID", message: "CSRF-Token ungültig. Bitte laden Sie die Seite neu." }, 403);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await api.post("/service-records/1/sign", { signatureData: "x" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.status).toBe(403);
      expect(result.error.message).toMatch(/CSRF-Token ungültig/);
    }
    // Genau zwei POSTs (Original + ein Retry), nicht mehr.
    const postCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/sign"));
    expect(postCalls).toHaveLength(2);
  });

  it("löst bei einem nicht-CSRF-403 KEINEN Token-Refresh-Retry aus", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/csrf-token")) {
        return jsonResponse({ csrfToken: "tok" });
      }
      return jsonResponse({ code: "FORBIDDEN", error: "ALREADY_SIGNED", message: "Bereits unterschrieben." }, 403);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await api.post("/service-records/1/sign", { signatureData: "x" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe("Bereits unterschrieben.");
    }
    // Nur EIN POST, kein Retry.
    const postCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/sign"));
    expect(postCalls).toHaveLength(1);
    // Nur der Bootstrap-Token-Fetch, kein zweiter (Force-Refresh).
    const csrfCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/api/csrf-token"));
    expect(csrfCalls).toHaveLength(1);
  });

  it("heilt auch, wenn der Retry mit 204 No Content antwortet", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/csrf-token")) {
        const n = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/api/csrf-token")).length;
        return jsonResponse({ csrfToken: n === 1 ? "tok1" : "tok2" });
      }
      const sent = (init?.headers as Record<string, string>)?.[CSRF_HEADER];
      if (sent === "tok1") {
        return jsonResponse({ error: "CSRF_TOKEN_MISSING", message: "CSRF-Token fehlt." }, 403);
      }
      return new Response(null, { status: 204 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await api.post("/service-records/1/sign", { signatureData: "x" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeUndefined();
    }
  });

  it("erkennt CSRF auch über details.errorCode, wenn der Top-Level-Code FORBIDDEN ist", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/csrf-token")) {
        const n = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/api/csrf-token")).length;
        return jsonResponse({ csrfToken: n === 1 ? "tok1" : "tok2" });
      }
      const sent = (init?.headers as Record<string, string>)?.[CSRF_HEADER];
      if (sent === "tok1") {
        // code=FORBIDDEN (Top-Level), aber details.errorCode=CSRF_TOKEN_INVALID
        return jsonResponse({ code: "FORBIDDEN", error: "CSRF_TOKEN_INVALID", message: "Verboten." }, 403);
      }
      return jsonResponse({ id: 1, signed: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await api.post<{ id: number; signed: boolean }>("/service-records/1/sign", { signatureData: "x" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ id: 1, signed: true });
    }
    const postCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/sign"));
    expect(postCalls).toHaveLength(2);
  });
});
