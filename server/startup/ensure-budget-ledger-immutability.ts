import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";
import {
  type StartupTriggerSpec,
  renderCreateTriggerSql,
  renderDropTriggerSql,
} from "./trigger-spec";

// Task #943 — Trigger-Funktionen + Trigger-Specs als SSoT-Konstanten exportiert.
export const BUDGET_LEDGER_PREVENT_UPDATE_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_ledger_prevent_update()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION
        'budget_ledger: GoBD-UPDATE verboten (append-only; Korrektur nur via neue reversed- + consumed-Zeile)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const BUDGET_LEDGER_PREVENT_DELETE_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_ledger_prevent_delete()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION
        'budget_ledger: GoBD-Hard-Delete verboten (append-only Finanz-Ledger)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const BUDGET_LEDGER_PREVENT_TRUNCATE_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_ledger_prevent_truncate()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION
        'budget_ledger: GoBD-TRUNCATE verboten'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const BUDGET_LEDGER_TRIGGERS: StartupTriggerSpec[] = [
  {
    name: "budget_ledger_no_update_trigger",
    table: "budget_ledger",
    timing: "BEFORE",
    events: ["UPDATE"],
    level: "ROW",
    functionName: "budget_ledger_prevent_update",
  },
  {
    name: "budget_ledger_no_delete_trigger",
    table: "budget_ledger",
    timing: "BEFORE",
    events: ["DELETE"],
    level: "ROW",
    functionName: "budget_ledger_prevent_delete",
  },
  {
    name: "budget_ledger_no_truncate_trigger",
    table: "budget_ledger",
    timing: "BEFORE",
    events: ["TRUNCATE"],
    level: "STATEMENT",
    functionName: "budget_ledger_prevent_truncate",
  },
];

/**
 * GoBD: technische Unveränderbarkeit der finanziellen Budget-Ledger-Tabelle
 * (Budget GF Phase 1, Task #871).
 *
 * `budget_ledger` ist die GoBD-immutable, append-only Finanz-Schicht des
 * Drei-Tabellen-Modells (siehe shared/schema/budget.ts). Es enthält
 * ausschließlich `consumed`/`reversed`-Zeilen. Eine Korrektur ist eine NEUE
 * `reversed`-Zeile plus eine frische `consumed`-Zeile — niemals ein In-Place-
 * Edit oder Hard-Delete. Diese Migration legt BEFORE-Trigger an, die jede
 * direkte UPDATE-/DELETE-/TRUNCATE-Mutation mit einer Exception ABLEHNEN
 * (nicht still schlucken — GoBD verlangt technisches Fehlschlagen).
 *
 * `budget_reservations` ist BEWUSST ausgenommen: Reservierungen sind operativ
 * (Holds), nicht tax-relevant und müssen mutierbar bleiben (hold → captured |
 * released | expired). Sie sind aus GoBD-/Finanz-Exporten ausgeschlossen.
 *
 * Legitime Test-/Cleanup-/Merge-Pfade setzen transaktions-lokal
 * `SET LOCAL app.allow_gobd_mutation = 'on'` (gleiches GUC wie
 * ensure-gobd-table-immutability.ts), womit die Trigger die Mutation für genau
 * diese Transaktion durchlassen. In Produktion wird dieses GUC nie gesetzt →
 * jeder verbotene Schreibzugriff schlägt fehl.
 *
 * Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS/CREATE; bei
 * jedem weiteren Boot ein No-Op.
 */
export async function ensureBudgetLedgerImmutability(): Promise<void> {
  await db.execute(sql.raw(BUDGET_LEDGER_PREVENT_UPDATE_FN_SQL));
  await db.execute(sql.raw(BUDGET_LEDGER_PREVENT_DELETE_FN_SQL));
  await db.execute(sql.raw(BUDGET_LEDGER_PREVENT_TRUNCATE_FN_SQL));

  for (const spec of BUDGET_LEDGER_TRIGGERS) {
    await db.execute(sql.raw(renderDropTriggerSql(spec)));
    await db.execute(sql.raw(renderCreateTriggerSql(spec)));
  }

  log("GoBD-Unveraenderbarkeit budget_ledger (append-only Trigger) sichergestellt", "startup");
}

