import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";
import { auditService } from "../services/audit";
import { syncAppointmentServicesAndDuration } from "../services/appointments";
import { users } from "@shared/schema";
import { asc, eq } from "drizzle-orm";

interface DriftRow {
  appointment_id: number;
  customer_id: number | null;
  status: string;
  duration_promised: number;
  service_sum: number;
}

/**
 * Backfill: korrigiert Drift zwischen `appointments.duration_promised` und der
 * Summe von `appointment_services.planned_duration_minutes`.
 *
 * - Nicht abgeschlossene, nicht stornierte Termine werden über den Sync-Helper
 *   korrigiert (Service-Zeilen werden auf `duration_promised` skaliert).
 * - Abgeschlossene Termine bleiben aus GoBD-Gründen unverändert; pro Termin
 *   wird ein Audit-Log-Eintrag geschrieben, damit die Drift sichtbar bleibt.
 *
 * Idempotent: wird bei Bedarf bei jedem Start ausgeführt — wenn keine Drift
 * mehr existiert, ist der Effekt = 0.
 */
export async function syncAppointmentServiceDurations(): Promise<void> {
  const driftRes = await db.execute(sql`
    SELECT a.id AS appointment_id,
           a.customer_id,
           a.status,
           a.duration_promised,
           COALESCE(SUM(s.planned_duration_minutes), 0)::int AS service_sum
    FROM appointments a
    LEFT JOIN appointment_services s ON s.appointment_id = a.id
    WHERE a.deleted_at IS NULL
      AND a.status <> 'cancelled'
    GROUP BY a.id
    HAVING COUNT(s.id) > 0
       AND COALESCE(SUM(s.planned_duration_minutes), 0) <> a.duration_promised
  `);

  // Zusätzlich: Termine ganz ohne Service-Zeilen, deren `duration_promised`
  // > 0 ist. Diese können wir nicht automatisch reparieren (uns fehlt die
  // Service-Kategorie), schreiben aber pro Treffer einen Audit-Eintrag,
  // damit die Drift sichtbar bleibt.
  const orphanRes = await db.execute(sql`
    SELECT a.id AS appointment_id,
           a.customer_id,
           a.status,
           a.duration_promised
    FROM appointments a
    LEFT JOIN appointment_services s ON s.appointment_id = a.id
    WHERE a.deleted_at IS NULL
      AND a.status <> 'cancelled'
      AND a.duration_promised > 0
      AND s.id IS NULL
  `);

  const rows = driftRes.rows as unknown as DriftRow[];
  const orphanRows = orphanRes.rows as unknown as Array<Omit<DriftRow, "service_sum">>;
  if (rows.length === 0 && orphanRows.length === 0) return;

  log(
    `Termin-Service-Drift: ${rows.length} Termine mit Abweichung, ${orphanRows.length} ohne Service-Zeilen gefunden`,
    "startup",
  );

  // Audit-Einträge benötigen einen Actor (FK auf users.id). Wir nehmen den
  // ersten Superadmin, sonst den ersten Admin. Fehlt beides, wird die Drift
  // nur ins Server-Log geschrieben.
  const [auditActor] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let actorId: number | null = auditActor?.id ?? null;
  if (actorId == null) {
    const [adminActor] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    actorId = adminActor?.id ?? null;
  }

  let fixed = 0;
  let auditedOnly = 0;

  // GoBD: nur abgeschlossene oder dokumentierte Termine bleiben unangetastet
  // (audit-only). In-progress-Termine werden noch korrigiert, da hier nur
  // geplante Werte ausgerichtet werden — keine bereits dokumentierten Daten.
  const gobdLocked = new Set(["completed", "documenting"]);

  for (const row of rows) {
    const isLocked = gobdLocked.has(row.status);
    if (isLocked) {
      log(
        `Termin-Service-Drift: ${row.status}-Termin ${row.appointment_id} hat Drift (durationPromised=${row.duration_promised}, serviceSum=${row.service_sum}) — bleibt unverändert (GoBD)`,
        "startup",
      );
      if (actorId != null) {
        try {
          await auditService.log(
            actorId,
            "appointment_updated",
            "appointment",
            row.appointment_id,
            {
              customerId: row.customer_id ?? 0,
              changedFields: [],
              reason: "service_duration_drift_detected",
              durationPromised: row.duration_promised,
              serviceSum: row.service_sum,
            },
            undefined,
          );
        } catch (err) {
          log(`Termin-Service-Drift: Audit-Eintrag für Termin ${row.appointment_id} fehlgeschlagen: ${err}`, "startup");
        }
      }
      auditedOnly++;
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        await syncAppointmentServicesAndDuration(
          row.appointment_id,
          { durationPromised: row.duration_promised },
          tx,
        );
      });
      if (actorId != null) {
        try {
          await auditService.log(
            actorId,
            "appointment_updated",
            "appointment",
            row.appointment_id,
            {
              customerId: row.customer_id ?? 0,
              changedFields: ["appointmentServices"],
              reason: "service_duration_drift_corrected",
              durationPromised: row.duration_promised,
              serviceSumBefore: row.service_sum,
            },
            undefined,
          );
        } catch {
          // Audit best-effort; Datenkorrektur war erfolgreich
        }
      }
      fixed++;
    } catch (err) {
      log(`Termin-Service-Drift: Korrektur für Termin ${row.appointment_id} fehlgeschlagen: ${err}`, "startup");
    }
  }

  for (const row of orphanRows) {
    log(
      `Termin-Service-Drift: Termin ${row.appointment_id} hat duration_promised=${row.duration_promised}, aber keine Service-Zeilen — manuelle Klärung nötig`,
      "startup",
    );
    if (actorId != null) {
      try {
        await auditService.log(
          actorId,
          "appointment_updated",
          "appointment",
          row.appointment_id,
          {
            customerId: row.customer_id ?? 0,
            changedFields: [],
            reason: "service_lines_missing",
            durationPromised: row.duration_promised,
            status: row.status,
          },
          undefined,
        );
      } catch (err) {
        log(`Termin-Service-Drift: Audit-Eintrag für Termin ${row.appointment_id} (orphan) fehlgeschlagen: ${err}`, "startup");
      }
    }
  }

  log(
    `Termin-Service-Drift: ${fixed} korrigiert, ${auditedOnly} abgeschlossene Termine nur audit-protokolliert, ${orphanRows.length} ohne Service-Zeilen gemeldet`,
    "startup",
  );
}
