/**
 * Task #1238 (Phase 0.2 — Architektur-Wächter) — SSoT-Import-Wächter.
 *
 * Hintergrund: Drift zwischen Anzeige und Buchung entsteht, sobald dieselbe
 * fachliche Frage an zwei Orten beantwortet wird. Diese Fitness-Functions
 * verankern drei SSoTs am Import-/Definitions-Rand (statisch, KEINE
 * Laufzeit-Änderung):
 *
 *   A1  „Verfügbar?" / Cap — `computeCapSlot` (Cap-SSoT) und `computeCapRemaining`
 *       (pure Cap-Math) dürfen nur Budget-intern importiert werden; Verfügbarkeit
 *       wird über `readUnifiedBudgetAvailability` gelesen, nicht selbst gerechnet.
 *   A2  „Monat zu?" — `get(Admin)MonthClosingReadiness` darf nur im
 *       Monatsabschluss-SSoT-Modul DEFINIERT werden (Fassade = Property-Zuweisung,
 *       keine Re-Definition).
 *   A3  „Dokumentiert?" — keine eigene `signature_data IS [NOT] NULL`- bzw.
 *       `isNull/isNotNull(signatureData)`-Bedingung außerhalb der dokumentiert-SSoT
 *       (`server/lib/appointment-signed.ts`).
 *
 * Jeder Detektor ist PUR und wird vom Real-Tree-Scan UND vom Negativ-Test mit
 * DERSELBEN Funktion aufgerufen — der Negativ-Test beweist nachweislich, dass
 * eine bewusste Verletzung das Gate bricht.
 */
import { describe, it, expect } from "vitest";
import { parseSource, collectNamedFunctions } from "./ast-grep-helpers";
import {
  collectScanFiles,
  stripComments,
  formatViolations,
  type ScanFile,
  type GuardViolation,
} from "./guard-helpers";

// ---------------------------------------------------------------------------
// A1 — Cap-/Verfügbarkeits-SSoT (Import-Rand)
// ---------------------------------------------------------------------------

/** `computeCapSlot` darf nur in diesen Budget-internen Dateien importiert werden. */
const CAP_SLOT_IMPORT_ALLOWLIST = new Set<string>([
  "server/storage/budget/unified-reader.ts",
  "server/storage/budget/summary-queries.ts",
  "server/storage/budget/consumption-engine.ts",
]);

/**
 * `computeCapRemaining` (pure Cap-Math) darf nur vom Cap-Calculator und innerhalb
 * der Budget-Domain importiert werden (Pfad-Präfix-Allowlist).
 */
const CAP_REMAINING_IMPORT_ALLOWLIST = ["server/storage/budget/cap-calculator.ts", "shared/domain/budget/"];

/**
 * Matcht ein `import`/`export … { … SYM … } from "…"`-Statement (auch
 * mehrzeilig und mit Default-/Namespace-Präfix wie `import Foo, { SYM }`).
 * Re-Export-Spezifizierer (`export { SYM } from "…"`) sind eingeschlossen.
 */
function namedImportFromRe(symbol: string): RegExp {
  return new RegExp(
    String.raw`(?:import|export)\b[^{};]*\{[^}]*\b${symbol}\b[^}]*\}\s*from\s*["'][^"']+["']`,
  );
}

