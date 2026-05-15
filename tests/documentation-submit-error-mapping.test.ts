import { describe, it, expect } from "vitest";
import { mapSubmitError } from "../client/src/features/appointments/lib/map-submit-error";
import { ApiError } from "../client/src/lib/api/client";

// #490 — testet das fachliche Mapping vom Mutation-Error in die UI-Darstellung,
// die im persistenten Fehler-Banner und für die Auto-Redirect-Entscheidung
// genutzt wird. Diese Logik ist von React entkoppelt, damit sie unter dem
// node-Vitest-Env testbar ist.

describe("mapSubmitError", () => {
  it("erkennt ALREADY_COMPLETED, sperrt Retry und triggert Redirect", () => {
    const err = new ApiError({
      message: "Dieser Termin wurde bereits dokumentiert",
      code: "FORBIDDEN",
      status: 403,
      details: { errorCode: "ALREADY_COMPLETED" },
    });

    const view = mapSubmitError(err);

    expect(view.isAlreadyCompleted).toBe(true);
    expect(view.isSignatureLocked).toBe(false);
    expect(view.canRetry).toBe(false);
    expect(view.shouldNavigateBack).toBe(true);
    expect(view.message).toMatch(/bereits abgeschlossen/i);
    expect(view.message).toMatch(/Tagesübersicht/i);
  });

  it("erkennt SIGNATURE_LOCKED, sperrt Retry und triggert Redirect", () => {
    const err = new ApiError({
      message: "Unterschrift ist gesperrt",
      code: "FORBIDDEN",
      status: 403,
      details: { errorCode: "SIGNATURE_LOCKED" },
    });

    const view = mapSubmitError(err);

    expect(view.isSignatureLocked).toBe(true);
    expect(view.isAlreadyCompleted).toBe(false);
    expect(view.canRetry).toBe(false);
    expect(view.shouldNavigateBack).toBe(true);
    expect(view.message).toMatch(/gesperrte Unterschrift/i);
    expect(view.message).toMatch(/Tagesübersicht/i);
  });

  it("erlaubt Retry bei Netzwerkfehler und navigiert nicht weg", () => {
    const err = new ApiError({
      message: "Network request failed",
      code: "NETWORK_ERROR",
    });

    const view = mapSubmitError(err);

    expect(view.canRetry).toBe(true);
    expect(view.shouldNavigateBack).toBe(false);
    expect(view.message).toMatch(/Verbindung/i);
  });

  it("erlaubt Retry bei generischen 5xx-Fehlern", () => {
    const err = new ApiError({
      message: "Internal Server Error",
      code: "API_ERROR",
      status: 500,
    });

    const view = mapSubmitError(err);

    expect(view.canRetry).toBe(true);
    expect(view.shouldNavigateBack).toBe(false);
    expect(view.isAlreadyCompleted).toBe(false);
    expect(view.isSignatureLocked).toBe(false);
  });

  it("nutzt die Originalmeldung bei unbekanntem 4xx-Code", () => {
    const err = new ApiError({
      message: "Validierungsfehler X",
      code: "VALIDATION_ERROR",
      status: 400,
      details: { errorCode: "FELD_FEHLT" },
    });

    const view = mapSubmitError(err);

    expect(view.canRetry).toBe(true);
    expect(view.shouldNavigateBack).toBe(false);
    expect(view.message).toBe("Validierungsfehler X");
  });

  it("verhält sich robust bei nicht-API-Fehlern", () => {
    const view = mapSubmitError(new Error("boom"));

    expect(view.canRetry).toBe(true);
    expect(view.shouldNavigateBack).toBe(false);
    expect(view.message).toBe("boom");
    expect(view.errorCode).toBeUndefined();
  });
});
