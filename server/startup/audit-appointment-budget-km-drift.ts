import { log } from "../lib/log";
import { findDriftRows } from "../scripts/audit-appointment-budget-drift";
import { formatKmQuantityDisplay } from "@shared/domain/invoice-line-items";

/**
 * Task #616 / #629 — Audit der Termin-vs-Budget-Drift beim Boot.
 *
 * Ursprünglich (Task #616) hat dieser Boot-Audit ausschließlich km-Drift
 * zwischen Termin und `budget_transactions` gemeldet. Mit Task #629 wird die
 * Prüfung auf Minuten- und Datums-Drift erweitert — dieselbe Logik, die das
 * manuelle Skript `server/scripts/audit-appointment-budget-drift.ts`
 * (Task #626) nutzt. Wir delegieren an `findDriftRows`, damit Boot-Audit und
 * Skript niemals auseinanderlaufen.
 *
 * BEWUSST KEIN automatisches Schreiben: GoBD-relevante Buchungen werden
 * NICHT vom Boot-Code mutiert. Wir scannen idempotent beim Start und loggen
 * pro betroffenem Termin die Vorher-/Nachher-Werte, damit ein Superadmin
 * den Eingriff per Storno+Neuanlage manuell entscheiden kann (Korrektur-
 * Pfad: `tsx server/scripts/audit-appointment-budget-drift.ts --apply
 * --user=<superadmin-id> --reason="…"`).
 *
 * Idempotent: rein lesend — bei Re-Deploys wiederholt sich nur das Log.
 * Sobald die Drift korrigiert ist, verschwinden die Einträge von selbst.
 */
export async function auditAppointmentBudgetKmDrift(): Promise<void> {
  let driftRows: Awaited<ReturnType<typeof findDriftRows>>;
  try {
    driftRows = await findDriftRows({});
  } catch (err) {
    // Tabellen fehlen z.B. in einer frisch initialisierten DB (Tests) →
    // stillschweigend überspringen, damit der Boot nicht failed.
    log(
      `Termin-Drift-Audit übersprungen (DB nicht bereit): ${(err as Error).message}`,
      "startup",
    );
    return;
  }

  if (driftRows.length === 0) return;

  const kmCount = driftRows.filter(r => r.driftKm).length;
  const minutesCount = driftRows.filter(r => r.driftMinutes).length;
  const dateCount = driftRows.filter(r => r.driftDate).length;

  log(
    `Termin-vs-Budget-Drift gefunden in ${driftRows.length} Termin(en) ` +
      `(km: ${kmCount}, Minuten: ${minutesCount}, Datum: ${dateCount}) — ` +
      `Korrektur per \`tsx server/scripts/audit-appointment-budget-drift.ts ` +
      `--apply --user=<superadmin-id> --reason="…"\` ` +
      `(Task #626, GoBD-konformes Storno+Neuanlage):`,
    "startup",
  );

  // Log-Volumen begrenzen, damit ein großer Bestand das Boot-Log nicht flutet.
  const LOG_LIMIT = 200;
  for (const r of driftRows.slice(0, LOG_LIMIT)) {
    const flags = [
      r.driftKm ? "km" : null,
      r.driftMinutes ? "min" : null,
      r.driftDate ? "datum" : null,
    ].filter(Boolean).join("+");
    log(
      `  appt#${r.appointmentId} @${r.date} (Kunde #${r.customerId}, ` +
        `MA #${r.assignedEmployeeId ?? "—"}) [${flags}]: ` +
        `travel ${formatKmQuantityDisplay(r.txTravelKmSum)}→${formatKmQuantityDisplay(r.apptTravelKm)}, ` +
        `customer ${formatKmQuantityDisplay(r.txCustomerKmSum)}→${formatKmQuantityDisplay(r.apptCustomerKm)}, ` +
        `hw ${r.txHwMinutes}→${r.apptHwMinutes} min, ` +
        `ab ${r.txAbMinutes}→${r.apptAbMinutes} min, ` +
        `tx-date ${r.txDate ?? "—"}→${r.date}`,
      "startup",
    );
  }
  if (driftRows.length > LOG_LIMIT) {
    log(
      `  … weitere ${driftRows.length - LOG_LIMIT} Einträge unterdrückt — ` +
        `vollständige Liste via Skript-Trockenlauf.`,
      "startup",
    );
  }
}
