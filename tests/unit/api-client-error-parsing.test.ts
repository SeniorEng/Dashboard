/**
 * Task #978 (Teil 2) — Unit-Tests für parseErrorResponse aus dem API-Client.
 *
 * Vorher zeigte der Client bei nicht-JSON-Fehlerantworten (z.B. ein
 * Proxy-/Plain-Text-403) nur ein nacktes "HTTP 403:". parseErrorResponse liest
 * den Body jetzt genau einmal als Text, parst JSON und fällt sonst auf eine
 * kurze, nicht-HTML Plain-Text-Meldung zurück. Diese Tests sichern:
 *  - JSON-Fehler ({message}/{error}/{code}/details) werden korrekt gemappt
 *  - nicht-JSON Plain-Text-Body wird als Meldung durchgereicht
 *  - HTML-Body bzw. überlange Bodies fallen auf "HTTP {status}: {statusText}"
 *  - der Body wird nur einmal gelesen (keine "body already read"-Fehler)
 */

import { describe, it, expect } from "vitest";
import { parseErrorResponse } from "../../client/src/lib/api/client";

describe("parseErrorResponse (Task #978)", () => {
  it("mappt eine JSON-Fehlerantwort mit message/code/details", async () => {
    const res = new Response(
      JSON.stringify({ code: "FORBIDDEN", error: "MONTH_CLOSED", message: "Der Monat ist bereits abgeschlossen." }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
    const info = await parseErrorResponse(res);
    expect(info.status).toBe(403);
    expect(info.message).toBe("Der Monat ist bereits abgeschlossen.");
    expect(info.code).toBe("FORBIDDEN");
    expect(info.details?.errorCode).toBe("MONTH_CLOSED");
  });

  it("reicht einen nicht-JSON Plain-Text-Body als Meldung durch", async () => {
    const res = new Response("Zugriff verweigert durch Proxy", { status: 403 });
    const info = await parseErrorResponse(res);
    expect(info.status).toBe(403);
    expect(info.message).toBe("Zugriff verweigert durch Proxy");
    expect(info.message).not.toMatch(/^HTTP /);
  });

  it("fällt bei HTML-Body auf den generischen HTTP-Status zurück", async () => {
    const res = new Response("<html><body>403 Forbidden</body></html>", {
      status: 403,
      statusText: "Forbidden",
    });
    const info = await parseErrorResponse(res);
    expect(info.message).toBe("HTTP 403: Forbidden");
  });

  it("fällt bei überlangem nicht-JSON-Body auf den generischen HTTP-Status zurück", async () => {
    const res = new Response("x".repeat(500), { status: 502, statusText: "Bad Gateway" });
    const info = await parseErrorResponse(res);
    expect(info.message).toBe("HTTP 502: Bad Gateway");
  });

  it("liest den Body nur einmal (kein 'body already read')", async () => {
    const res = new Response("kurzer fehler", { status: 500 });
    const info = await parseErrorResponse(res);
    expect(info.message).toBe("kurzer fehler");
    expect(res.bodyUsed).toBe(true);
  });
});
