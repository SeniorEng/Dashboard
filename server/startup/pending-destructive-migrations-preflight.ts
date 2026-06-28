import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";
import { budgetAllocations } from "@shared/schema";
import { log } from "../lib/log";

/**
 * Task #1402 (TEIL B) — Read-only Preflight gegen die stille No-Op-Falle gegateter,
 * destruktiver Cleanup-Migrationen.
 *
 * Eine gegatete destruktive Cleanup-Migration (z.B.
 * `cleanup-legacy-auto-allocations-1409`) wird NUR registriert, wenn ihr
 * Freigabe-Flag (`APPROVED_*`) im aktiven Scope gesetzt ist. Fehlt das Flag,
 * läuft sie still als No-Op durch — es erscheint nur eine beiläufige
 * `übersprungen`-Logzeile. Beim #1303-Publish blieb dadurch unbemerkt, dass das
 * Flag nur im falschen Scope gesetzt war: die zu bereinigenden Altlast-Zeilen
 * blieben liegen, ohne dass irgendjemand gewarnt wurde.
 *
 * Diese Härtung ist rein LESEND. Sie ändert NICHTS an der Migration selbst
 * (Idempotenz, Guard, Ledger, Conservation-Check bleiben unverändert) — sie
 * erkennt lediglich einen *beabsichtigten, aber ausstehenden* destruktiven
 * Cleanup und WARNT LAUT, wenn das zugehörige Flag im aktiven Scope fehlt,
 * OBWOHL noch zu bereinigende Daten existieren.
 *
 * Pro bekannter gegateter Cleanup-Migration ist ein Deskriptor-Tripel definiert:
 *   - `migrationName` — Name für die Ledger-Abfrage (`budget_migrations.name`).
 *   - `flagEnvVar`    — das zugehörige `APPROVED_*`-Freigabe-Flag.
 *   - `countPending`  — eine LESENDE Probe „gibt es noch zu bereinigende Zeilen?".
 *
 * Ergebnis pro Eintrag (`PendingDestructiveStatus`):
 *   - `applied`          — Migration bereits im Ledger ⇒ erledigt, keine Warnung.
 *   - `clean`            — nichts (mehr) zu bereinigen ⇒ keine Warnung.
 *   - `pending-approved` — Flag gesetzt + pending Zeilen + noch nicht im Ledger
 *                          ⇒ läuft diesen/nächsten Boot regulär, keine Warnung.
 *   - `mismatch`         — Flag FEHLT + pending Zeilen + nicht im Ledger
 *                          ⇒ der echte Flag-Scope-Mismatch ⇒ LAUTE Warnung.
 */

/** Flag-Parsing identisch zum Migrations-Runner (`/^(1|true)$/i`). */
function flagEnabled(envVar: string): boolean {
  return /^(1|true)$/i.test((process.env[envVar] ?? "").trim());
}

interface DestructiveCleanupDescriptor {
  /** Name der Migration für die Ledger-Abfrage. */
  migrationName: string;
  /** Zugehöriges `APPROVED_*`-Freigabe-Flag. */
  flagEnvVar: string;
  /** Menschenlesbare Kurzbeschreibung (für Log/Health). */
  description: string;
  /** Lesende Probe: Anzahl der noch zu bereinigenden (pending) Zeilen. */
  countPending: (exec: DbOrTx) => Promise<number>;
}

/**
 * Bekannte gegatete destruktive Cleanup-Migrationen. Weitere lassen sich additiv
 * ergänzen, ohne die Boot-/Health-Verdrahtung zu ändern. Aktuell eine:
 * `cleanup-legacy-auto-allocations-1409` (zählt pending Altlast-Zeilen). Der
 * frühere `drop-budget-ledger-1443`-Deskriptor wurde nach dem abgeschlossenen
 * Prod-Drop in Task #1486 entfernt.
 */
const DESTRUCTIVE_CLEANUP_DESCRIPTORS: DestructiveCleanupDescriptor[] = [
  {
    migrationName: "cleanup-legacy-auto-allocations-1409",
    flagEnvVar: "APPROVED_CLEANUP_LEGACY_AUTO_ALLOCATIONS_1409",
    description:
      "FK-Null-dann-Hard-Delete aktiver Altlast-Auto-Allocation-Zeilen (monthly_auto/yearly_auto)",
    countPending: async (exec) => {
      const rows = await exec
        .select({ id: budgetAllocations.id })
        .from(budgetAllocations)
        .where(
          and(
            inArray(budgetAllocations.source, ["monthly_auto", "yearly_auto"]),
            isNull(budgetAllocations.deletedAt),
          ),
        );
      return rows.length;
    },
  },
];

export type PendingDestructiveStatus =
  | "applied"
  | "clean"
  | "pending-approved"
  | "mismatch";

