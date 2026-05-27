/**
 * Task #676 — Architektur-Test: Object-Storage-Routes nutzen `asyncHandler`.
 *
 * Hintergrund: `server/replit_integrations/object_storage/routes.ts` hatte
 * früher manuelle try/catch-Blöcke mit englischen Fehlermeldungen und ohne
 * zentralen Error-Mapper. Diese Datei wurde im Rahmen von Task #676 auf den
 * `asyncHandler(...)`-Wrapper aus `server/lib/errors.ts` umgestellt, damit
 * Fehler einheitlich behandelt, Stack-Traces erhalten und Meldungen deutsch
 * ausgespielt werden. Damit dieselbe Falle nicht wieder einzieht, prüft dieser
 * Test, dass jede Express-Route-Registrierung in dieser Datei einen
 * `asyncHandler(...)`-Aufruf als Handler-Argument verwendet.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const FILE = join(
  process.cwd(),
  "server/replit_integrations/object_storage/routes.ts",
);

const ROUTE_REGISTRATION = /\bapp\.(get|post|put|patch|delete)\s*\(/g;
const ASYNC_HANDLER_CALL = /\basyncHandler\s*\(/g;

describe("Architektur: Object-Storage-Routes nutzen asyncHandler (Task #676)", () => {
  const src = readFileSync(FILE, "utf8");

  it("importiert asyncHandler aus server/lib/errors", () => {
    expect(
      /from\s+["'][^"']*lib\/errors["']/.test(src) &&
        /\basyncHandler\b/.test(src),
      "asyncHandler-Import aus server/lib/errors fehlt in object_storage/routes.ts",
    ).toBe(true);
  });

  it("jede app.<verb>(...)-Registrierung wird über asyncHandler(...) gewrappt", () => {
    const routeCount = (src.match(ROUTE_REGISTRATION) ?? []).length;
    const handlerCount = (src.match(ASYNC_HANDLER_CALL) ?? []).length;

    expect(
      routeCount,
      "Erwarte mindestens eine Route-Registrierung in object_storage/routes.ts",
    ).toBeGreaterThan(0);

    expect(
      handlerCount,
      `Jede Route in object_storage/routes.ts MUSS asyncHandler(...) verwenden. ` +
        `Gefunden: ${routeCount} Route(s), aber nur ${handlerCount} asyncHandler-Aufruf(e). ` +
        `Manuelles try/catch + res.status().json() bricht die zentrale Error-Konvention ` +
        `(deutsche Meldungen, Stack-Trace-Logging via errorMiddleware).`,
    ).toBeGreaterThanOrEqual(routeCount);
  });

  it("enthält keine englischen Fallback-Fehlermeldungen mehr", () => {
    const forbidden = [
      "Failed to generate upload URL",
      "Failed to serve object",
      "Object not found",
      "Missing required field",
    ];
    const offenders = forbidden.filter((s) => src.includes(s));
    expect(
      offenders,
      "Englische Fehlermeldungen in object_storage/routes.ts gefunden — " +
        "bitte deutsche Meldungen über badRequest()/notFound()/asyncHandler-Default verwenden.",
    ).toEqual([]);
  });
});
