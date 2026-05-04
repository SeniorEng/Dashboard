import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CompanySettings } from "@shared/schema";
import {
  sendLetterxpressLetter,
  testLetterxpressConnection,
} from "../server/services/letterxpress-service";

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

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("letterxpress-service", () => {
  it("sends a letter and returns the letter id (test mode forces print=test, S/W duplex national)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 200, message: "OK", data: { letter_id: "abc-123" } })
    );

    const result = await sendLetterxpressLetter(makeSettings(), {
      pdfBuffer: Buffer.from("hello"),
      ...RECIPIENT,
    });

    expect(result.letterId).toBe("abc-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/setJob");
    const body = JSON.parse((init as RequestInit).body as string);
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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an incomplete recipient address before calling the API", async () => {
    await expect(
      sendLetterxpressLetter(makeSettings(), {
        pdfBuffer: Buffer.from("x"),
        ...RECIPIENT,
        recipientPostalCode: "",
      })
    ).rejects.toThrow(/Empfängeradresse unvollständig/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses print=live when test mode is disabled", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 200, data: { letter_id: 42 } })
    );

    await sendLetterxpressLetter(makeSettings({ letterxpressTestMode: false }), {
      pdfBuffer: Buffer.from("x"),
      ...RECIPIENT,
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.auth.mode).toBe("live");
    expect(body.letter.specification.print).toBe("live");
  });

  it("throws a German error on HTTP 4xx", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 401, message: "Unauthorized" }, 401)
    );

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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("testLetterxpressConnection returns balance on success", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 200, data: { balance: 12.5 } })
    );

    const result = await testLetterxpressConnection(makeSettings());
    expect(result.success).toBe(true);
    expect(result.balance).toBe(12.5);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/getBalance");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.auth.mode).toBe("test");
  });

  it("testLetterxpressConnection returns success=false on missing credentials", async () => {
    const result = await testLetterxpressConnection(
      makeSettings({ letterxpressUsername: null, letterxpressApiKey: null })
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unvollständig/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
