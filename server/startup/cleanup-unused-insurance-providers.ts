// ---------------------------------------------------------------------------
// Task #1262 — Prod-Startup-Cleanup: unbenutzte Pflegekassen EINMALIG löschen.
//
// Hintergrund: Der EDIFACT-Massenimport / PKV-Seed legt hunderte Pflegekassen
// an, von denen die meisten KEINEM Kunden (`customer_insurance_history`) und
// KEINEM Rechnungs-Empfänger (`customer_budget_recipients`) zugeordnet sind. In
// der Produktivumgebung ist das manuelle "Aufräumen" (Superadmin-Route) bewusst
// deaktiviert (Sicherheits-Rail gegen versehentliche Massenlöschung, Task
// #1000). Dieses Skript räumt die unbenutzten Pflegekassen in PRODUKTION GENAU
// EINMAL auf — nach dem exactly-once-Muster (#895):
//
//   1. Migrations-Ledger (`budget_migrations`) gatet den Lauf per Name. Der
//      Ledger-Insert läuft INNERHALB der Transaktion → ein Rollback macht ihn
//      rückgängig (Re-Run beim nächsten Boot).
//   2. Advisory-Lock serialisiert konkurrierende Boot-Prozesse (exactly-once).
//   3. Erhaltungs-Tripwire: Die Anzahl der REFERENZIERTEN (benutzten)
//      Pflegekassen MUSS vor und nach dem Lauf identisch sein. Weicht sie ab
//      (das Lösch-Prädikat hätte eine benutzte Kasse erfasst), wird ALLES
//      zurückgerollt.
//
// "Once" ist die vom Nutzer (Alrik) gewählte Variante: Es werden NUR die aktuell
// unbenutzten Kassen gelöscht; künftig manuell angelegte Kassen bleiben
// unangetastet. Dass gelöschte Kassen beim täglichen EDIFACT-Reimport NICHT neu
// auftauchen, ist bereits durch den Insert-Guard in `import-pflegekassen.ts`
// (befüllte Tabelle → nur Updates) sichergestellt.
//
// Die "unbenutzt"-Definition UND das DELETE stammen aus der SSoT
// `server/storage/customer-mgmt/insurance.ts` — KEIN paralleles Prädikat.
// ---------------------------------------------------------------------------
import { sql, not, count, eq, asc } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "../lib/db";
import { log } from "../lib/log";
import { users, insuranceProviders } from "@shared/schema";
import { ensureMigrationLedger } from "./ensure-migration-ledger";
import {
  isUnusedInsuranceProvider,
  deleteUnusedInsuranceProvidersWithin,
} from "../storage/customer-mgmt/insurance";
import { auditService } from "../services/audit";

export const CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME = "cleanup-unused-insurance-providers";

/** Tripwire: ein REFERENZIERTES (benutztes) Pflegekassen-Konto wurde gelöscht. */
export class UnusedInsuranceConservationError extends Error {
  constructor(
    public readonly referencedBefore: number,
    public readonly referencedAfter: number,
  ) {
    super(
      `Pflegekassen-Cleanup zurückgerollt: die Anzahl referenzierter (benutzter) ` +
        `Pflegekassen änderte sich (${referencedBefore} → ${referencedAfter}). ` +
        `Das Lösch-Prädikat hätte eine benutzte Kasse erfasst — Filter prüfen.`,
    );
    this.name = "UnusedInsuranceConservationError";
  }
}

export interface UnusedInsuranceCleanupResult {
  outcome: "applied" | "skipped";
  deleted: number;
  deletedPrivate: number;
  deletedStatutory: number;
}

async function isMigrationApplied(exec: DbOrTx, name: string): Promise<boolean> {
  const result = await exec.execute(
    sql`SELECT 1 FROM budget_migrations WHERE name = ${name} LIMIT 1`,
  );
  return ((result as { rows?: unknown[] }).rows?.length ?? 0) > 0;
}

/**
 * True, sobald der einmalige Cleanup gelaufen ist (Ledger-Zeile vorhanden).
 *
 * Die Seeder (`importPflegekassen` / `seedPkvProviders`) fragen das beim Boot ab
 * und schalten danach DAUERHAFT auf "nur aktualisieren, nichts neu anlegen" —
 * sonst würden über den Cleanup gelöschte Pflegekassen beim nächsten Start
 * wieder auftauchen (Nutzer-Vorgabe: EINMAL löschen, NIE neu anlegen). Wichtig:
 * Die Seeder laufen vor `ensureMigrationLedger`; existiert die Ledger-Tabelle
 * also noch nicht (allererster Boot), gilt der Cleanup als "nicht gelaufen"
 * (kein Resurrection-Risiko, da an diesem Boot auch noch nichts gelöscht wurde).
 */
export async function hasUnusedInsuranceCleanupRun(exec: DbOrTx = db): Promise<boolean> {
  try {
    return await isMigrationApplied(exec, CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME);
  } catch {
    return false;
  }
}

