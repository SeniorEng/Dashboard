import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";
import {
  type StartupTriggerSpec,
  renderCreateTriggerSql,
  renderDropTriggerSql,
} from "./trigger-spec";

// Task #1273 (Budget-Ledger Stufe B) — die GoBD-Härtung ist von `budget_ledger`
// auf `budget_transactions` UMGEZOGEN (umbenannt + Ziel-Tabelle gewechselt,
// NICHT dupliziert). `budget_transactions` ist ab Stufe B die EINE append-only
// Finanz-Schicht; `budget_ledger` wird nicht mehr beschrieben (Spiegel-Write
// entfernt) und in Stufe C entfernt.
export const BUDGET_TRANSACTIONS_PREVENT_UPDATE_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_transactions_prevent_update()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION
        'budget_transactions: GoBD-UPDATE verboten (append-only; Korrektur nur via neue reversal-/consumption-Zeile)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const BUDGET_TRANSACTIONS_PREVENT_DELETE_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_transactions_prevent_delete()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION
        'budget_transactions: GoBD-Hard-Delete verboten (append-only Finanz-Ledger)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const BUDGET_TRANSACTIONS_PREVENT_TRUNCATE_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_transactions_prevent_truncate()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION
        'budget_transactions: GoBD-TRUNCATE verboten'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const BUDGET_TRANSACTIONS_TRIGGERS: StartupTriggerSpec[] = [
  {
    name: "budget_transactions_no_update_trigger",
    table: "budget_transactions",
    timing: "BEFORE",
    events: ["UPDATE"],
    level: "ROW",
    functionName: "budget_transactions_prevent_update",
  },
  {
    name: "budget_transactions_no_delete_trigger",
    table: "budget_transactions",
    timing: "BEFORE",
    events: ["DELETE"],
    level: "ROW",
    functionName: "budget_transactions_prevent_delete",
  },
  {
    name: "budget_transactions_no_truncate_trigger",
    table: "budget_transactions",
    timing: "BEFORE",
    events: ["TRUNCATE"],
    level: "STATEMENT",
    functionName: "budget_transactions_prevent_truncate",
  },
];

/**
 * GoBD: technische Unveränderbarkeit der finanziellen `budget_transactions`-
 * Tabelle (Budget-Ledger Stufe B, Task #1273 — UMZUG von `budget_ledger`).
 *
 * `budget_transactions` ist ab Stufe B die GoBD-immutable, append-only Finanz-
 * Schicht. Eine Korrektur ist eine NEUE `reversal`-Zeile plus ggf. eine frische
 * `consumption`-Zeile — niemals ein In-Place-Edit oder Hard-Delete. Diese
 * Migration legt BEFORE-Trigger an, die jede direkte UPDATE-/DELETE-/TRUNCATE-
 * Mutation mit einer Exception ABLEHNEN (nicht still schlucken — GoBD verlangt
 * technisches Fehlschlagen).
 *
 * `budget_reservations` ist BEWUSST ausgenommen: Reservierungen sind operativ
 * (Holds), nicht tax-relevant und müssen mutierbar bleiben (hold → captured |
 * released | expired). `budget_migrations` bleibt ebenfalls unangetastet.
 *
 * Eng definierte Ausnahme-Whitelist: die bestehenden Reconcile-/Korrektur-Pfade
 * (Final-Reconcile der Consumption-Engine, km-Rebook, Import-Batch-Verknüpfung,
 * Startup-Backfills, Test-/Cleanup-Pfade) setzen transaktions-lokal
 * `SET LOCAL app.allow_gobd_mutation = 'on'` (gleiches GUC wie
 * ensure-gobd-table-immutability.ts) und schreiben ihre fachliche Korrektur als
 * neue Zeile bzw. mit `audit_log`-Eintrag. In Produktion wird dieses GUC für
 * manuelle Eingriffe nie gesetzt → jeder verbotene Schreibzugriff schlägt fehl.
 *
 * Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS/CREATE; bei
 * jedem weiteren Boot ein No-Op.
 */
export async function ensureBudgetTransactionsImmutability(): Promise<void> {
  await db.execute(sql.raw(BUDGET_TRANSACTIONS_PREVENT_UPDATE_FN_SQL));
  await db.execute(sql.raw(BUDGET_TRANSACTIONS_PREVENT_DELETE_FN_SQL));
  await db.execute(sql.raw(BUDGET_TRANSACTIONS_PREVENT_TRUNCATE_FN_SQL));

  for (const spec of BUDGET_TRANSACTIONS_TRIGGERS) {
    await db.execute(sql.raw(renderDropTriggerSql(spec)));
    await db.execute(sql.raw(renderCreateTriggerSql(spec)));
  }

  log("GoBD-Unveraenderbarkeit budget_transactions (append-only Trigger) sichergestellt", "startup");
}

