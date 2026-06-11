/**
 * Task #1204 — Architektur-Schranke: kein gespeicherter Budget-Anker mehr.
 *
 * Hintergrund: Der Budget-Anker wird seit Task #1204 zur Laufzeit PRO TOPF aus
 * der Pflegegrad-Historie abgeleitet (§45a/§39 = roher frühester Pflegegrad-
 * Beginn, uncapped; §45b = auf den 1.1. des laufenden Jahres gebodet). Die
 * früher kundenweit gespeicherten Spalten `customer_budget_preferences.
 * budget_start_date` und `budget_start_date_origin` sowie der Origin-Wert
 * `'manual'` wurden ersatzlos entfernt (Schema, Storage, Startup-Migration
 * droppt die Spalten idempotent).
 *
 * Diese Schranke verhindert, dass jemand versehentlich einen neuen Lese-/
 * Schreibpfad gegen die entfernten Spalten wiederbelebt. Geprüft wird, dass in
 * produktivem Code (`server/`, `client/src/`, `shared/`) weder der Drizzle-/
 * SQL-Spaltenname `budget_start_date` / `budgetStartDateOrigin` noch der
 * Origin-Sonderwert auftauchen.
 *
 * Bewusst NICHT gescannt: `tests/` (Fixtures dürfen `budgetStartDate` weiterhin
 * als per-Topf-Payload-Feld an `/initial-budget` senden — das ist KEIN
 * gespeicherter Kunden-Anker, sondern der validFrom-Hebel der Startwert-Route).
 *
 * Failure-Modus: Test schlägt fehl mit Datei:Zeile jedes Treffers. Wer einen
 * Treffer sieht, hat den gelöschten gespeicherten Anker (re-)eingeführt — der
 * Anker ist Laufzeit-abgeleitet (siehe shared/domain budget-anchor / allocation-
 * storage Lesepfade).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { ROOT, walkTsFiles } from "./ast-grep-helpers";

// Dateien, die einen Treffer legitim enthalten dürfen, weil sie die Spalten
// ausschließlich ENTFERNEN (DROP) — kein Read-/Write-Pfad.
const ALLOWED_FILES = new Set<string>([
  "server/startup/drop-budget-start-date-columns.ts",
]);

// SQL-Spalten-Name (snake_case) der entfernten gespeicherten Anker-Spalten.
const SQL_COLUMN_RE = /\bbudget_start_date(_origin)?\b/;
// Drizzle-/TS-Bezeichner der entfernten Spalte + des entfernten Origin-Felds.
const DRIZZLE_IDENT_RE = /\bbudgetStartDateOrigin\b/;

/**
 * Entfernt Kommentare zeilenerhaltend (Block- und Zeilen-Kommentare werden
 * durch Leerzeichen ersetzt, Zeilenumbrüche bleiben). So treffen die Regexes
 * nur ECHTEN Code, nicht die erklärende Prosa, die den Wegfall der Spalten
 * dokumentiert. Bewusst simpel (keine String-Literal-Awareness) — für die
 * Bezeichner-Suche genügt das, der DROP-Pfad ist ohnehin allowlistet.
 */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("Architektur — kein gespeicherter Budget-Anker mehr (Task #1204)", () => {
  it("Kein Lese-/Schreibpfad gegen budget_start_date / budgetStartDateOrigin in Prod-Code", () => {
    const hits: Array<{ file: string; line: number; snippet: string }> = [];

    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walkTsFiles(root)) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (rel.startsWith("tests/")) continue;
        if (ALLOWED_FILES.has(rel)) continue;
        const lines = stripComments(readFileSync(file, "utf-8")).split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (SQL_COLUMN_RE.test(line) || DRIZZLE_IDENT_RE.test(line)) {
            hits.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 140) });
          }
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits.map((h) => `  ${h.file}:${h.line} — ${h.snippet}`).join("\n");
      expect.fail(
        `Folgende Stellen greifen auf den entfernten gespeicherten Budget-Anker zu:\n` +
        `${msg}\n\n` +
        `Die Spalten 'budget_start_date'/'budget_start_date_origin' wurden mit Task #1204 ` +
        `gedroppt. Der Anker wird zur Laufzeit PRO TOPF aus der Pflegegrad-Historie ` +
        `abgeleitet (§45a/§39 roh, §45b aufs laufende Jahr gebodet). Entferne den Zugriff ` +
        `oder — falls die Datei die Spalten nur droppt — trage sie in ALLOWED_FILES ein.`,
      );
    }
  });
});
