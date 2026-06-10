/**
 * Shared test stand-in for the LetterXpress postal-send transport.
 *
 * WARUM ein eigener Helper: Der LetterXpress-v2-Transport
 * (`server/services/letterxpress-http.ts`) spricht NICHT über das globale
 * `fetch`, sondern über `node:https` direkt — weil die LXP-v2-API einen
 * Request-Body auch an `GET /v2/balance` verlangt, was `fetch`/undici verbietet.
 * Folge: Ein `vi.stubGlobal("fetch", …)` fängt den LetterXpress-Aufruf NICHT ab.
 * Ein Test, der einen Postversand auslöst (Anschreiben, Rechnungs-Kopie,
 * Leistungsnachweis-Brief …), würde daher still die ECHTE LetterXpress-API
 * treffen und mit 401 fehlschlagen.
 *
 * Dieser Helper mockt deshalb die Transport-Schicht selbst (`lxHttpRequest`):
 * jeder Aufruf wird aufgezeichnet und mit einer konfigurierbaren, kanonischen
 * setjob-/balance-Antwort beantwortet. Verwendung im Testfile:
 *
 * ```ts
 * import { vi } from "vitest";
 * vi.mock("../../server/services/letterxpress-http", async () => {
 *   const lx = await import("../helpers/letterxpress");
 *   return { lxHttpRequest: lx.lxHttpRequest };
 * });
 * import { getLxHttpCalls, resetLxHttpMock, setLxSetjobResponse } from "../helpers/letterxpress";
 * ```
 *
 * Der `vi.mock`-Aufruf MUSS im Testfile stehen (vitest hebt `vi.mock` nur dort
 * an, nicht in importierten Modulen). Die dynamische `import()`-Factory greift
 * dabei auf DIESELBE Modulinstanz zu wie der statische Import oben, sodass
 * `lxHttpRequest`-Mock und Recorder geteilt werden.
 *
 * Tiefenhintergrund: `docs/test-infrastructure.md` ("LetterXpress …").
 */
import { vi } from "vitest";

export interface LxHttpCall {
  url: string;
  method: string;
  body: string;
}

interface LxHttpMockState {
  calls: LxHttpCall[];
  responseStatus: number;
  responseText: string;
}

const state: LxHttpMockState = {
  calls: [],
  responseStatus: 200,
  responseText: "",
};

/**
 * Drop-in-Ersatz für `lxHttpRequest` aus
 * `server/services/letterxpress-http.ts`. Zeichnet jeden Aufruf auf und liefert
 * die aktuell konfigurierte Antwort zurück (Default: 200 + leerer Body).
 */
export const lxHttpRequest = vi.fn(
  async (opts: { url: string; method: string; body: string; timeoutMs?: number }) => {
    state.calls.push({ url: opts.url, method: opts.method, body: opts.body });
    return { status: state.responseStatus, text: state.responseText };
  },
);

/** Alle bisher aufgezeichneten LetterXpress-Transport-Aufrufe (live-Referenz). */
export function getLxHttpCalls(): LxHttpCall[] {
  return state.calls;
}

/** Aufgezeichnete Aufrufe + Antwort + vi.fn-Historie zurücksetzen. */
export function resetLxHttpMock(): void {
  state.calls.length = 0;
  state.responseStatus = 200;
  state.responseText = "";
  lxHttpRequest.mockClear();
}

/**
 * Kanonische `POST /setjob`-Erfolgsantwort hinterlegen. LXP v2 liefert die
 * Job-/Letter-ID unter `data.id`.
 */
export function setLxSetjobResponse(letterId: string | number): void {
  state.responseStatus = 200;
  state.responseText = JSON.stringify({
    status: 200,
    message: "OK",
    data: { id: letterId },
  });
}

/**
 * Kanonische `GET /balance`-Erfolgsantwort hinterlegen. LXP v2 liefert das
 * Guthaben unter `balance.value` (Dezimal-String).
 */
export function setLxBalanceResponse(value: string | number, currency = "EUR"): void {
  state.responseStatus = 200;
  state.responseText = JSON.stringify({
    status: 200,
    message: "OK",
    balance: { currency, value: String(value) },
  });
}

/**
 * Freie Antwort setzen (z.B. Fehlerfälle). Status default 200; eigener Status
 * optional.
 */
export function setLxRawResponse(text: string, status = 200): void {
  state.responseStatus = status;
  state.responseText = text;
}
