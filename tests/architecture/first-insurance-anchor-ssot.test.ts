/**
 * Task #1910 — Wächter für die SSoT „ab wann gilt die ERSTE
 * Kostenträger-Zuordnung?" (`firstInsuranceAnchorISO`).
 *
 * Die Funktion normalisiert das `validFrom` einer ERSTZUORDNUNG (Minimum aus
 * angefragtem Datum und Vertragsbeginn, abgerundet auf den Monatsersten). Jeder
 * WEITERE Wechsel bleibt hart auf den Monatsersten begrenzt und wird NICHT
 * normalisiert — #1893.
 *
 * Warum ein eigener Wächter und nicht `insurance-at-date` mitbenutzen: die
 * beiden Fragen haben verschiedene Fehlerklassen. Ein falscher STICHTAG ordnet
 * einen Abrechnungsmonat der falschen Kasse zu; ein falscher ANKER lässt
 * vergangene Monate ganz ohne Kostenträger stehen. Und die Gefahr hier ist
 * spiegelbildlich: würde der Anker auf einem WECHSEL-Pfad angewandt, würde ein
 * Wechseldatum still zurückdatiert — also genau der Fehler, den #1893 abgestellt
 * hat, nur andersherum.
 *
 * Der Detektor ist PUR und wird vom Real-Tree-Scan UND vom Negativ-Test mit
 * DERSELBEN Funktion aufgerufen.
 *
 * GRENZE: ein Namens-Stolperdraht, keine Datenflussanalyse. Er sieht den Aufruf,
 * nicht, ob der aufrufende Zweig wirklich eine Erstzuordnung ist. Die
 * fachliche Bedingung (`isFirstAssignment`) bleibt Sache des Reviews.
 */
import { describe, it, expect } from "vitest";
import {
  collectScanFiles,
  stripComments,
  type ScanFile,
  type GuardViolation,
} from "./guard-helpers";
import { ssotGuardAllowlist } from "@shared/ssot-registry";

const ALLOWLIST = new Set<string>(
  ssotGuardAllowlist("first-insurance-anchor", "FIRST_INSURANCE_ANCHOR_ALLOWLIST"),
);

/** Aufruf der Anker-Funktion — nicht bloße Erwähnung (Kommentare sind gestrippt). */
const ANCHOR_CALL_RE = /\bfirstInsuranceAnchorISO\s*\(/;

export function detectFirstInsuranceAnchorViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    if (!ANCHOR_CALL_RE.test(code)) continue;
    const lineIdx = content.split("\n").findIndex((l) => ANCHOR_CALL_RE.test(l));
    out.push({
      file: rel,
      line: lineIdx >= 0 ? lineIdx + 1 : undefined,
      detail:
        "ruft `firstInsuranceAnchorISO` außerhalb der Erstzuordnung auf — ein WECHSEL-Datum " +
        "darf nie zurückdatiert werden (#1893)",
    });
  }
  return out;
}

describe("Architektur — SSoT „Anker der Erstzuordnung“ (Task #1910)", () => {
  it("wird nur in der Erstzuordnung angewandt", () => {
    const files = collectScanFiles(["server", "shared", "client/src"], { includeTsx: true });
    // Sicherung gegen einen leeren Scan (falsch-grüner Wächter).
    expect(files.length).toBeGreaterThan(100);
    const v = detectFirstInsuranceAnchorViolations(files);
    if (v.length > 0) {
      expect.fail(
        "Anker-SSoT verletzt:\n" +
          v.map((x) => `  ${x.file}${x.line ? ":" + x.line : ""} — ${x.detail}`).join("\n") +
          "\n\nDie Normalisierung gehört ausschließlich in den Erstzuordnungs-Zweig " +
          "(`server/storage/customer-mgmt/insurance.ts`). Jede weitere Zuordnung ist " +
          "ein Wechsel und bleibt hart auf den Monatsersten begrenzt.",
      );
    }
  });

  it("Negativ: ein zweiter Aufrufer bricht das Gate", () => {
    const v = detectFirstInsuranceAnchorViolations([
      {
        rel: "server/routes/fake-insurance.ts",
        content: "const vf = firstInsuranceAnchorISO(req.body.validFrom, null, todayISO());",
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].file).toBe("server/routes/fake-insurance.ts");
    expect(v[0].line).toBe(1);
  });

  it("Negativ: eine reine Kommentar-Erwähnung bricht das Gate NICHT", () => {
    const v = detectFirstInsuranceAnchorViolations([
      {
        rel: "server/routes/fake-insurance.ts",
        content: "// firstInsuranceAnchorISO( wird hier bewusst NICHT benutzt\nconst x = 1;",
      },
    ]);
    expect(v).toEqual([]);
  });
});
