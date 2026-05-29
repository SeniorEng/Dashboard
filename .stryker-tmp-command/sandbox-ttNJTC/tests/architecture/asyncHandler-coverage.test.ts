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
 *
 * Task #776 — Von Regex-Zählung (`/app\.(get|post|...)\(/g` vs.
 * `/asyncHandler\(/g`) auf `ast-grep` umgestellt. Die alte Variante zählte nur
 * Vorkommen und konnte:
 *   - `app.get(`/`asyncHandler(` in Kommentaren oder String-Literalen
 *     mitzählen (False-Positives),
 *   - nicht prüfen, ob `asyncHandler(...)` tatsächlich ARGUMENT der jeweiligen
 *     Route-Registrierung ist (eine Route ohne Wrapper + eine doppelt
 *     gewrappte Route hätten sich in der Summe ausgeglichen).
 * Die AST-Variante prüft jetzt pro Route-Call, dass eines seiner Argumente ein
 * `asyncHandler(...)`-Aufruf ist.
 */
// @ts-nocheck

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseSource } from "./ast-grep-helpers";
import type { SgNode } from "@ast-grep/napi";

const FILE = join(
  process.cwd(),
  "server/replit_integrations/object_storage/routes.ts",
);

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

/** Liefert `<verb>` für einen `app.<verb>(...)`-Call, sonst null. */
function appRouteVerb(call: SgNode): string | null {
  const fn = call.field("function");
  if (!fn || fn.kind() !== "member_expression") return null;
  const obj = fn.field("object")?.text();
  const prop = fn.field("property")?.text();
  if (obj === "app" && prop && HTTP_VERBS.has(prop)) return prop;
  return null;
}

/** Prüft, ob innerhalb eines Route-Calls ein `asyncHandler(...)`-Aufruf steckt. */
function hasAsyncHandlerArg(call: SgNode): boolean {
  return call
    .findAll({ rule: { kind: "call_expression" } })
    .some((c) => {
      const fn = c.field("function");
      return fn?.kind() === "identifier" && fn.text() === "asyncHandler";
    });
}

describe("Architektur: Object-Storage-Routes nutzen asyncHandler (Task #676)", () => {
  const src = readFileSync(FILE, "utf8");
  const root = parseSource(src, false);

  it("importiert asyncHandler aus server/lib/errors", () => {
    expect(
      /from\s+["'][^"']*lib\/errors["']/.test(src) &&
        /\basyncHandler\b/.test(src),
      "asyncHandler-Import aus server/lib/errors fehlt in object_storage/routes.ts",
    ).toBe(true);
  });

  it("jede app.<verb>(...)-Registrierung wird über asyncHandler(...) gewrappt", () => {
    const calls = root.findAll({ rule: { kind: "call_expression" } });
    const routeCalls = calls.filter((c) => appRouteVerb(c) !== null);

    expect(
      routeCalls.length,
      "Erwarte mindestens eine Route-Registrierung in object_storage/routes.ts",
    ).toBeGreaterThan(0);

    const unwrapped = routeCalls
      .filter((c) => !hasAsyncHandlerArg(c))
      .map((c) => {
        const verb = appRouteVerb(c);
        const line = c.range().start.line + 1;
        return `app.${verb}(...) @ Zeile ${line}`;
      });

    expect(
      unwrapped,
      `Jede Route in object_storage/routes.ts MUSS asyncHandler(...) als Handler ` +
        `verwenden. Ohne Wrapper greift die zentrale Error-Konvention nicht ` +
        `(deutsche Meldungen, Stack-Trace-Logging via errorMiddleware). ` +
        `Nicht gewrappte Routen:\n  ${unwrapped.join("\n  ")}`,
    ).toEqual([]);
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
