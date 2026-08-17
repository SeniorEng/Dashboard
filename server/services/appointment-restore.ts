import { eq } from "drizzle-orm";
import { db, type Tx } from "../lib/db";
import { appointments } from "@shared/schema";
import { storage } from "../storage";
import { budgetStorage } from "../storage/budget-storage";
import { getPlannedHoldInputs } from "../storage/budget/appointment-cost-calculator";
import { auditService } from "./audit";
import { canRestoreAppointment, type PolicyUser } from "@shared/policies/appointments";
import { ladeEntscheidungsdaten } from "../lib/appointment-policy-adapter";

/**
 * SSoT für „eine Absage zurücknehmen": prüfen → Status zurück → Hold wieder
 * setzen → Audit.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Das Einmal-Skript `server/scripts/fix-replit-1913-restore-13.ts`, das genau
 * diesen Vorgang von Hand für 13 Termine macht. Nach CLAUDE.md gehört eine
 * wiederverwendbare Fähigkeit als Feature gebaut, nicht als Skript; das Skript
 * bleibt nur für die Altfälle, die VOR dieser Routine entstanden sind, und wird
 * danach gelöscht.
 *
 * ── Warum es diesen Weg überhaupt braucht ───────────────────────────────
 * Eine Absage war bisher endgültig. Ein abgesagter Termin ist nicht
 * dokumentierbar, nicht abrechenbar und in keiner Liste — geleistete Arbeit
 * verschwindet lautlos. In Produktion sind so 13 Termine (1080 Minuten, rund
 * 684,00 €) unerreichbar geworden. Der Datums-Boden
 * (`seriesBulkFloorDate`) verhindert den Vorfall künftig; diese Routine ist der
 * Ausweg, wenn eine Absage trotzdem falsch war.
 *
 * ── Spiegelbild zur Absage, nicht Gegenstück ────────────────────────────
 * `cancelAppointments` wickelt Budget-Transaktionen zurück und gibt Holds frei.
 * Das Zurücknehmen macht die Holds wieder — über DIESELBE `planHold`-Kette wie
 * die Terminanlage (`getPlannedHoldInputs` → `planHold`, hinter demselben
 * `hardHoldsEnabled()`-Gate). Ein eigener Nachbau wäre der Zweitbegriff, den
 * die SSoT-Regel verbietet.
 *
 * Die Consumption-Transaktionen werden bewusst NICHT wiederhergestellt: ein
 * zurückgeholter Termin steht auf `scheduled` und hat damit definitionsgemäß
 * keinen Verbrauch. Der entsteht erst wieder bei der Dokumentation — auf dem
 * normalen Weg, mit den dann gültigen Sätzen. Alte Consumption-Zeilen
 * zurückzudrehen hieße, gestrichene Beträge unter alten Bedingungen
 * wiederauferstehen zu lassen.
 */

export interface RestoreOptions {
  userId: number;
  ipAddress?: string;
}

export interface RestoreResult {
  /** Tatsächlich zurückgeholte Termine. */
  restored: number[];
  /** Übersprungene mit Begründung. */
  uebersprungen: Array<{ id: number; grund: string }>;
}

/**
 * Holt die genannten Termine aus der Absage zurück auf `scheduled`.
 *
 * Termine, die die Policy ablehnt, werden ÜBERSPRUNGEN und begründet
 * zurückgemeldet — sie lassen den Aufruf nicht scheitern. Der Aufrufer muss die
 * Liste anzeigen; ein stiller Teilerfolg wäre hier besonders tückisch, weil der
 * Nutzer sonst glaubt, die Arbeit sei wieder erfassbar.
 */
export async function restoreAppointments(
  ids: number[],
  user: PolicyUser,
  opts: RestoreOptions,
  outerTx?: Tx,
): Promise<RestoreResult> {
  if (ids.length === 0) return { restored: [], uebersprungen: [] };

  const restored: number[] = [];
  const uebersprungen: Array<{ id: number; grund: string }> = [];

  const run = async (tx: Tx) => {
    for (const id of ids) {
      // Race-sichere Prüfung IN der Transaktion, gleiche Begründung wie im
      // Absage-Pfad: zwischen Policy-Read und UPDATE kann eine Unterschrift
      // committen. `lockAndCheckAppointmentLocked` nimmt das FOR UPDATE.
      if (await storage.lockAndCheckAppointmentLocked(id, tx)) {
        uebersprungen.push({
          id,
          grund: "Der Termin liegt auf einem unterschriebenen Leistungsnachweis.",
        });
        continue;
      }

      const daten = await ladeEntscheidungsdaten(id, tx);
      if (!daten) {
        uebersprungen.push({ id, grund: "Termin nicht gefunden." });
        continue;
      }

      const entscheidung = canRestoreAppointment(user, daten.policyAppt);
      if (!entscheidung.allowed) {
        uebersprungen.push({ id, grund: entscheidung.reason });
        continue;
      }

      await tx.update(appointments).set({ status: "scheduled" }).where(eq(appointments.id, id));

      // Hold wieder setzen — dieselbe Kette wie bei der Terminanlage.
      // `planHold` ist idempotent (bestehende Holds → no-op), ein doppelter
      // Aufruf kann also nichts doppelt reservieren.
      let holdGesetzt = false;
      if (budgetStorage.hardHoldsEnabled()) {
        const planned = await getPlannedHoldInputs(id, tx);
        if (planned) {
          await budgetStorage.planHold(
            {
              customerId: planned.customerId,
              appointmentId: id,
              transactionDate: planned.date,
              hauswirtschaftMinutes: planned.hauswirtschaftMinutes,
              alltagsbegleitungMinutes: planned.alltagsbegleitungMinutes,
              travelKilometers: planned.travelKilometers,
              customerKilometers: planned.customerKilometers,
              userId: opts.userId,
            },
            tx,
          );
          holdGesetzt = true;
        }
      }

      await auditService.log(
        opts.userId,
        "appointment_restored",
        "appointment",
        id,
        {
          vorher: { status: "cancelled" },
          nachher: { status: "scheduled" },
          date: daten.appt.date,
          holdGesetzt,
        },
        opts.ipAddress,
        tx,
      );

      restored.push(id);
    }
  };

  if (outerTx) await run(outerTx);
  else await db.transaction(run);

  return { restored, uebersprungen };
}
