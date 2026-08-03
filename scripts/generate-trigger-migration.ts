/**
 * Erzeugt die versionierte GoBD-Trigger-Migration AUS DER SSoT
 * (`server/startup/trigger-registry.ts`).
 *
 * Warum generiert statt handgeschrieben: Die Migration und der Laufzeit-Renderer
 * müssen exakt dieselben Objekte bauen. Eine handgepflegte SQL-Datei wäre eine
 * zweite Quelle für dieselbe Frage und würde beim nächsten Trigger-Zusatz
 * lautlos hinter dem Renderer zurückfallen. So ist sie eine Projektion — und
 * ein Test pinnt, dass die eingecheckte Datei der aktuellen Projektion
 * entspricht (`tests/startup/trigger-migration.test.ts`).
 *
 * Aufruf:  npx tsx scripts/generate-trigger-migration.ts [--check]
 *   ohne Argument  schreibt die Datei
 *   --check        vergleicht nur und endet mit exit 1 bei Abweichung
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_STARTUP_TRIGGER_FUNCTIONS,
  ALL_STARTUP_TRIGGER_SPECS,
  ORPHANED_TRIGGER_FUNCTIONS,
} from "../server/startup/trigger-registry";
import { renderCreateTriggerSql, renderDropTriggerSql } from "../server/startup/trigger-spec";

export const TRIGGER_MIGRATION_PATH = join("migrations", "0023_gobd_triggers.sql");

export function renderTriggerMigration(): string {
  const out: string[] = [];

  out.push("-- GENERIERT — NICHT VON HAND BEARBEITEN.");
  out.push("-- Quelle: server/startup/trigger-registry.ts");
  out.push("-- Neu erzeugen: npx tsx scripts/generate-trigger-migration.ts");
  out.push("--");
  out.push("-- GoBD-/Unveraenderlichkeits-Trigger als versionierte Migration (A1).");
  out.push("-- Bildet exakt ab, was der Startup-Pfad heute zur Laufzeit anlegt:");
  out.push(`--   ${ALL_STARTUP_TRIGGER_FUNCTIONS.length} Trigger-Funktionen, ${ALL_STARTUP_TRIGGER_SPECS.length} Trigger.`);
  out.push("--");
  out.push("-- Drizzle kann Trigger und Funktionen nicht ausdruecken; diese Datei ist");
  out.push("-- deshalb die handgefuehrte Haelfte des Schema-Bauplans neben der");
  out.push("-- generierten Baseline (A2).");
  out.push("");

  out.push("-- ---------------------------------------------------------------------------");
  out.push("-- 1) Verwaiste Funktionen der ersatzlos entfernten `budget_ledger`.");
  out.push("--");
  out.push("-- `drop-budget-ledger.ts` hat Tabelle und Trigger gedroppt, die Funktionen");
  out.push("-- aber nicht; am 03.08.2026 read-only in Prod nachgewiesen (14 statt 11).");
  out.push("-- BEWUSST OHNE CASCADE: haengt wider Erwarten doch etwas daran, MUSS die");
  out.push("-- Migration hier scheitern statt es still mitzureissen.");
  out.push("-- Steht am Anfang, damit dieser Fall auffaellt, bevor irgendetwas gebaut wird.");
  out.push("-- ---------------------------------------------------------------------------");
  for (const fn of ORPHANED_TRIGGER_FUNCTIONS) {
    out.push(`DROP FUNCTION IF EXISTS ${fn}();`);
  }
  out.push("");

  out.push("-- ---------------------------------------------------------------------------");
  out.push("-- 2) Trigger-Funktionen.");
  out.push("-- ---------------------------------------------------------------------------");
  for (const fn of ALL_STARTUP_TRIGGER_FUNCTIONS) {
    out.push(`-- ${fn.name}`);
    out.push(`${fn.sql.trim()};`);
    out.push("");
  }

  out.push("-- ---------------------------------------------------------------------------");
  out.push("-- 3) Trigger-Bindungen.");
  out.push("--");
  out.push("-- `DROP ... IF EXISTS` vor jedem `CREATE`, damit die Migration auf einer DB,");
  out.push("-- die den Trigger bereits per Startup-DDL traegt, idempotent bleibt.");
  out.push("-- ---------------------------------------------------------------------------");
  for (const spec of ALL_STARTUP_TRIGGER_SPECS) {
    out.push(`${renderDropTriggerSql(spec)};`);
    out.push(renderCreateTriggerSql(spec));
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function main(): void {
  const rendered = renderTriggerMigration();
  const target = join(process.cwd(), TRIGGER_MIGRATION_PATH);

  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      console.error(`[trigger-migration] ${TRIGGER_MIGRATION_PATH} fehlt.`);
      process.exit(1);
    }
    if (current !== rendered) {
      console.error(
        `[trigger-migration] ${TRIGGER_MIGRATION_PATH} weicht von der SSoT ab. ` +
          `Neu erzeugen: npx tsx scripts/generate-trigger-migration.ts`,
      );
      process.exit(1);
    }
    console.log(`[trigger-migration] ${TRIGGER_MIGRATION_PATH} ist aktuell.`);
    return;
  }

  writeFileSync(target, rendered, "utf8");
  console.log(
    `[trigger-migration] ${TRIGGER_MIGRATION_PATH} geschrieben ` +
      `(${ALL_STARTUP_TRIGGER_FUNCTIONS.length} Funktionen, ${ALL_STARTUP_TRIGGER_SPECS.length} Trigger, ` +
      `${ORPHANED_TRIGGER_FUNCTIONS.length} Orphan-Drops).`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("generate-trigger-migration.ts")) {
  main();
}
