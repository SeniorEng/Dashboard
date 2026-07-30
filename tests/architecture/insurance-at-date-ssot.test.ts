/**
 * Task #1893 (Architektur-Wächter) — Kostenträger-am-Stichtag-SSoT.
 *
 * Hintergrund: Alle Abrechnungs-Lesestellen filterten
 * `customer_insurance_history` mit `valid_to IS NULL` („aktuelle Zuordnung“),
 * obwohl die Tabelle `valid_from`/`valid_to` führt. Folge in Prod: eine
 * Mai-Rechnung ging an die im JULI gültige Kasse. Derselbe
 * `todayISO()`-statt-Stichtag-Fehler wie beim §45b-Bug.
 *
 * Dieser Wächter verankert den Lese-Rand: außerhalb der SSoT-Module und der
 * Stammdaten-Pfade darf niemand mehr „die aktuelle Zuordnung“ direkt lesen.
 * Abrechnung und Versand gehen über `resolveCustomerInsuranceAt` (Row) bzw.
 * `insuranceValidAt`/`insuranceValidAtSqlRaw` (SQL-Join) mit dem Stichtag aus
 * `billingPeriodAsOfISO`.
 *
 * Der Detektor ist PUR und wird vom Real-Tree-Scan UND vom Negativ-Test mit
 * DERSELBEN Funktion aufgerufen — der Negativ-Test beweist, dass eine bewusste
 * Verletzung das Gate bricht.
 */
import { describe, it, expect } from "vitest";
import { ssotGuardAllowlist } from "@shared/ssot-registry";
import {
  collectScanFiles,
  stripComments,
  formatViolations,
  type ScanFile,
  type GuardViolation,
} from "./guard-helpers";

/**
 * Erlaubte Dateien — aus der SSoT-Registry, nicht hart gehalten.
 * (`shared/ssot-registry.ts` → Eintrag `insurance-at-date`.)
 */
const ALLOWLIST = new Set<string>(
  ssotGuardAllowlist("insurance-at-date", "CURRENT_INSURANCE_READ_ALLOWLIST"),
);

/**
 * Trifft die beiden Schreibweisen des „aktuelle Zuordnung“-Lesens:
 *   - Roh-SQL:  `cih.valid_to IS NULL`, `valid_to IS NULL`
 *   - Drizzle:  `isNull(customerInsuranceHistory.validTo)`
 *
 * Bewusst NICHT getroffen wird das legitime Fenster-Prädikat
 * `valid_to IS NULL OR valid_to >= …` — dort ist `IS NULL` Teil der
 * Stichtags-Bedingung, nicht des „aktuell“-Filters.
 */
export function findCurrentInsuranceReads(files: ScanFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (ALLOWLIST.has(file.rel)) continue;

    const stripped = stripComments(file.content);
    // Nur Dateien, die die Tabelle überhaupt anfassen.
    if (
      !stripped.includes("customer_insurance_history") &&
      !stripped.includes("customerInsuranceHistory")
    ) {
      continue;
    }

    const lines = stripped.split("\n");
    lines.forEach((line, idx) => {
      if (/isNull\(\s*customerInsuranceHistory\.validTo\s*\)/.test(line)) {
        violations.push({
          file: file.rel,
          line: idx + 1,
          detail:
            "isNull(customerInsuranceHistory.validTo) — „aktuelle Zuordnung“ statt Stichtag. Nutze resolveCustomerInsuranceAt(customerId, asOf) bzw. insuranceValidAt(asOf).",
        });
      }
      // Roh-SQL: `valid_to IS NULL`, aber NICHT als Teil von `IS NULL OR … >=`.
      if (/valid_to\s+IS\s+NULL/i.test(line) && !/IS\s+NULL\s+OR/i.test(line)) {
        violations.push({
          file: file.rel,
          line: idx + 1,
          detail:
            "`valid_to IS NULL` — „aktuelle Zuordnung“ statt Stichtag. Nutze insuranceValidAtSqlRaw(alias, asOf).",
        });
      }
    });
  }

  return violations;
}

describe("Architektur — Kostenträger am Stichtag (Task #1893)", () => {
  it("kein direktes „aktuelle Zuordnung“-Lesen außerhalb der SSoT-/Stammdaten-Pfade", () => {
    const files = collectScanFiles(["server", "shared"]);
    const violations = findCurrentInsuranceReads(files);

    if (violations.length > 0) {
      expect.fail(
        "Abrechnungs-/Versandpfade dürfen die Kasse nicht mit `valid_to IS NULL` lesen.\n" +
          "Stichtag = Ende des Abrechnungszeitraums (billingPeriodAsOfISO):\n" +
          formatViolations(violations),
      );
    }
    expect(violations).toEqual([]);
  });

  it("Negativ-Test: eine bewusste Verletzung bricht das Gate", () => {
    const fake: ScanFile[] = [
      {
        rel: "server/services/fake-invoice-sender.ts",
        content: `
          import { customerInsuranceHistory } from "@shared/schema";
          const rows = await db.select().from(customerInsuranceHistory)
            .where(and(eq(customerInsuranceHistory.customerId, id), isNull(customerInsuranceHistory.validTo)));
        `,
      },
    ];
    const violations = findCurrentInsuranceReads(fake);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("server/services/fake-invoice-sender.ts");
  });

  it("Negativ-Test: Roh-SQL-Variante wird ebenfalls erkannt", () => {
    const fake: ScanFile[] = [
      {
        rel: "server/storage/fake-payer-filter.ts",
        content: `
          const f = sql\`SELECT cih.customer_id FROM customer_insurance_history cih
            WHERE cih.valid_to IS NULL AND cih.insurance_provider_id = 1\`;
        `,
      },
    ];
    expect(findCurrentInsuranceReads(fake)).toHaveLength(1);
  });

  it("das legitime Stichtags-Prädikat (`IS NULL OR >= asOf`) löst NICHT aus", () => {
    const fake: ScanFile[] = [
      {
        rel: "server/storage/fake-ok.ts",
        content: `
          const f = sql\`SELECT 1 FROM customer_insurance_history cih
            WHERE cih.valid_from <= \${asOf} AND (cih.valid_to IS NULL OR cih.valid_to >= \${asOf})\`;
        `,
      },
    ];
    expect(findCurrentInsuranceReads(fake)).toEqual([]);
  });
});