export interface PendingDestructiveMigrationEntry {
  /** Name der Migration (Ledger-Schlüssel). */
  migrationName: string;
  /** Zugehöriges `APPROVED_*`-Freigabe-Flag. */
  flagEnvVar: string;
  /** Menschenlesbare Kurzbeschreibung. */
  description: string;
  /** Ist die Migration bereits im Ledger angewendet? */
  appliedInLedger: boolean;
  /** Ist das Freigabe-Flag im aktiven Scope gesetzt? */
  flagSet: boolean;
  /** Anzahl der noch zu bereinigenden (pending) Zeilen. */
  pendingRows: number;
  /** Abgeleiteter Status (siehe Modul-Doku). */
  status: PendingDestructiveStatus;
}

export interface PendingDestructiveMigrationsStatus {
  /** True, wenn KEIN Eintrag im `mismatch`-Zustand ist (kein Flag-Scope-Loch). */
  ok: boolean;
  /** Detail je bekannter destruktiver Cleanup-Migration. */
  entries: PendingDestructiveMigrationEntry[];
  /** Gesetzt, wenn die Prüfung selbst (DB-Query) fehlgeschlagen ist. */
  error?: string;
}

async function isMigrationApplied(exec: DbOrTx, name: string): Promise<boolean> {
  const result = await exec.execute(
    sql`SELECT 1 FROM budget_migrations WHERE name = ${name} LIMIT 1`,
  );
  return ((result as { rows?: unknown[] }).rows?.length ?? 0) > 0;
}

let cachedStatus: PendingDestructiveMigrationsStatus | null = null;

/**
 * Read-only Preflight: ermittelt pro bekannter gegateter Cleanup-Migration den
 * Status. Wirft NICHT — schreibt das Ergebnis in den Cache (für /api/health) und
 * gibt es strukturiert zurück, damit der Aufrufer (Boot-Warnung) entscheidet.
 */
export async function verifyPendingDestructiveMigrations(
  exec: DbOrTx = db,
): Promise<PendingDestructiveMigrationsStatus> {
  try {
    const entries: PendingDestructiveMigrationEntry[] = [];
    for (const d of DESTRUCTIVE_CLEANUP_DESCRIPTORS) {
      const appliedInLedger = await isMigrationApplied(exec, d.migrationName);
      const flagSet = flagEnabled(d.flagEnvVar);
      // Pending-Zeilen nur zählen, wenn nicht bereits angewendet (sonst unnötige
      // Last bei jedem Health-Call).
      const pendingRows = appliedInLedger ? 0 : await d.countPending(exec);

      let status: PendingDestructiveStatus;
      if (appliedInLedger) {
        status = "applied";
      } else if (pendingRows === 0) {
        status = "clean";
      } else if (flagSet) {
        status = "pending-approved";
      } else {
        status = "mismatch";
      }

      entries.push({
        migrationName: d.migrationName,
        flagEnvVar: d.flagEnvVar,
        description: d.description,
        appliedInLedger,
        flagSet,
        pendingRows,
        status,
      });
    }

    const status: PendingDestructiveMigrationsStatus = {
      ok: entries.every((e) => e.status !== "mismatch"),
      entries,
    };
    cachedStatus = status;
    return status;
  } catch (err) {
    const status: PendingDestructiveMigrationsStatus = {
      ok: false,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
    cachedStatus = status;
    return status;
  }
}

/**
 * Letztes Ergebnis von `verifyPendingDestructiveMigrations()` (für /api/health),
 * oder `null`, wenn die Prüfung noch nicht gelaufen ist.
 */
export function getPendingDestructiveMigrationsStatus(): PendingDestructiveMigrationsStatus | null {
  return cachedStatus;
}

/**
 * Startup-Assertion: prüft auf einen Flag-Scope-Mismatch und schreibt bei jedem
 * `mismatch`-Eintrag eine LAUTE, klar erkennbare Warnung ins Log (eigenes
 * auffälliges Präfix — NICHT die beiläufige `übersprungen`-Zeile des Runners).
 * Kein harter Abbruch: der Boot läuft normal weiter.
 */
export async function assertNoPendingDestructiveMismatch(
  exec: DbOrTx = db,
): Promise<PendingDestructiveMigrationsStatus> {
  const status = await verifyPendingDestructiveMigrations(exec);
  if (status.error) {
    log(
      `[preflight] WARNUNG: Preflight für ausstehende destruktive Migrationen fehlgeschlagen: ${status.error}`,
      "startup",
    );
    return status;
  }
  for (const e of status.entries) {
    if (e.status === "mismatch") {
      log(
        "================================================================\n" +
          "!!! PREFLIGHT-WARNUNG: AUSSTEHENDE DESTRUKTIVE MIGRATION !!!\n" +
          `Migration '${e.migrationName}' ist NICHT angewendet (kein Ledger-Eintrag), ` +
          `aber das Freigabe-Flag '${e.flagEnvVar}' ist im aktiven Scope NICHT gesetzt — ` +
          `obwohl noch ${e.pendingRows} zu bereinigende Zeile(n) existieren.\n` +
          `Folge: Die Migration (${e.description}) läuft STILL als No-Op durch. ` +
          `Prüfe, ob das Flag im richtigen (Deployment-)Scope gesetzt ist.\n` +
          "================================================================",
        "startup",
      );
    }
  }
  return status;
}
