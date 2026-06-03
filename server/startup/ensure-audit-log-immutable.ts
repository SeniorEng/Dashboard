import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";
import {
  type StartupTriggerSpec,
  renderCreateTriggerSql,
  renderDropTriggerSql,
} from "./trigger-spec";

// Task #943 — Trigger-Funktionen + Trigger-Specs als SSoT-Konstanten exportiert,
// damit der Startup-Schema-Drift-Wächter sie gegen ihre erwartete Bindung prüft.
export const AUDIT_LOG_PREVENT_MUTATION_FN_SQL = `
    CREATE OR REPLACE FUNCTION audit_log_prevent_mutation()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_audit_log_mutation', true) = 'on' THEN
        RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
      END IF;
      RAISE EXCEPTION
        'audit_log ist GoBD-technisch unveraenderbar (% verweigert)', TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const AUDIT_LOG_PREVENT_TRUNCATE_FN_SQL = `
    CREATE OR REPLACE FUNCTION audit_log_prevent_truncate()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'audit_log ist GoBD-technisch unveraenderbar (TRUNCATE verweigert)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const AUDIT_LOG_TRIGGERS: StartupTriggerSpec[] = [
  {
    name: "audit_log_no_update_trigger",
    table: "audit_log",
    timing: "BEFORE",
    events: ["UPDATE"],
    level: "ROW",
    functionName: "audit_log_prevent_mutation",
  },
  {
    name: "audit_log_no_delete_trigger",
    table: "audit_log",
    timing: "BEFORE",
    events: ["DELETE"],
    level: "ROW",
    functionName: "audit_log_prevent_mutation",
  },
  {
    name: "audit_log_no_truncate_trigger",
    table: "audit_log",
    timing: "BEFORE",
    events: ["TRUNCATE"],
    level: "STATEMENT",
    functionName: "audit_log_prevent_truncate",
  },
];

/**
 * GoBD: technische Unveränderbarkeit von `audit_log` (Task #824).
 *
 * Historisch schützten zwei RULEs (`audit_log_no_delete` / `audit_log_no_update`)
 * die Tabelle mit `DO INSTEAD NOTHING`. Das *verschluckt* UPDATE/DELETE jedoch
 * still — der Aufrufer bekommt „0 rows affected" zurück, statt einen Fehler.
 * GoBD verlangt aber, dass ein Manipulationsversuch technisch FEHLSCHLÄGT, nicht
 * leise ins Leere läuft.
 *
 * Diese Migration ersetzt die stillen RULEs durch BEFORE-Trigger, die eine
 * Exception werfen. Trigger feuern für JEDEN Aufrufer (auch den Tabellen-
 * Owner/`postgres`), während ein `REVOKE` beim Owner wirkungslos bliebe.
 *
 * Legitime Test-Cleanup-Pfade (ausschließlich in Nicht-Prod erreichbar,
 * hostname-guarded) setzen transaktions-lokal
 * `SET LOCAL app.allow_audit_log_mutation = 'on'`, womit der Trigger die
 * Mutation für genau diese Transaktion durchlässt. In Produktion wird dieses
 * GUC nie gesetzt → jeder UPDATE/DELETE/TRUNCATE schlägt fehl.
 *
 * Idempotent: DROP RULE/TRIGGER IF EXISTS + CREATE OR REPLACE FUNCTION; bei
 * jedem weiteren Boot ein No-Op.
 */
export async function ensureAuditLogImmutable(): Promise<void> {
  // Alte still-schluckende RULEs entfernen. Eine `ON DELETE DO INSTEAD NOTHING`
  // RULE schreibt das Statement so um, dass der BEFORE-DELETE-Trigger gar nicht
  // mehr feuern würde — die RULEs MÜSSEN also weichen, damit der Trigger greift.
  await db.execute(sql`DROP RULE IF EXISTS audit_log_no_delete ON audit_log`);
  await db.execute(sql`DROP RULE IF EXISTS audit_log_no_update ON audit_log`);

  await db.execute(sql.raw(AUDIT_LOG_PREVENT_MUTATION_FN_SQL));
  await db.execute(sql.raw(AUDIT_LOG_PREVENT_TRUNCATE_FN_SQL));

  for (const spec of AUDIT_LOG_TRIGGERS) {
    await db.execute(sql.raw(renderDropTriggerSql(spec)));
    await db.execute(sql.raw(renderCreateTriggerSql(spec)));
  }

  log("audit_log Unveraenderbarkeit (Trigger) sichergestellt", "startup");
}

/**
 * Erwartete BEFORE-Trigger auf `audit_log` (siehe `ensureAuditLogImmutable`).
 */
export const REQUIRED_AUDIT_LOG_TRIGGERS = AUDIT_LOG_TRIGGERS.map(
  (t) => t.name,
);

