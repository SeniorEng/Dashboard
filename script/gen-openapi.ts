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

function serialize(): string {
  const doc = buildOpenApiDocument();
  return JSON.stringify(doc, null, 2) + "\n";
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
      console.error(
        "[gen:openapi] API-Schema geändert, committete OpenAPI-Spec ist veraltet.\n" +
          "             Bitte `npm run gen:openapi` ausführen und docs/api/openapi.json committen.",
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
