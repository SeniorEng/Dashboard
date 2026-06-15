/**
 * Task #1301 (Phase 1 — additiver Aufbau) — Preis-Lese-Pfad-Wächter (ENTSCHÄRFT).
 *
 * Ziel-Architektur: Die fachliche Frage „Preis?" hat genau EINE Quelle — die
 * konsolidierte `prices`-Tabelle hinter der `priceFor`-SSoT. Direkte Reads der
 * drei Alt-Tabellen (`customer_service_prices`, `customer_contract_rates`,
 * `service_rates`) außerhalb der SSoT erzeugen Drift zwischen Anzeige und
 * Buchung.
 *
 * Dieser Detektor ist PUR und wird vom Negativ-Test mit DERSELBEN Funktion
 * aufgerufen — der Negativ-Test beweist nachweislich, dass eine Verletzung das
 * Gate bricht. Der Real-Tree-Scan ist in dieser Phase BEWUSST `it.skip`
 * (entschärft): die Alt-Tabellen werden noch additiv parallel gelesen
 * (price-for.ts/csp, contracts.ts/service_rates, der service-prices-Router,
 * Report-/Shadow-Diff-Skripte). SCHARFSCHALTUNG erst beim Cutover (Task #1303):
 * `it.skip` → `it` umstellen UND `POST_CUTOVER_ALLOWLIST` final ziehen.
 */
import { describe, it, expect } from "vitest";
import {
  collectScanFiles,
  stripComments,
  formatViolations,
  type ScanFile,
  type GuardViolation,
} from "./guard-helpers";

/** Drizzle-Tabellen-Variablen der drei Alt-Preis-Quellen. */
const OLD_PRICE_TABLE_VARS = ["customerContractRates", "serviceRates", "customerServicePrices"] as const;

/** Matcht einen Drizzle-Lesezugriff `.from(<tableVar>)` auf eine Alt-Tabelle. */
function fromTableRe(varName: string): RegExp {
  return new RegExp(String.raw`\.from\(\s*${varName}\b`);
}

export function detectOldPriceTableReadViolations(
  files: ScanFile[],
  allowlist: ReadonlySet<string>,
): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (allowlist.has(rel)) continue;
    const code = stripComments(content);
    for (const v of OLD_PRICE_TABLE_VARS) {
      if (fromTableRe(v).test(code)) {
        out.push({
          file: rel,
          detail: `liest Alt-Preis-Tabelle \`${v}\` direkt (statt der konsolidierten prices-/priceFor-SSoT)`,
        });
      }
    }
  }
  return out;
}

/**
 * Beim Cutover (Task #1303) final zu ziehende Allowlist der dann noch legitimen
 * Alt-Tabellen-Leser (Migrations-/Report-Skripte etc.). Heute nur ein Platzhalter
 * — der Real-Tree-Test ist entschärft (`it.skip`).
 */
const POST_CUTOVER_ALLOWLIST = new Set<string>([
  "server/scripts/report-price-consolidation-conflicts.ts",
  "server/scripts/populate-prices.ts",
]);

describe("Architektur — Preis-Lese-Pfad-SSoT (Task #1301, entschärft)", () => {
  const scanFiles = collectScanFiles(["server", "shared", "client/src"], { includeTsx: true });

  it("Negativ: erkennt direkte Reads der drei Alt-Preis-Tabellen", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-contract-rate-read.ts",
        content: `const r = await db.select().from(customerContractRates).where(eq(customerContractRates.contractId, id));`,
      },
      {
        rel: "server/routes/fake-service-rate-read.ts",
        content: `const r = await db.select().from(serviceRates);`,
      },
      {
        rel: "server/storage/pricing/price-for.ts",
        content: `const r = await db.select().from(customerServicePrices);`,
      },
    ];
    // Mit leerer Allowlist werden alle drei erkannt …
    const all = detectOldPriceTableReadViolations(synthetic, new Set());
    expect(all.map((h) => h.file).sort()).toEqual([
      "server/routes/fake-contract-rate-read.ts",
      "server/routes/fake-service-rate-read.ts",
      "server/storage/pricing/price-for.ts",
    ]);
    // … und eine Allowlist-Datei wird korrekt ausgenommen.
    const allowed = detectOldPriceTableReadViolations(
      synthetic,
      new Set(["server/storage/pricing/price-for.ts"]),
    );
    expect(allowed.map((h) => h.file).sort()).toEqual([
      "server/routes/fake-contract-rate-read.ts",
      "server/routes/fake-service-rate-read.ts",
    ]);
  });

  // SCHARF erst beim Cutover (Task #1303): von `it.skip` auf `it` umstellen und
  // POST_CUTOVER_ALLOWLIST final ziehen. Heute entschärft, da die Alt-Tabellen
  // noch bewusst additiv parallel gelesen werden.
  it.skip("(SCHARF erst beim Cutover) keine direkten Alt-Preis-Tabellen-Reads außerhalb der SSoT", () => {
    const v = detectOldPriceTableReadViolations(scanFiles, POST_CUTOVER_ALLOWLIST);
    if (v.length > 0) {
      expect.fail(
        "Preis-Lese-Pfad-SSoT verletzt — direkte Reads der Alt-Preis-Tabellen gefunden:\n" +
          formatViolations(v) +
          "\n\nDie Frage „Preis?" +
          "\u201c wird ausschließlich über die konsolidierte `prices`-Tabelle hinter der " +
          "`priceFor`-SSoT beantwortet.",
      );
    }
  });
});
