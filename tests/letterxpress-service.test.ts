import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CompanySettings } from "@shared/schema";
import type { LxHttpResponse } from "../server/services/letterxpress-http";

const lxHttpRequest = vi.fn<(opts: { url: string; method: string; body: string; timeoutMs: number }) => Promise<LxHttpResponse>>();

vi.mock("../server/services/letterxpress-http", () => ({
  lxHttpRequest: (opts: { url: string; method: string; body: string; timeoutMs: number }) => lxHttpRequest(opts),
}));

const { sendLetterxpressLetter, testLetterxpressConnection, checkLetterxpressHealth } = await import(
  "../server/services/letterxpress-service"
);

function makeSettings(overrides: Partial<CompanySettings> = {}): CompanySettings {
  const base: Partial<CompanySettings> = {
    id: 1,
    letterxpressUsername: "user@example.com",
    letterxpressApiKey: "secret-api-key",
    letterxpressTestMode: true,
    companyName: "Test GmbH",
    strasse: "Hauptstr.",
    hausnummer: "1",
    plz: "10115",
    stadt: "Berlin",
  };
  return { ...base, ...overrides } as CompanySettings;
}

const RECIPIENT = {
  recipientFirstName: "Max",
  recipientLastName: "Mustermann",
  recipientStreet: "Musterstr.",
  recipientHouseNumber: "12",
  recipientPostalCode: "12345",
  recipientCity: "Musterstadt",
};

beforeEach(() => {
  lxHttpRequest.mockReset();
});

function httpResponse(body: unknown, status = 200): LxHttpResponse {
  return { status, text: JSON.stringify(body) };
}

function lastCallBody(): Record<string, unknown> {
  const call = lxHttpRequest.mock.calls.at(-1)?.[0];
  return JSON.parse(call!.body) as Record<string, unknown>;
}

describe("letterxpress-service", () => {
  it("sends a letter to POST /setjob and returns the letter id (test mode forces print=test, S/W duplex national)", async () => {
    lxHttpRequest.mockResolvedValueOnce(
      httpResponse({ status: 200, message: "OK", data: { id: "abc-123" } })
    );

    const result = await sendLetterxpressLetter(makeSettings(), {
      pdfBuffer: Buffer.from("hello"),
      ...RECIPIENT,
    });

    expect(result.letterId).toBe("abc-123");
    expect(lxHttpRequest).toHaveBeenCalledTimes(1);
    const opts = lxHttpRequest.mock.calls[0][0];
    expect(opts.method).toBe("POST");
    expect(opts.url).toContain("/setjob");
    const body = JSON.parse(opts.body) as Record<string, any>;
    expect(body.auth.username).toBe("user@example.com");
    expect(body.auth.apikey).toBe("secret-api-key");
    expect(body.auth.mode).toBe("test");
    expect(body.letter.base64_file).toBe(Buffer.from("hello").toString("base64"));
    expect(body.letter.base64_file2).toBe("");
    expect(body.letter.specification).toEqual({
      color: "1",
      mode: "duplex",
      ship: "national",
      print: "test",
    });
  });

  it("rejects an empty PDF buffer before calling the API", async () => {
    await expect(
      sendLetterxpressLetter(makeSettings(), { pdfBuffer: Buffer.alloc(0), ...RECIPIENT })
    ).rejects.toThrow(/Leeres PDF/);
    expect(lxHttpRequest).not.toHaveBeenCalled();
  });

  it("rejects an incomplete recipient address before calling the API", async () => {
    await expect(
      sendLetterxpressLetter(makeSettings(), {
        pdfBuffer: Buffer.from("x"),
        ...RECIPIENT,
        recipientPostalCode: "",
      })
    ).rejects.toThrow(/Empfängeradresse unvollständig/);
    expect(lxHttpRequest).not.toHaveBeenCalled();
  });

  it("uses auth.mode=production and print=live when test mode is disabled", async () => {
    lxHttpRequest.mockResolvedValueOnce(httpResponse({ status: 200, data: { id: 42 } }));

    await sendLetterxpressLetter(makeSettings({ letterxpressTestMode: false }), {
      pdfBuffer: Buffer.from("x"),
      ...RECIPIENT,
    });

    const body = lastCallBody() as Record<string, any>;
    expect(body.auth.mode).toBe("production");
    expect(body.letter.specification.print).toBe("live");
  });

  it("throws a German error on HTTP 4xx", async () => {
    lxHttpRequest.mockResolvedValueOnce(httpResponse({ message: "Unauthorized." }, 401));

    await expect(
      sendLetterxpressLetter(makeSettings(), { pdfBuffer: Buffer.from("x"), ...RECIPIENT })
    ).rejects.toThrow(/LetterXpress-Aufruf fehlgeschlagen \(401\)/);
  });

  it("throws when credentials are missing", async () => {
    await expect(
      sendLetterxpressLetter(makeSettings({ letterxpressApiKey: null }), {
        pdfBuffer: Buffer.from("x"),
        ...RECIPIENT,
      })
    ).rejects.toThrow(/LetterXpress-Konfiguration unvollständig/);
    expect(lxHttpRequest).not.toHaveBeenCalled();
  });

  it("testLetterxpressConnection calls GET /balance and returns the parsed balance.value", async () => {
    lxHttpRequest.mockResolvedValueOnce(
      httpResponse({ status: 200, message: "OK", balance: { currency: "EUR", value: "12.50" } })
    );

    const result = await testLetterxpressConnection(makeSettings());
    expect(result.success).toBe(true);
    expect(result.balance).toBe(12.5);
    const opts = lxHttpRequest.mock.calls[0][0];
    expect(opts.method).toBe("GET");
    expect(opts.url).toContain("/balance");
    const body = JSON.parse(opts.body) as Record<string, any>;
    expect(body.auth.mode).toBe("test");
  });

  it("testLetterxpressConnection returns success=false on missing credentials", async () => {
    const result = await testLetterxpressConnection(
      makeSettings({ letterxpressUsername: null, letterxpressApiKey: null })
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unvollständig/i);
    expect(lxHttpRequest).not.toHaveBeenCalled();
  });

  it("checkLetterxpressHealth probes GET /balance and reports healthy on 200", async () => {
    lxHttpRequest.mockResolvedValueOnce(
      httpResponse({ status: 200, balance: { value: "0.00" } })
    );

    const result = await checkLetterxpressHealth();
    expect(result.success).toBe(true);
    const opts = lxHttpRequest.mock.calls[0][0];
    expect(opts.method).toBe("GET");
    expect(opts.url).toContain("/balance");
  });

  it("checkLetterxpressHealth treats 401 (no creds sent) as healthy: endpoint exists and server is up", async () => {
    lxHttpRequest.mockResolvedValueOnce(httpResponse({ message: "Unauthorized." }, 401));

    const result = await checkLetterxpressHealth();
    expect(result.success).toBe(true);
  });

  it("checkLetterxpressHealth must NOT report healthy on 404 (wrong/non-existent endpoint)", async () => {
    lxHttpRequest.mockResolvedValueOnce(httpResponse({ message: "Not Found" }, 404));

    const result = await checkLetterxpressHealth();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/nicht erreichbar \(404\)/);
  });

  it("checkLetterxpressHealth reports unhealthy on a network error", async () => {
    lxHttpRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await checkLetterxpressHealth();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});
