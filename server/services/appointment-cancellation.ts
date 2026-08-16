import { eq } from "drizzle-orm";
import { db, type Tx } from "../lib/db";
import { appointments } from "@shared/schema";
import { AppError } from "../lib/errors";
import { storage } from "../storage";
import { budgetStorage } from "../storage/budget-storage";
import { timeTrackingStorage } from "../storage/time-tracking";
import { auditService } from "./audit";
import {
  canCancelAppointment,
  discardsDocumentation,
  type PolicyAppointment,
  type PolicyUser,
} from "@shared/policies/appointments";
import type { AppointmentStatus } from "@shared/domain/appointments";

/**
 * SSoT für „einen Termin absagen": entscheiden → prüfen → rückabwickeln →
 * Status setzen → Audit.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Drei divergente Stellen, die dieselbe Frage unterschiedlich beantworteten:
 *  1. das Inline-Guard-Set im `single`-Zweig von
 *     `server/routes/appointment-series.ts` — prüfte NUR `status === "completed"`,
 *     sonst nichts: kein Lock, kein Monatsabschluss, keine Rückabwicklung, kein
 *     Audit.
 *  2. die Eignungsprüfung in `collectEligibleFutureIds` — prüfte Lock und
 *     Monatsabschluss, aber ebenfalls keine Rückabwicklung und kein Audit, und
 *     schützte `documenting` nicht.
 *  3. `bulkCancelSeriesAppointments` — ein nacktes `UPDATE status='cancelled'`.
 *
 * `collectEligibleFutureIds` bleibt als reiner SELEKTOR bestehen (welche Termine
 * sind gemeint), die Entscheidung „darf der weg?" liegt ab jetzt hier. Zwei
 * Begriffe derselben Frage wären genau der Zustand, aus dem der Defekt entstand.
 *
 * ── Zielniveau: Löschen, nicht Bulk ─────────────────────────────────────
 * Der Bulk-Pfad war selbst nackt; Vorbild ist `DELETE /api/appointments/:id`
 * (`server/routes/appointments.ts`). Von dort übernommen: Policy-Entscheidung,
 * race-sichere Lock-Prüfung IN der Transaktion, Storno der Budget-Transaktionen,
 * Freigabe der Hard-Holds hinter demselben Feature-Gate, Audit-Eintrag.
 *
 * ── Warum BEIDE Rückabwicklungen ────────────────────────────────────────
 * Gemessen an der Referenz-DB: `scheduled` trägt NIE eine `budget_transaction`,
 * aber in rund der Hälfte der Fälle einen `hold`. `documenting` kann BEIDES
 * tragen. Wer nur Holds freigäbe, ließe den `documenting`-Fall stumm falsch.
 *
 * Der Zustand, den das behebt, ist in Produktion messbar: `sweepOrphanHolds`
 * (`server/storage/budget/reservation-storage.ts`) meldet „storniert + Hold" seit
 * jeher als Waise — in der Referenz-DB 57,00 € auf einem stornierten Termin.
 * Der Detektor existierte, die Ursache blieb.
 */

export interface DiscardedDocumentation {
  id: number;
  date: string;
  status: string;
  verworfen: "Dokumentation";
}

/**
 * Muster Task #1883 (`PartialBillingConfirmationRequiredError`): der Eingriff
 * wird nicht verboten, sondern ausgewiesen. Ohne `confirmDiscardDocumentation`
 * bricht der ganze Aufruf ab und listet die betroffenen Termine; ein zweiter
 * Aufruf mit dem Flag führt aus.
 */
export class CancelDiscardsDocumentationError extends AppError {
  constructor(public readonly betroffene: DiscardedDocumentation[]) {
    super(
      409,
      "CANCEL_DISCARDS_DOCUMENTATION",
      `${betroffene.length === 1 ? "Für einen Termin wurde" : `Für ${betroffene.length} Termine wurden`} ` +
        "bereits Dokumentationen begonnen. Beim Absagen wird die begonnene Dokumentation verworfen " +
        "und kann nicht wiederhergestellt werden. Bitte ausdrücklich bestätigen.",
    );
    this.name = "CancelDiscardsDocumentationError";
  }
}

export interface CancelOptions {
  userId: number;
  /** Muster #1883 — ohne dieses Flag verweigert die Routine bei `documenting`. */
  confirmDiscardDocumentation?: boolean;
  ipAddress?: string;
}

export interface CancelResult {
  /** Tatsächlich abgesagte Termine. */
  cancelled: number[];
  /** Übersprungene mit Begründung (z.B. bereits abgesagt, gesperrt). */
  uebersprungen: Array<{ id: number; grund: string }>;
}

