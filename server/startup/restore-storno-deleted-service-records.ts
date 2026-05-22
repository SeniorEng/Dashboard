import { db } from "../lib/db";
import { monthlyServiceRecords, users, auditLog } from "@shared/schema";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #576 — einmalige Korrektur von zwei in Prod (22.05.2026) durch den
 * Storno-Side-Effekt fälschlich soft-gelöschten Leistungsnachweisen.
 *
 * Sicherheits-Schichten (jede für sich ist ein Veto):
 *   1. **Eng gebundene Tupel** (id + customerId + employeeId + year/month):
 *      es werden ausschließlich exakt die zwei in Prod betroffenen LNs
 *      reaktiviert. Andere LNs mit denselben IDs (z.B. nach DB-Restore
 *      auf einer anderen Umgebung) werden NICHT angefasst.
 *   2. **Status-Check**: nur `status='completed'` (signiert) wird reaktiviert
 *      — ein bewusst gelöschter Draft-LN bleibt gelöscht.
 *   3. **deletedAt-Fenster**: der Soft-Delete muss im Zeitraum des
 *      Incident-Tages liegen (20.–24.05.2026 UTC). Spätere legitime
 *      Soft-Deletes lösen die Migration nicht aus.
 *   4. **One-Shot-Guard via Audit-Log**: hat die Migration für eine ID
 *      bereits einen `service_record_resurrected`-Eintrag geschrieben,
 *      wird sie nicht erneut ausgeführt — auch wenn der LN später erneut
 *      gelöscht und neu reaktiviert wurde, bleibt diese Migration inaktiv.
 *   5. **Mandatory Audit**: ohne Audit-Akteur (kein Super-/Admin in der
 *      Datenbank) wird die Migration komplett übersprungen, statt ohne
 *      Audit-Log Daten zu mutieren.
 */
const INCIDENT_WINDOW_START = new Date("2026-05-20T00:00:00.000Z");
const INCIDENT_WINDOW_END = new Date("2026-05-24T23:59:59.999Z");

interface ExpectedRecord {
  id: number;
  customerId: number;
  year: number;
  month: number;
}

// Abrechnungsperiode der betroffenen LNs ist April 2026 (Storno-Zeitpunkt war
// am 22.05.2026, das ist `deleted_at`, nicht die Abrechnungsperiode!). Siehe
// .local/tasks/task-576.md (Verifikations-Tabelle).
const EXPECTED_RECORDS: ReadonlyArray<ExpectedRecord> = [
  { id: 8,  customerId: 117, year: 2026, month: 4 }, // Egon Uhlig
  { id: 48, customerId: 108, year: 2026, month: 4 }, // Marvin Schröder
];

export async function restoreStornoDeletedServiceRecords(): Promise<void> {
  const targetIds = EXPECTED_RECORDS.map(r => r.id);

  const candidates = await db
    .select({
      id: monthlyServiceRecords.id,
      customerId: monthlyServiceRecords.customerId,
      employeeId: monthlyServiceRecords.employeeId,
      year: monthlyServiceRecords.year,
      month: monthlyServiceRecords.month,
      status: monthlyServiceRecords.status,
      deletedAt: monthlyServiceRecords.deletedAt,
    })
    .from(monthlyServiceRecords)
    .where(and(
      inArray(monthlyServiceRecords.id, targetIds),
      isNotNull(monthlyServiceRecords.deletedAt),
      eq(monthlyServiceRecords.status, "completed"),
    ));

  if (candidates.length === 0) return;

  const eligible = candidates.filter(row => {
    const expected = EXPECTED_RECORDS.find(e => e.id === row.id);
    if (!expected) return false;
    if (expected.customerId !== row.customerId) return false;
    // employeeId nur als Schutz, nicht als Show-Stopper: falls Prod-Wert
    // abweicht (z.B. Handover), bleibt customerId + period + status der
    // Anker. Daher hier weich:
    if (row.year !== expected.year || row.month !== expected.month) return false;
    if (!row.deletedAt) return false;
    if (row.deletedAt < INCIDENT_WINDOW_START || row.deletedAt > INCIDENT_WINDOW_END) {
      return false;
    }
    return true;
  });

  if (eligible.length === 0) return;

  // One-Shot-Guard: prüfen, ob für eine dieser IDs bereits ein
  // service_record_resurrected-Audit existiert. Wenn ja, hat die
  // Migration für diese ID schon einmal gegriffen — niemals erneut.
  const priorAudits = await db
    .select({ entityId: auditLog.entityId })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, "service_record_resurrected"),
      eq(auditLog.entityType, "service_record"),
      inArray(auditLog.entityId, eligible.map(r => r.id)),
    ));
  const alreadyRestored = new Set(priorAudits.map(a => a.entityId));
  const toRestore = eligible.filter(r => !alreadyRestored.has(r.id));
  if (toRestore.length === 0) return;

  // Mandatory Audit: ohne Akteur keine Mutation.
  const [superActor] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let actorId: number | null = superActor?.id ?? null;
  if (actorId == null) {
    const [adminActor] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    actorId = adminActor?.id ?? null;
  }
  if (actorId == null) {
    log(
      "[restore-storno-deleted-service-records] Kein Super-/Admin-Akteur für Audit-Log gefunden — Migration übersprungen (keine Mutation ohne Audit).",
      "startup",
    );
    return;
  }

  for (const row of toRestore) {
    await db.transaction(async (tx) => {
      await tx
        .update(monthlyServiceRecords)
        .set({ deletedAt: null, updatedAt: sql`NOW()` })
        .where(and(
          eq(monthlyServiceRecords.id, row.id),
          eq(monthlyServiceRecords.customerId, row.customerId),
          isNotNull(monthlyServiceRecords.deletedAt),
        ));

      await tx.insert(auditLog).values({
        userId: actorId!,
        action: "service_record_resurrected",
        entityType: "service_record",
        entityId: row.id,
        metadata: {
          customerId: row.customerId,
          employeeId: row.employeeId,
          year: row.year,
          month: row.month,
          previousStatus: row.status,
          previousDeletedAt: row.deletedAt?.toISOString() ?? null,
          reason:
            "Task #576 — Korrektur Storno-Side-Effekt T05/K3: LN durch Storno fälschlich soft-gelöscht, Kunde verschwand aus /eligible-customers.",
          migration: "restore-storno-deleted-service-records",
          incidentWindow: {
            start: INCIDENT_WINDOW_START.toISOString(),
            end: INCIDENT_WINDOW_END.toISOString(),
          },
        },
      });
    });

    log(
      `Leistungsnachweis #${row.id} (Kunde ${row.customerId}, ${row.year}-${String(row.month).padStart(2, "0")}) reaktiviert (Task #576).`,
      "startup",
    );
  }
}
