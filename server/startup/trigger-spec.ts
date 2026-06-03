/**
 * Task #943 — Gemeinsamer Vertrag für Startup-Trigger (SSoT).
 *
 * Die GoBD-/audit_log-Immutabilitäts-Migrationen legen ihre BEFORE-Trigger per
 * rohem SQL an. Damit der Startup-Schema-Drift-Wächter
 * (`tests/startup/startup-schema-drift.test.ts`) jeden Trigger gegen seine
 * erwartete Bindung (Tabelle / Timing / Event / Level / Funktion) prüfen kann,
 * deklarieren die `ensure*`-Migrationen ihre Trigger als typisierte Specs und
 * BAUEN ihr `DROP TRIGGER IF EXISTS … / CREATE TRIGGER …` daraus. So sind das
 * laufende DDL und der Test-Vertrag dieselbe Quelle — driftet eines, driftet
 * beides.
 */
export type TriggerTiming = "BEFORE" | "AFTER";
export type TriggerLevel = "ROW" | "STATEMENT";
export type TriggerEvent = "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";

export interface StartupTriggerSpec {
  /** Trigger-Name (eindeutig pro Tabelle). */
  name: string;
  /** Tabelle, an die der Trigger gebunden ist. */
  table: string;
  timing: TriggerTiming;
  /** Auslösende Events (z.B. ["UPDATE"], ["TRUNCATE"]). */
  events: TriggerEvent[];
  level: TriggerLevel;
  /** Name der ausführenden Trigger-Funktion. */
  functionName: string;
}

/** `CREATE TRIGGER`-DDL aus einer Spec rendern (gegen `table` ODER einen Probe-Namen). */
export function renderCreateTriggerSql(
  spec: StartupTriggerSpec,
  table: string = spec.table,
  triggerName: string = spec.name,
): string {
  return (
    `CREATE TRIGGER ${triggerName}\n` +
    `    ${spec.timing} ${spec.events.join(" OR ")} ON ${table}\n` +
    `    FOR EACH ${spec.level} EXECUTE FUNCTION ${spec.functionName}();`
  );
}

/** `DROP TRIGGER IF EXISTS`-DDL aus einer Spec rendern. */
export function renderDropTriggerSql(spec: StartupTriggerSpec): string {
  return `DROP TRIGGER IF EXISTS ${spec.name} ON ${spec.table}`;
}
