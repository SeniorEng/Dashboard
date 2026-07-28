/**
 * Generator + Drift-Gate für die OpenAPI-Spec (Task #775).
 *
 *   npm run gen:openapi            → schreibt docs/api/openapi.json
 *   npm run gen:openapi -- --check → vergleicht ohne zu schreiben; exit 1 bei Drift
 *
 * Die Spec wird ausschließlich aus den Zod-Schemas in `shared/api/openapi.ts`
 * erzeugt. Bei Schema-Änderungen ohne committetes Spec-Update failt der
 * `--check`-Lauf (CI-Gate), damit Frontend/Backend nicht silent driften.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenApiDocument } from "../shared/api/openapi";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, "../docs/api/openapi.json");

/**
 * Normalisiert die Objekt-Schlüssel-Reihenfolge rekursiv (deterministisch).
 *
 * Der zod-to-openapi-Generator gibt `components.schemas`/`paths` (und deren
 * verschachtelte Objekte) in Registrierungs-/Referenz-Reihenfolge aus. Diese
 * hängt an der Modul-Import-/Auflösungs-Reihenfolge und kann zwischen
 * Umgebungen driften → das `--check`-Gate wurde CI-flaky, obwohl das Schema
 * unverändert war. Durch Sortieren ALLER Objekt-Schlüssel vor der
 * Serialisierung wird die Ausgabe byte-stabil, unabhängig von der Ursache.
 *
 * Arrays bleiben unangetastet — ihre Reihenfolge ist in OpenAPI semantisch
 * (z. B. `required`, `enum`, `parameters`, `tags`). Nur Objekt-Schlüssel
 * werden umsortiert; die JSON-/OpenAPI-Semantik ist davon unberührt.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function serialize(): string {
  const doc = buildOpenApiDocument();
  return JSON.stringify(sortKeysDeep(doc), null, 2) + "\n";
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const next = serialize();

  if (checkOnly) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error(
        "[gen:openapi] docs/api/openapi.json fehlt. Bitte `npm run gen:openapi` ausführen und committen.",
      );
      process.exit(1);
    }
    const current = readFileSync(OUTPUT_PATH, "utf8");
    if (current !== next) {
      const curLines = current.split("\n");
      const nextLines = next.split("\n");
      const diffs: string[] = [];
      const max = Math.max(curLines.length, nextLines.length);
      for (let i = 0; i < max && diffs.length < 60; i++) {
        if (curLines[i] !== nextLines[i]) {
          if (curLines[i] !== undefined) diffs.push(`  - [committed ${i + 1}] ${curLines[i]}`);
          if (nextLines[i] !== undefined) diffs.push(`  + [generated ${i + 1}] ${nextLines[i]}`);
        }
      }
      console.error(
        "[gen:openapi] API-Schema geändert, committete OpenAPI-Spec ist veraltet.\n" +
          "             Bitte `npm run gen:openapi` ausführen und docs/api/openapi.json committen.\n" +
          `             committed: ${curLines.length} Zeilen, generiert: ${nextLines.length} Zeilen.\n` +
          "             Erste Abweichungen (- committed / + generiert):\n" +
          diffs.join("\n"),
      );
      process.exit(1);
    }
    console.log("[gen:openapi] OK — Spec ist aktuell.");
    return;
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, next, "utf8");
  console.log(`[gen:openapi] geschrieben: ${OUTPUT_PATH}`);
}

main();