/**
 * Erwartete BEFORE-Trigger auf `budget_ledger` (siehe
 * `ensureBudgetLedgerImmutability`).
 */
export const REQUIRED_BUDGET_LEDGER_TRIGGERS = BUDGET_LEDGER_TRIGGERS.map(
  (t) => t.name,
);

export interface BudgetLedgerImmutabilityStatus {
  /** True nur, wenn alle erwarteten Trigger in der LIVE-DB existieren. */
  ok: boolean;
  /** Trigger-Namen, die laut DB existieren (Schnittmenge mit den erwarteten). */
  presentTriggers: string[];
  /** Erwartete Trigger, die in der DB fehlen. */
  missingTriggers: string[];
  /** Gesetzt, wenn die Prüfung selbst (DB-Query) fehlgeschlagen ist. */
  error?: string;
}

let cachedStatus: BudgetLedgerImmutabilityStatus | null = null;

/**
 * Laufzeit-Self-Check der budget_ledger-Manipulationssperre.
 *
 * Prüft gegen die LAUFENDE DB, ob die BEFORE-Trigger tatsächlich existieren.
 * Nötig, weil die idempotente Startup-Migration in Produktion stumm
 * übersprungen worden sein könnte (DB-Restore, manueller Schema-Eingriff,
 * fehlgeschlagener Boot-Hook) — eine solche Lücke würde sonst erst im Ernstfall
 * (Manipulationsversuch) auffallen. Ergebnis wird gecached und unter
 * `/api/health → budgetLedgerImmutability` exponiert.
 */
export async function verifyBudgetLedgerImmutable(): Promise<BudgetLedgerImmutabilityStatus> {
  try {
    const triggerRes = await db.execute(sql`
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'budget_ledger'::regclass
        AND NOT tgisinternal
    `);
    const allTriggers = (
      (triggerRes as unknown as { rows?: Array<{ tgname: string }> }).rows ?? []
    ).map((r) => r.tgname);
    const presentTriggers = REQUIRED_BUDGET_LEDGER_TRIGGERS.filter((t) =>
      allTriggers.includes(t)
    );
    const missingTriggers = REQUIRED_BUDGET_LEDGER_TRIGGERS.filter(
      (t) => !presentTriggers.includes(t)
    );

    const status: BudgetLedgerImmutabilityStatus = {
      ok: missingTriggers.length === 0,
      presentTriggers,
      missingTriggers,
    };
    cachedStatus = status;
    return status;
  } catch (err) {
    const status: BudgetLedgerImmutabilityStatus = {
      ok: false,
      presentTriggers: [],
      missingTriggers: [...REQUIRED_BUDGET_LEDGER_TRIGGERS],
      error: err instanceof Error ? err.message : String(err),
    };
    cachedStatus = status;
    return status;
  }
}

/**
 * Letztes Ergebnis von `verifyBudgetLedgerImmutable()` (für /api/health), oder
 * `null`, wenn die Prüfung noch nicht gelaufen ist.
 */
export function getBudgetLedgerImmutabilityStatus(): BudgetLedgerImmutabilityStatus | null {
  return cachedStatus;
}

/**
 * Startup-Assertion: prüft die Manipulationssperre und schreibt bei einer Lücke
 * eine laute Warnung ins Log (statt hart zu crashen — eine fehlende Sperre soll
 * den Server-Boot nicht blockieren, aber zwingend sichtbar sein).
 */
export async function assertBudgetLedgerImmutable(): Promise<BudgetLedgerImmutabilityStatus> {
  const status = await verifyBudgetLedgerImmutable();
  if (!status.ok) {
    const details = status.error
      ? `Pruefung fehlgeschlagen: ${status.error}`
      : `fehlende Trigger=[${status.missingTriggers.join(", ")}]`;
    log(
      `WARNUNG: budget_ledger-Manipulationssperre NICHT vollstaendig aktiv (GoBD-Risiko)! ${details}`,
      "startup"
    );
  } else {
    log("budget_ledger-Manipulationssperre verifiziert (Trigger aktiv)", "startup");
  }
  return status;
}
