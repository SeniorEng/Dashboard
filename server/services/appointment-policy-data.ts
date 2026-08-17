import { and, eq, isNull } from "drizzle-orm";
import { appointments } from "@shared/schema";
import { storage } from "../storage";
import { appointmentsRepo } from "../repos";
import type { Tx } from "../lib/db";
import { toPolicyAppointment, loadPolicyFlags } from "../lib/appointment-policy-adapter";

/**
 * Lädt Termin + Policy-Eingaben in einem Zug — die Entscheidungsgrundlage für
 * jeden Pfad, der eine Appointment-Policy fragt.
 *
 * `tx` gesetzt = Lesen UNTER dem FOR-UPDATE der laufenden Transaktion. Genau
 * dafür gibt es den Parameter: Absage und Zurückholen werten die Policy nach
 * dem Row-Lock ERNEUT aus, weil sie sie vorher außerhalb der Transaktion
 * ausgewertet haben.
 *
 * ── Warum diese Datei und nicht der Adapter ─────────────────────────────
 * Die Funktion lag zuerst privat in `appointment-cancellation.ts`. Beim Bau des
 * Undo-Pfads wäre die zweite Kopie entstanden, also musste sie geteilt werden.
 * Der erste Versuch legte sie zum Adapter nach `server/lib/` — das war falsch:
 * der Soft-Delete-Wächter deckt `server/routes/**`, `server/storage/**` und
 * `server/services/**` ab (`tests/architecture/soft-delete-coverage.test.ts`,
 * `eslint.config.js`), `server/lib/**` aber NICHT. Der Repo-vermittelte Read
 * wäre damit aus beiden Netzen gefallen — eine Abschwächung der Abdeckung,
 * getarnt als Aufräumen. Hier unter `server/services/` bleibt er erfasst, und
 * geteilt ist er trotzdem.
 *
 * Der Adapter behält die reinen Übersetzungen (`toPolicyUser`,
 * `toPolicyAppointment`, `loadPolicyFlags`) — die lesen keine
 * soft-deletable Tabelle direkt und sind vom Wächter nicht betroffen.
 */
export async function ladeEntscheidungsdaten(id: number, tx?: Tx) {
  // Ueber die Repo-Schicht, nicht per direktem `select` — der Soft-Delete-Filter
  // ist dort verankert und der Waechter oben erzwingt das.
  const [appt] = tx
    ? await appointmentsRepo.selectFrom(tx).where(and(eq(appointments.id, id), isNull(appointments.deletedAt)))
    : [await storage.getAppointment(id)];
  if (!appt) return null;

  const flags = await loadPolicyFlags(id, appt);
  return { appt, policyAppt: toPolicyAppointment(appt, flags) };
}