export function detectCapSsotImportViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  const capSlotRe = namedImportFromRe("computeCapSlot");
  const capRemainingRe = namedImportFromRe("computeCapRemaining");
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    const code = stripComments(content);
    if (capSlotRe.test(code) && !CAP_SLOT_IMPORT_ALLOWLIST.has(rel)) {
      out.push({
        file: rel,
        detail: "importiert `computeCapSlot` (Cap-SSoT) außerhalb der Budget-internen Allowlist",
      });
    }
    if (
      capRemainingRe.test(code) &&
      !CAP_REMAINING_IMPORT_ALLOWLIST.some((p) => rel === p || rel.startsWith(p))
    ) {
      out.push({
        file: rel,
        detail: "importiert `computeCapRemaining` (pure Cap-Math) außerhalb von cap-calculator.ts / shared/domain/budget/",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A2 — Monatsabschluss-Readiness-SSoT (Definitions-Rand)
// ---------------------------------------------------------------------------

const READINESS_CANONICAL = "server/storage/time-tracking/month-closing.ts";
const READINESS_NAME_RE = /MonthClosingReadiness$/;

export function detectReadinessDefinitionViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (rel === READINESS_CANONICAL) continue;
    const astRoot = parseSource(content, rel.endsWith(".tsx"));
    for (const { name, line } of collectNamedFunctions(astRoot)) {
      if (READINESS_NAME_RE.test(name)) {
        out.push({ file: rel, line, detail: `definiert \`${name}\` außerhalb des Readiness-SSoT-Moduls` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A3 — „Dokumentiert?"-SSoT (Query-Rand)
// ---------------------------------------------------------------------------

/**
 * Die einzige Datei mit der rohen Unterschrift-Null-Prüfung ist die SSoT selbst;
 * die Migration `migrate-expired-unsigned-appointments.ts` ist eine bewusste,
 * dokumentierte Einmal-Korrektur (kein Request-Pfad).
 */
const DOCUMENTED_PREDICATE_ALLOWLIST = new Set<string>([
  "server/lib/appointment-signed.ts",
  "server/startup/migrate-expired-unsigned-appointments.ts",
]);

const RAW_SIGNATURE_NULL_RE = /signature_data\s+IS\s+(?:NOT\s+)?NULL/i;
const DRIZZLE_SIGNATURE_NULL_RE = /\b(?:isNull|isNotNull)\s*\(\s*[A-Za-z0-9_.]*\bsignatureData\b/;

export function detectDocumentedPredicateViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (DOCUMENTED_PREDICATE_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    if (RAW_SIGNATURE_NULL_RE.test(code)) {
      out.push({ file: rel, detail: "baut eine eigene rohe `signature_data IS [NOT] NULL`-Bedingung statt der dokumentiert-SSoT" });
    }
    if (DRIZZLE_SIGNATURE_NULL_RE.test(code)) {
      out.push({ file: rel, detail: "baut eine eigene `isNull/isNotNull(signatureData)`-Bedingung statt der dokumentiert-SSoT" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Architektur — SSoT-Import-Wächter (Task #1238)", () => {
  const regexScanFiles = collectScanFiles(["server", "shared", "client/src"], { includeTsx: true });
  const readinessScanFiles = collectScanFiles(["server", "shared"]);

  it("A1: `computeCapSlot`/`computeCapRemaining` werden nur aus dem Cap-SSoT importiert", () => {
    const v = detectCapSsotImportViolations(regexScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Cap-/Verfügbarkeits-SSoT verletzt — die folgende(n) Datei(en) importieren die Cap-Mathematik direkt:\n" +
          formatViolations(v) +
          "\n\nVerfügbarkeit/Cap MUSS über `readUnifiedBudgetAvailability` " +
          "(server/storage/budget/unified-reader.ts) gelesen werden. Ist der Import " +
          "ein bewusst neuer Budget-interner Konsument, ergänze die Allowlist in " +
          "tests/architecture/ssot-imports.test.ts.",
      );
    }
  });

  it("A1 (Negativ): ein bewusst eingebauter Cap-Import wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-cap-route.ts",
        content: `import { computeCapSlot } from "../storage/budget/cap-calculator";\nexport const x = 1;`,
      },
      {
        rel: "client/src/features/budget/fake-cap-math.ts",
        content: `import { computeCapRemaining } from "@shared/domain/budget/cap-math";`,
      },
    ];
    const v = detectCapSsotImportViolations(synthetic);
    expect(v.map((h) => h.file)).toEqual([
      "server/routes/fake-cap-route.ts",
      "client/src/features/budget/fake-cap-math.ts",
    ]);
  });

  it("A2: Readiness-Funktionen werden nur im Monatsabschluss-SSoT-Modul definiert", () => {
    const v = detectReadinessDefinitionViolations(readinessScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Readiness-SSoT verletzt — `get(Admin)MonthClosingReadiness` außerhalb des SSoT-Moduls definiert:\n" +
          formatViolations(v) +
          "\n\nDie Monatsabschluss-Readiness lebt ausschließlich in " +
          "server/storage/time-tracking/month-closing.ts. Importiere/rufe sie auf, " +
          "statt sie neu zu definieren.",
      );
    }
  });

  it("A2 (Negativ): eine bewusst eingebaute Readiness-Definition wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-readiness.ts",
        content: `export async function getMonthClosingReadiness() {\n  return { ready: true };\n}`,
      },
    ];
    const v = detectReadinessDefinitionViolations(synthetic);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].file).toBe("server/routes/fake-readiness.ts");
  });

  it("A3: keine eigene `signature_data`-/`signatureData`-Bedingung außerhalb der dokumentiert-SSoT", () => {
    const v = detectDocumentedPredicateViolations(regexScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Dokumentiert-SSoT verletzt — eigene Unterschrift-Null-Prüfung gefunden:\n" +
          formatViolations(v) +
          "\n\nDie Frage „dokumentiert & unterschrieben?" +
          "\u201c gehört ausschließlich in server/lib/appointment-signed.ts " +
          "(bzw. das reine Prädikat in shared/domain/appointments.ts). Nutze die dort " +
          "exportierten Bedingungen statt einer eigenen signature_data-Prüfung.",
      );
    }
  });

  it("A3 (Negativ): eine bewusst gebaute completed-/signature-Bedingung wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-doc-raw.ts",
        content: "const q = sql`a.status = 'completed' AND a.signature_data IS NOT NULL`;",
      },
      {
        rel: "server/routes/fake-doc-drizzle.ts",
        content: `const q = and(eq(appointments.status, "completed"), isNotNull(appointments.signatureData));`,
      },
    ];
    const v = detectDocumentedPredicateViolations(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/routes/fake-doc-drizzle.ts",
      "server/routes/fake-doc-raw.ts",
    ]);
  });
});
