// ---------------------------------------------------------------------------
// BUG-18 (Task #1230) — Prod-Migrations-Skript: Junk-Stammdaten-Purge
//
// Entfernt historischen Test-„Müll" aus den STAMMDATEN-Tabellen `services` und
// `document_types` — idempotent, exactly-once und mit Erhaltungs-Tripwire nach
// dem Task-#895-Muster (`server/startup/budget-migration-runner.ts`):
//
//   1. Migrations-Ledger (`budget_migrations`) — protokolliert den einmaligen
//      Lauf per Name. Der Ledger-Insert läuft INNERHALB der Transaktion → ein
//      Rollback entfernt ihn wieder (Re-Run beim nächsten Aufruf).
//   2. Advisory-Lock — serialisiert konkurrierende Läufe (exactly-once).
//   3. Conservation-Pre-/Post-Check — die Menge der ECHTEN (Nicht-Junk-)
//      Service- und Dokumenttyp-IDs MUSS vor und nach dem Purge identisch sein.
//      Weicht sie ab (Filter hätte echte Stammdaten erfasst), wird ALLES
//      zurückgerollt.
//
// Strategie pro Tabelle (analog zu `purgeTestServices`/`purgeTestDocumentTypes`):
//   - Junk OHNE echte Referenz → HART gelöscht (CASCADE/SET-NULL räumt Konfig).
//   - Junk MIT echter Referenz → nur soft-deaktiviert (`is_active = false`),
//     damit keine realen Termine/Dokumente per CASCADE verloren gehen.
//
// SICHERHEIT: Der DESTRUKTIVE Lauf ist hinter einem expliziten Freigabe-Schalter
// (`apply: true`). Ohne Freigabe wird NUR ein read-only Dry-Run-Report erzeugt
// (keine Mutation). Dieses Modul ist NICHT in der Startup-Migrations-Registry
// registriert — es läuft nur on-demand über `server/scripts/purge-junk-master-data.ts`.
// ---------------------------------------------------------------------------
import { sql, and, not, inArray } from "drizzle-orm";
import { dbHostOf } from "@shared/ephemeral-db-target";
import { db, type DbOrTx, type Tx } from "../lib/db";
import { log } from "../lib/log";
import { ensureMigrationLedger } from "./ensure-migration-ledger";
import {
  SERVICE_TEST_FILTER,
  DOCUMENT_TYPE_TEST_FILTER,
  DOCUMENT_TYPE_WHITELIST,
} from "../services/test-data-cleanup";
import { services, prices, appointmentServices } from "@shared/schema";
import {
  documentTypes,
  employeeDocuments,
  customerDocuments,
  generatedDocuments,
} from "@shared/schema";
import { qualificationDocuments, employeeDocumentProofs } from "@shared/schema/qualifications";

export const JUNK_PURGE_MIGRATION_NAME = "bug-18-purge-junk-master-data";

interface JunkRow {
  id: number;
  name: string;
  code: string | null;
}

export interface JunkTablePlan {
  deletable: JunkRow[];
  deactivatable: JunkRow[];
}

export interface JunkPurgeReport {
  /** ISO-Zeitstempel der Report-Erzeugung. */
  generatedAt: string;
  /** NODE_ENV (Scope-Marker — prod/dev/test). */
  nodeEnv: string;
  /** DB-Host OHNE Credentials (Forensik, welche DB sondiert wurde). */
  dbHost: string;
  services: JunkTablePlan;
  documentTypes: JunkTablePlan;
  /** Erhaltungs-Anker: IDs der ECHTEN (Nicht-Junk-)Stammdaten (sortiert). */
  realServiceIds: number[];
  realDocumentTypeIds: number[];
}

/**
 * ERSETZT `new URL(url).host` durch die SSoT `dbHostOf`.
 *
 * `.host` enthaelt den PORT, `.hostname` nicht — dieser Wert wich damit als
 * einziger im Repo von allem ab, womit er je verglichen worden waere, und
 * `istLoopback` haette ihn still als "nicht lokal" gelesen (Gate-2 zu #122).
 * Er wird hier nur protokolliert, deshalb bleiben die sprechenden Ersatztexte
 * statt `null`.
 */