/** Zählt die REFERENZIERTEN (= NICHT unbenutzten) Pflegekassen. */
async function countReferencedProviders(exec: DbOrTx): Promise<number> {
  // `isUnusedInsuranceProvider()` ist zur Laufzeit immer ein definiertes
  // `and(...)`, wird von Drizzle aber als `SQL | undefined` typisiert — `not()`
  // verlangt einen definierten Wrapper, daher die Non-Null-Assertion.
  const [row] = await exec
    .select({ c: count() })
    .from(insuranceProviders)
    .where(not(isUnusedInsuranceProvider()!));
  return Number(row?.c ?? 0);
}

/** System-Actor für den Audit-Eintrag: Superadmin, sonst ältester Admin. */
async function resolveSystemActorId(): Promise<number | null> {
  const [superActor] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  if (superActor?.id != null) return superActor.id;
  const [adminActor] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  return adminActor?.id ?? null;
}

/**
 * Env-agnostischer Kern (direkt testbar). Löscht die aktuell unbenutzten
 * Pflegekassen GENAU EINMAL (Ledger-gegated) und schreibt — sofern etwas
 * gelöscht wurde und ein System-Actor existiert — einen Audit-Eintrag in
 * DERSELBEN Transaktion (atomar mit Löschung + Ledger-Insert).
 */
export async function applyUnusedInsuranceCleanupMigration(): Promise<UnusedInsuranceCleanupResult> {
  await ensureMigrationLedger();

  const skipped: UnusedInsuranceCleanupResult = {
    outcome: "skipped",
    deleted: 0,
    deletedPrivate: 0,
    deletedStatutory: 0,
  };

  // Schneller Pfad außerhalb der Transaktion: bereits angewendet → kein Overhead.
  if (await isMigrationApplied(db, CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME)) {
    log(
      `[insurance-cleanup] '${CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME}' bereits im Ledger — übersprungen.`,
      "startup",
    );
    return skipped;
  }

  const systemActorId = await resolveSystemActorId();
  let result: UnusedInsuranceCleanupResult = skipped;

  await db.transaction(async (tx: Tx) => {
    // Exactly-once unter Nebenläufigkeit: transaktions-gebundener Advisory-Lock
    // serialisiert konkurrierende Boot-Prozesse pro Migrations-Namen.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME}))`,
    );

    if (await isMigrationApplied(tx, CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME)) {
      log(`[insurance-cleanup] nebenläufig angewendet — übersprungen.`, "startup");
      result = skipped;
      return;
    }

    const referencedBefore = await countReferencedProviders(tx);
    const deleted = await deleteUnusedInsuranceProvidersWithin(tx);
    const referencedAfter = await countReferencedProviders(tx);

    // Erhaltungs-Post-Check: keine einzige BENUTZTE Kasse darf verschwunden sein.
    if (referencedBefore !== referencedAfter) {
      throw new UnusedInsuranceConservationError(referencedBefore, referencedAfter);
    }

    if (deleted.total > 0 && systemActorId != null) {
      await auditService.log(
        systemActorId,
        "insurance_providers_cleanup",
        "insurance_provider",
        0,
        {
          deletedTotal: deleted.total,
          deletedPrivate: deleted.private,
          deletedStatutory: deleted.statutory,
          deletedIds: deleted.deletedIds,
          source: "startup-migration",
        },
        undefined,
        tx,
      );
    }

    const summary = {
      deleted: deleted.total,
      private: deleted.private,
      statutory: deleted.statutory,
    };
    await tx.execute(sql`
      INSERT INTO budget_migrations (name, version, summary, applied_at)
      VALUES (${CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME}, '1', ${JSON.stringify(summary)}, NOW())
      ON CONFLICT (name) DO NOTHING
    `);

    result = {
      outcome: "applied",
      deleted: deleted.total,
      deletedPrivate: deleted.private,
      deletedStatutory: deleted.statutory,
    };
    log(
      `[insurance-cleanup] angewendet: ${deleted.total} unbenutzte Pflegekasse(n) gelöscht ` +
        `(${deleted.statutory} gesetzlich, ${deleted.private} privat).`,
      "startup",
    );
  });

  if (result.outcome === "applied" && result.deleted > 0 && systemActorId == null) {
    log(
      `[insurance-cleanup] WARNUNG: kein System-Actor (Super-/Admin) gefunden — ` +
        `Löschung wurde OHNE Audit-Eintrag durchgeführt.`,
      "startup",
    );
  }

  return result;
}

/**
 * Startup-Registry-Eintrag (Aufruf in `server/index.ts`). Läuft NUR in der
 * Produktivumgebung — in Dev/Test bleibt das manuelle "Aufräumen" über die
 * Superadmin-Route (`/insurance-providers/cleanup/unused`) das Mittel der Wahl,
 * und das automatische Löschen würde dort die Test-Stammdaten zerstören.
 */
export async function cleanupUnusedInsuranceProvidersOnStartup(): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  await applyUnusedInsuranceCleanupMigration();
}