/**
 * Erwartete BEFORE-Trigger auf `budget_transactions` (siehe
 * `ensureBudgetTransactionsImmutability`).
 */
export const REQUIRED_BUDGET_TRANSACTIONS_TRIGGERS = BUDGET_TRANSACTIONS_TRIGGERS.map(
  (t) => t.name,
);

export interface BudgetTransactionsImmutabilityStatus {
  /** True nur, wenn alle erwarteten Trigger in der LIVE-DB existieren. */
  ok: boolean;
  /** Trigger-Namen, die laut DB existieren (Schnittmenge mit den erwarteten). */
  presentTriggers: string[];
  /** Erwartete Trigger, die in der DB fehlen. */
  missingTriggers: string[];
  /** Gesetzt, wenn die Prüfung selbst (DB-Query) fehlgeschlagen ist. */
  error?: string;
}

let cachedStatus: BudgetTransactionsImmutabilityStatus | null = null;

/**
 * Laufzeit-Self-Check der budget_transactions-Manipulationssperre.
 *
 * Prüft gegen die LAUFENDE DB, ob die BEFORE-Trigger tatsächlich existieren.
 * Nötig, weil die idempotente Startup-Migration in Produktion stumm
 * übersprungen worden sein könnte (DB-Restore, manueller Schema-Eingriff,
 * fehlgeschlagener Boot-Hook) — eine solche Lücke würde sonst erst im Ernstfall
 * (Manipulationsversuch) auffallen. Ergebnis wird gecached und unter
 * `/api/health → budgetTransactionsImmutability` exponiert.
 */
export async function verifyBudgetTransactionsImmutable(): Promise<BudgetTransactionsImmutabilityStatus> {
  try {
    const triggerRes = await db.execute(sql`
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'budget_transactions'::regclass
        AND NOT tgisinternal
    `);
    const allTriggers = (
      (triggerRes as unknown as { rows?: Array<{ tgname: string }> }).rows ?? []
    ).map((r) => r.tgname);
    const presentTriggers = REQUIRED_BUDGET_TRANSACTIONS_TRIGGERS.filter((t) =>
      allTriggers.includes(t)
    );
    const missingTriggers = REQUIRED_BUDGET_TRANSACTIONS_TRIGGERS.filter(
      (t) => !presentTriggers.includes(t)
    );

    const status: BudgetTransactionsImmutabilityStatus = {
      ok: missingTriggers.length === 0,
      presentTriggers,
      missingTriggers,
    };
    cachedStatus = status;
    return status;
  } catch (err) {
    const status: BudgetTransactionsImmutabilityStatus = {
      ok: false,
      presentTriggers: [],
      missingTriggers: [...REQUIRED_BUDGET_TRANSACTIONS_TRIGGERS],
      error: err instanceof Error ? err.message : String(err),
    };
    cachedStatus = status;
    return status;
  }
}

/**
 * Letztes Ergebnis von `verifyBudgetTransactionsImmutable()` (für /api/health),
 * oder `null`, wenn die Prüfung noch nicht gelaufen ist.
 */
export function getBudgetTransactionsImmutabilityStatus(): BudgetTransactionsImmutabilityStatus | null {
  return cachedStatus;
}

/**
 * Startup-Assertion: prüft die Manipulationssperre und schreibt bei einer Lücke
 * eine laute Warnung ins Log (statt hart zu crashen — eine fehlende Sperre soll
 * den Server-Boot nicht blockieren, aber zwingend sichtbar sein).
 */
export async function assertBudgetTransactionsImmutable(): Promise<BudgetTransactionsImmutabilityStatus> {
  const status = await verifyBudgetTransactionsImmutable();
  if (!status.ok) {
    const details = status.error
      ? `Pruefung fehlgeschlagen: ${status.error}`
      : `fehlende Trigger=[${status.missingTriggers.join(", ")}]`;
    log(
      `WARNUNG: budget_transactions-Manipulationssperre NICHT vollstaendig aktiv (GoBD-Risiko)! ${details}`,
      "startup"
    );
  } else {
    log("budget_transactions-Manipulationssperre verifiziert (Trigger aktiv)", "startup");
  }
  return status;
}