/**
 * Alte, GoBD-schwache `DO INSTEAD NOTHING`-RULEs, die NICHT mehr existieren
 * dürfen — solange sie da sind, würde das UPDATE/DELETE still verschluckt und
 * der BEFORE-Trigger nie feuern.
 */
export const FORBIDDEN_AUDIT_LOG_RULES = [
  "audit_log_no_update",
  "audit_log_no_delete",
] as const;

export interface AuditLogImmutabilityStatus {
  /** True nur, wenn alle Trigger da sind UND keine Alt-RULEs mehr existieren. */
  ok: boolean;
  /** Trigger-Namen, die laut DB existieren (Schnittmenge mit den erwarteten). */
  presentTriggers: string[];
  /** Erwartete Trigger, die in der DB fehlen. */
  missingTriggers: string[];
  /** Alt-RULEs, die noch existieren (müssen leer sein). */
  lingeringRules: string[];
  /** Gesetzt, wenn die Prüfung selbst (DB-Query) fehlgeschlagen ist. */
  error?: string;
}

let cachedStatus: AuditLogImmutabilityStatus | null = null;

/**
 * Laufzeit-Self-Check der audit_log-Manipulationssperre (Task #829).
 *
 * Prüft gegen die LAUFENDE DB, ob die BEFORE-Trigger tatsächlich existieren und
 * die alten still-schluckenden RULEs verschwunden sind. Nötig, weil die
 * idempotente Startup-Migration in Produktion stumm übersprungen worden sein
 * könnte (DB-Restore, manueller Schema-Eingriff, fehlgeschlagener Boot-Hook) —
 * eine solche Lücke würde sonst erst im Ernstfall (Manipulationsversuch)
 * auffallen.
 *
 * Das Ergebnis wird gecached und unter `/api/health → auditLogImmutability`
 * exponiert; `assertAuditLogImmutable()` nutzt es für eine Startup-Warnung.
 */
export async function verifyAuditLogImmutable(): Promise<AuditLogImmutabilityStatus> {
  try {
    const triggerRes = await db.execute(sql`
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'audit_log'::regclass
        AND NOT tgisinternal
    `);
    const allTriggers = (
      (triggerRes as unknown as { rows?: Array<{ tgname: string }> }).rows ?? []
    ).map((r) => r.tgname);
    const presentTriggers = REQUIRED_AUDIT_LOG_TRIGGERS.filter((t) =>
      allTriggers.includes(t)
    );

    const ruleRes = await db.execute(sql`
      SELECT rulename
      FROM pg_rules
      WHERE schemaname = current_schema()
        AND tablename = 'audit_log'
    `);
    const allRules = (
      (ruleRes as unknown as { rows?: Array<{ rulename: string }> }).rows ?? []
    ).map((r) => r.rulename);
    const lingeringRules = FORBIDDEN_AUDIT_LOG_RULES.filter((r) =>
      allRules.includes(r)
    );

    const missingTriggers = REQUIRED_AUDIT_LOG_TRIGGERS.filter(
      (t) => !presentTriggers.includes(t)
    );

    const status: AuditLogImmutabilityStatus = {
      ok: missingTriggers.length === 0 && lingeringRules.length === 0,
      presentTriggers,
      missingTriggers,
      lingeringRules,
    };
    cachedStatus = status;
    return status;
  } catch (err) {
    const status: AuditLogImmutabilityStatus = {
      ok: false,
      presentTriggers: [],
      missingTriggers: [...REQUIRED_AUDIT_LOG_TRIGGERS],
      lingeringRules: [],
      error: err instanceof Error ? err.message : String(err),
    };
    cachedStatus = status;
    return status;
  }
}

/**
 * Letztes Ergebnis von `verifyAuditLogImmutable()` (für /api/health), oder
 * `null`, wenn die Prüfung noch nicht gelaufen ist.
 */
export function getAuditLogImmutabilityStatus(): AuditLogImmutabilityStatus | null {
  return cachedStatus;
}

/**
 * Startup-Assertion: prüft die Manipulationssperre und schreibt bei einer Lücke
 * eine laute Warnung ins Log (statt hart zu crashen — eine fehlende Sperre soll
 * den Server-Boot nicht blockieren, aber zwingend sichtbar sein).
 */
export async function assertAuditLogImmutable(): Promise<AuditLogImmutabilityStatus> {
  const status = await verifyAuditLogImmutable();
  if (!status.ok) {
    const details = status.error
      ? `Pruefung fehlgeschlagen: ${status.error}`
      : `fehlende Trigger=[${status.missingTriggers.join(", ")}] ` +
        `verbliebene RULEs=[${status.lingeringRules.join(", ")}]`;
    log(
      `WARNUNG: audit_log-Manipulationssperre NICHT vollstaendig aktiv (GoBD-Risiko)! ${details}`,
      "startup"
    );
  } else {
    log("audit_log-Manipulationssperre verifiziert (Trigger aktiv, keine Alt-RULEs)", "startup");
  }
  return status;
}