function dbHostFromEnv(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) return "(DATABASE_URL nicht gesetzt)";
  return dbHostOf(url) ?? "(unparsbar)";
}

// --- Klassifikation (read-only, executor-agnostisch: db oder tx) ------------

async function classifyJunkServices(exec: DbOrTx): Promise<JunkTablePlan> {
  const candidates = await exec
    .select({ id: services.id, name: services.name, code: services.code })
    .from(services)
    .where(SERVICE_TEST_FILTER);
  const ids = candidates.map((c) => c.id);
  if (ids.length === 0) return { deletable: [], deactivatable: [] };

  const apptRefs = await exec
    .select({ id: appointmentServices.serviceId })
    .from(appointmentServices)
    .where(inArray(appointmentServices.serviceId, ids));
  // Bewusst OHNE active-Filter: auch eine soft-gelöschte Preis-Zeile hält
  // physisch den FK und würde ein hartes DELETE brechen.
  const priceRefs = await exec
    .select({ id: prices.serviceId })
    .from(prices)
    .where(inArray(prices.serviceId, ids));
  const referenced = new Set<number>(
    [...apptRefs.map((r) => r.id), ...priceRefs.map((r) => r.id)].filter(
      (i): i is number => i !== null,
    ),
  );
  return {
    deletable: candidates.filter((c) => !referenced.has(c.id)),
    deactivatable: candidates.filter((c) => referenced.has(c.id)),
  };
}

async function classifyJunkDocumentTypes(exec: DbOrTx): Promise<JunkTablePlan> {
  const candidates = await exec
    .select({ id: documentTypes.id, name: documentTypes.name })
    .from(documentTypes)
    .where(DOCUMENT_TYPE_TEST_FILTER);
  const rows: JunkRow[] = candidates.map((c) => ({ id: c.id, name: c.name, code: null }));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { deletable: [], deactivatable: [] };

  const referenced = new Set<number>();
  const refTables = [
    { col: employeeDocuments.documentTypeId, table: employeeDocuments },
    { col: customerDocuments.documentTypeId, table: customerDocuments },
    { col: generatedDocuments.documentTypeId, table: generatedDocuments },
    { col: qualificationDocuments.documentTypeId, table: qualificationDocuments },
    { col: employeeDocumentProofs.documentTypeId, table: employeeDocumentProofs },
  ] as const;
  for (const { col, table } of refTables) {
    const refs = await exec.select({ id: col }).from(table).where(inArray(col, ids));
    for (const r of refs) if (r.id !== null) referenced.add(r.id);
  }
  return {
    deletable: rows.filter((r) => !referenced.has(r.id)),
    deactivatable: rows.filter((r) => referenced.has(r.id)),
  };
}

