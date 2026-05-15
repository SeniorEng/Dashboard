import { describe, it, expect, vi } from "vitest";
import {
  isTransientApiError,
  submitWithRetry,
} from "../client/src/features/appointments/lib/submit-with-retry";
import { ApiError, type ApiResult } from "../client/src/lib/api/client";

// #490 — Mobile-Doku Submit-Resilienz. Diese Tests sichern die reine
// Retry-Logik ohne React-Render-Layer ab. Wir testen den Hook nicht direkt
// (Test-Env ist `node` ohne jsdom), sondern die isolierbare Kernlogik.

describe("isTransientApiError", () => {
  it("erkennt 5xx als transient", () => {
    expect(isTransientApiError({ status: 500 })).toBe(true);
    expect(isTransientApiError({ status: 502 })).toBe(true);
    expect(isTransientApiError({ status: 503 })).toBe(true);
    expect(isTransientApiError({ status: 504 })).toBe(true);
  });

  it("erkennt 408 und 429 als transient", () => {
    expect(isTransientApiError({ status: 408 })).toBe(true);
    expect(isTransientApiError({ status: 429 })).toBe(true);
  });

  it("erkennt Netzwerkfehler als transient", () => {
    expect(isTransientApiError({ code: "NETWORK_ERROR" })).toBe(true);
  });

  it("wertet fachliche 4xx-Fehler nicht als transient", () => {
    expect(isTransientApiError({ status: 400 })).toBe(false);
    expect(isTransientApiError({ status: 401 })).toBe(false);
    expect(isTransientApiError({ status: 403, code: "FORBIDDEN" })).toBe(false);
    expect(isTransientApiError({ status: 404 })).toBe(false);
    expect(isTransientApiError({ status: 409 })).toBe(false);
    expect(isTransientApiError({ status: 422 })).toBe(false);
  });
});

const success = <T>(data: T): ApiResult<T> => ({ success: true, data });
const fail = (
  code: string,
  message: string,
  status?: number,
): ApiResult<never> => ({
  success: false,
  error: { code, message, status },
});

const noDelay = () => Promise.resolve();

describe("submitWithRetry", () => {
  it("gibt den Erfolg beim ersten Versuch zurück", async () => {
    const fn = vi.fn().mockResolvedValueOnce(success({ ok: true }));

    const result = await submitWithRetry(fn, { delay: noDelay });

    expect(result.data).toEqual({ ok: true });
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retried bei 5xx und kommt schließlich durch", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(fail("API_ERROR", "Server boom", 503))
      .mockResolvedValueOnce(success({ ok: true }));
    const onRetry = vi.fn();

    const result = await submitWithRetry(fn, { delay: noDelay, onRetry });

    expect(result.data).toEqual({ ok: true });
    expect(result.attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, reason: "server_error" }),
    );
  });

  it("retried bei Netzwerkfehler bis zu zweimal (3 Versuche gesamt)", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(fail("NETWORK_ERROR", "kein Netz"))
      .mockResolvedValueOnce(fail("NETWORK_ERROR", "kein Netz"))
      .mockResolvedValueOnce(success({ ok: true }));

    const result = await submitWithRetry(fn, { delay: noDelay });

    expect(result.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gibt nach maxRetries+1 Versuchen auf und wirft ApiError", async () => {
    const fn = vi
      .fn()
      .mockResolvedValue(fail("NETWORK_ERROR", "kein Netz"));

    await expect(
      submitWithRetry(fn, { delay: noDelay, maxRetries: 2 }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retried KEINE fachlichen 4xx-Fehler", async () => {
    const fn = vi.fn().mockResolvedValueOnce(
      fail("FORBIDDEN", "Dieser Termin wurde bereits dokumentiert", 403),
    );

    await expect(
      submitWithRetry(fn, { delay: noDelay }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Dieser Termin wurde bereits dokumentiert",
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retried KEINE Validierungsfehler (400)", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(fail("VALIDATION_ERROR", "Pflichtfeld fehlt", 400));

    await expect(submitWithRetry(fn, { delay: noDelay })).rejects.toMatchObject(
      { code: "VALIDATION_ERROR" },
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("meldet die Versuchszahl an die fn weiter (Header-Plumbing)", async () => {
    const seenAttempts: number[] = [];
    const fn = vi.fn().mockImplementation(async (attempt: number) => {
      seenAttempts.push(attempt);
      if (attempt < 2) return fail("NETWORK_ERROR", "kein Netz");
      return success({ ok: true });
    });

    await submitWithRetry(fn, { delay: noDelay });

    expect(seenAttempts).toEqual([1, 2]);
  });
});