async function ladeEntscheidungsdaten(id: number) {
  const appt = await storage.getAppointment(id);
  if (!appt) return null;

  const isLocked = await storage.isAppointmentLocked(id);
  let isMonthClosed = false;
  const employeeId = appt.assignedEmployeeId || appt.performedByEmployeeId;
  if (employeeId && appt.date) {
    isMonthClosed = await timeTrackingStorage.isMonthClosed(employeeId, appt.date);
  }

  const policyAppt: PolicyAppointment = {
    assignedEmployeeId: appt.assignedEmployeeId ?? null,
    performedByEmployeeId: appt.performedByEmployeeId ?? null,
    customerId: appt.customerId ?? null,
    prospectId: appt.prospectId ?? null,
    status: appt.status as AppointmentStatus,
    date: appt.date,
    appointmentType: appt.appointmentType ?? null,
    isStarted: !!appt.actualStart || !!appt.actualEnd || appt.status !== "scheduled",
    isLocked,
    isMonthClosed,
    hasSignature: !!appt.signatureData,
  };

  return { appt, policyAppt };
}

/**
 * Sagt die genannten Termine ab. Wirft `CancelDiscardsDocumentationError`, wenn
 * mindestens einer eine begonnene Dokumentation verwerfen würde und das Flag
 * fehlt — dann wird NICHTS abgesagt (Bulk-Semantik wie #1883: ganzer Aufruf
 * bricht ab und listet, der zweite Aufruf führt alles aus).
 *
 * Termine, die die Policy ablehnt, werden übersprungen und begründet
 * zurückgemeldet — sie lassen den Aufruf nicht scheitern. Das entspricht dem
 * bisherigen Bulk-Verhalten (`collectEligibleFutureIds` filterte sie still); neu
 * ist, dass der Aufrufer den Grund erfährt.
 */
export async function cancelAppointments(
  ids: number[],
  user: PolicyUser,
  opts: CancelOptions,
  outerTx?: Tx,
): Promise<CancelResult> {
  if (ids.length === 0) return { cancelled: [], uebersprungen: [] };

  const erlaubt: number[] = [];
  const uebersprungen: Array<{ id: number; grund: string }> = [];
  const verwerfen: DiscardedDocumentation[] = [];

  for (const id of ids) {
    const daten = await ladeEntscheidungsdaten(id);
    if (!daten) {
      uebersprungen.push({ id, grund: "Termin nicht gefunden." });
      continue;
    }
    const entscheidung = canCancelAppointment(user, daten.policyAppt);
    if (!entscheidung.allowed) {
      uebersprungen.push({ id, grund: entscheidung.reason });
      continue;
    }
    if (discardsDocumentation(daten.policyAppt)) {
      verwerfen.push({
        id,
        date: daten.appt.date,
        status: daten.appt.status,
        verworfen: "Dokumentation",
      });
    }
    erlaubt.push(id);
  }

  if (verwerfen.length > 0 && !opts.confirmDiscardDocumentation) {
    throw new CancelDiscardsDocumentationError(verwerfen);
  }

  const cancelled: number[] = [];

  const run = async (tx: Tx) => {
    for (const id of erlaubt) {
      // Race-sichere Re-Prüfung IN der Transaktion — wie im Delete-Pfad. Ohne
      // sie könnte eine gleichzeitig committende Unterschrift den LN zwischen
      // Entscheidung und Ausführung versiegeln, und wir würden einen
      // versiegelten GoBD-Nachweis mutieren.
      if (await storage.lockAndCheckAppointmentLocked(id, tx)) {
        uebersprungen.push({ id, grund: "Wurde zwischenzeitlich Teil eines unterschriebenen Leistungsnachweises." });
        continue;
      }

      const transaktionen = await budgetStorage.getTransactionsByAppointmentId(id);
      for (const t of transaktionen) {
        await budgetStorage.reverseBudgetTransaction(t.id, opts.userId, tx);
      }
      // Hinter demselben Feature-Gate wie im Delete-Pfad — sonst entstünde
      // genau die Divergenz, die diese Routine beseitigt.
      if (budgetStorage.hardHoldsEnabled()) {
        await budgetStorage.releaseHolds(id, opts.userId, tx);
      }

      await tx.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, id));

      await auditService.log(
        opts.userId,
        "appointment_cancelled",
        "appointment",
        id,
        {
          reversedTransactionIds: transaktionen.map((t: { id: number }) => t.id),
          holdsReleased: budgetStorage.hardHoldsEnabled(),
          documentationDiscarded: verwerfen.some(v => v.id === id),
        },
        opts.ipAddress,
        tx,
      );

      cancelled.push(id);
    }
  };

  if (outerTx) await run(outerTx);
  else await db.transaction(run);

  return { cancelled, uebersprungen };
}