async function realServiceIds(exec: DbOrTx): Promise<number[]> {
  const rows = await exec
    .select({ id: services.id })
    .from(services)
    .where(not(SERVICE_TEST_FILTER));
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

async function realDocumentTypeIds(exec: DbOrTx): Promise<number[]> {
  const rows = await exec
    .select({ id: documentTypes.id })
    .from(documentTypes)
    .where(not(DOCUMENT_TYPE_TEST_FILTER));
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

/** Read-only: sammelt den vollständigen Purge-Plan (Dry-Run). Keine Mutation. */
export async function collectJunkPurgeReport(exec: DbOrTx = db): Promise<JunkPurgeReport> {
  const [svc, dt, realSvc, realDt] = await Promise.all([
    classifyJunkServices(exec),
    classifyJunkDocumentTypes(exec),
    realServiceIds(exec),
    realDocumentTypeIds(exec),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV ?? "(unset)",
    dbHost: dbHostFromEnv(),
    services: svc,
    documentTypes: dt,
    realServiceIds: realSvc,
    realDocumentTypeIds: realDt,
  };
}

// --- Report-Formatierung (Markdown) -----------------------------------------

function fmtRows(rows: JunkRow[], withCode: boolean): string {
  if (rows.length === 0) return "_(keine)_\n";
  const header = withCode ? "| ID | Name | Code |\n|---:|---|---|\n" : "| ID | Name |\n|---:|---|\n";
  const body = rows
    .map((r) => (withCode ? `| ${r.id} | ${r.name} | ${r.code ?? ""} |` : `| ${r.id} | ${r.name} |`))
    .join("\n");
  return header + body + "\n";
}

export function formatJunkPurgeReport(report: JunkPurgeReport): string {
  const svcDel = report.services.deletable.length;
  const svcDeact = report.services.deactivatable.length;
  const dtDel = report.documentTypes.deletable.length;
  const dtDeact = report.documentTypes.deactivatable.length;
  return `# BUG-18 — Junk-Stammdaten-Purge — Dry-Run-Report

> **AUTOMATISCH ERZEUGT — read-only Dry-Run, KEINE Mutation.**
> Erzeugt mit \`npm run purge:junk-master-data\` (ohne \`--apply\`).
> Der destruktive Lauf erfolgt erst nach expliziter Freigabe (Alrik) mit
> \`--apply\` UND gesetztem \`JUNK_PURGE_PROD_APPROVED\`.

- **Erzeugt am:** ${report.generatedAt}
- **NODE_ENV:** \`${report.nodeEnv}\`
- **DB-Host:** \`${report.dbHost}\`

## Zusammenfassung

| Tabelle | Hart löschen | Deaktivieren | Echte (geschützte) Stammdaten |
|---|---:|---:|---:|
| \`services\` | ${svcDel} | ${svcDeact} | ${report.realServiceIds.length} |
| \`document_types\` | ${dtDel} | ${dtDeact} | ${report.realDocumentTypeIds.length} |

Erhaltungs-Anker (dürfen sich durch den Purge NICHT ändern):
- Echte Service-IDs: \`[${report.realServiceIds.join(", ")}]\`
- Echte Dokumenttyp-IDs: \`[${report.realDocumentTypeIds.join(", ")}]\`

## services — hart zu löschen (referenzlos)

${fmtRows(report.services.deletable, true)}
## services — zu deaktivieren (referenziert)

${fmtRows(report.services.deactivatable, true)}
## document_types — hart zu löschen (referenzlos)

${fmtRows(report.documentTypes.deletable, false)}
## document_types — zu deaktivieren (referenziert)

${fmtRows(report.documentTypes.deactivatable, false)}
## Dokumenttyp-Whitelist (SSoT, ${DOCUMENT_TYPE_WHITELIST.length} echte Typen)

${DOCUMENT_TYPE_WHITELIST.map((n) => `- ${n}`).join("\n")}
`;
}

// --- Guarded Apply (#895-Muster) --------------------------------------------

export class JunkPurgeConservationError extends Error {
  constructor(
    public readonly removedRealServiceIds: number[],
    public readonly removedRealDocumentTypeIds: number[],
  ) {
    super(
      `Junk-Purge zurückgerollt: er hätte ECHTE Stammdaten verändert — ` +
        `Services [${removedRealServiceIds.join(", ")}], ` +
        `Dokumenttypen [${removedRealDocumentTypeIds.join(", ")}]. ` +
        `Filter prüfen, bevor erneut versucht wird.`,
    );
    this.name = "JunkPurgeConservationError";
  }
}

async function isMigrationApplied(exec: DbOrTx, name: string): Promise<boolean> {
  const result = await exec.execute(
    sql`SELECT 1 FROM budget_migrations WHERE name = ${name} LIMIT 1`,
  );
  return ((result as { rows?: unknown[] }).rows?.length ?? 0) > 0;
}

function diff(pre: number[], post: number[]): number[] {
  const postSet = new Set(post);
  return pre.filter((id) => !postSet.has(id));
}

export interface JunkPurgeApplyResult {
  outcome: "applied" | "skipped";
  servicesDeleted: number;
  servicesDeactivated: number;
  documentTypesDeleted: number;
  documentTypesDeactivated: number;
}

/**
 * Destruktiver, exactly-once Lauf. Führt Purge + Ledger-Insert in EINER
 * Transaktion unter Advisory-Lock aus und rollt bei Erhaltungs-Verletzung
 * (echte Stammdaten betroffen) ALLES zurück.
 */
export async function applyJunkPurgeMigration(): Promise<JunkPurgeApplyResult> {
  await ensureMigrationLedger();

  const empty: JunkPurgeApplyResult = {
    outcome: "skipped",
    servicesDeleted: 0,
    servicesDeactivated: 0,
    documentTypesDeleted: 0,
    documentTypesDeactivated: 0,
  };

  if (await isMigrationApplied(db, JUNK_PURGE_MIGRATION_NAME)) {
    log(`[junk-purge] '${JUNK_PURGE_MIGRATION_NAME}' bereits im Ledger — übersprungen.`, "startup");
    return empty;
  }

  let result: JunkPurgeApplyResult = { ...empty, outcome: "applied" };

  await db.transaction(async (tx: Tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${JUNK_PURGE_MIGRATION_NAME}))`);

    if (await isMigrationApplied(tx, JUNK_PURGE_MIGRATION_NAME)) {
      log(`[junk-purge] nebenläufig angewendet — übersprungen.`, "startup");
      result = empty;
      return;
    }

    const preRealSvc = await realServiceIds(tx);
    const preRealDt = await realDocumentTypeIds(tx);

    const svcPlan = await classifyJunkServices(tx);
    const dtPlan = await classifyJunkDocumentTypes(tx);

    const svcDel = svcPlan.deletable.map((r) => r.id);
    const svcDeact = svcPlan.deactivatable.map((r) => r.id);
    const dtDel = dtPlan.deletable.map((r) => r.id);
    const dtDeact = dtPlan.deactivatable.map((r) => r.id);

    if (svcDel.length > 0) await tx.delete(services).where(inArray(services.id, svcDel));
    if (svcDeact.length > 0) {
      await tx.update(services).set({ isActive: false }).where(inArray(services.id, svcDeact));
    }
    if (dtDel.length > 0) await tx.delete(documentTypes).where(inArray(documentTypes.id, dtDel));
    if (dtDeact.length > 0) {
      await tx
        .update(documentTypes)
        .set({ isActive: false })
        .where(inArray(documentTypes.id, dtDeact));
    }

    // Conservation-Post-Check: kein einziges ECHTES Stammdatum darf verschwunden
    // sein (Deaktivieren ändert die ID-Menge nicht, Löschen schon).
    const postRealSvc = await realServiceIds(tx);
    const postRealDt = await realDocumentTypeIds(tx);
    const removedSvc = diff(preRealSvc, postRealSvc);
    const removedDt = diff(preRealDt, postRealDt);
    if (removedSvc.length > 0 || removedDt.length > 0) {
      throw new JunkPurgeConservationError(removedSvc, removedDt);
    }

    const summary = {
      servicesDeleted: svcDel.length,
      servicesDeactivated: svcDeact.length,
      documentTypesDeleted: dtDel.length,
      documentTypesDeactivated: dtDeact.length,
    };
    await tx.execute(sql`
      INSERT INTO budget_migrations (name, version, summary, applied_at)
      VALUES (${JUNK_PURGE_MIGRATION_NAME}, '1', ${JSON.stringify(summary)}, NOW())
      ON CONFLICT (name) DO NOTHING
    `);

    result = { outcome: "applied", ...summary };
    log(
      `[junk-purge] angewendet: services del=${summary.servicesDeleted}/deact=${summary.servicesDeactivated}, ` +
        `doc-types del=${summary.documentTypesDeleted}/deact=${summary.documentTypesDeactivated}.`,
      "startup",
    );
  });

  return result;
}
