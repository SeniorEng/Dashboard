import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { appointmentsRepo, monthlyServiceRecordsRepo } from "../repos";
import {
  appointments,
  invoiceLineItems,
  invoices,
  monthlyServiceRecords,
  serviceRecordAppointments,
} from "@shared/schema";

/**
 * Ticket 6hWcjpm3Q4V95Xwp — Guard gegen das stille Deaktivieren eines
 * Kunden mit offenen Posten.
 *
 * ── Warum es den Guard gibt ──────────────────────────────────────────
 * Wird ein Kunde inaktiv gesetzt, verschwindet er aus den
 * Standard-Listen. Offene Posten an ihm verschwinden mit — sie sind
 * nicht erledigt, sie sind nur nicht mehr sichtbar. Genau so entstand
 * der Bestand, den Alrik im Admin gefunden hat: Kunden 93 und 89,
 * beide inaktiv, beide mit einem Leistungsnachweis, gegen den nie
 * unterschrieben wurde. Dass sie nie aufgefallen sind, war kein Zufall,
 * sondern die Folge davon, dass niemand beim Deaktivieren hinsah.
 *
 * Der Guard ERSETZT diese stille Deaktivierung. Er verhindert nicht das
 * Deaktivieren — er verlangt, dass die offenen Posten zur Kenntnis
 * genommen werden, und schreibt diese Kenntnisnahme ins Audit-Log.
 *
 * ── Der Ausloeser ist `inaktiv_ab`, NICHT `status` ───────────────────
 * Ausdrueckliche Ticket-Vorgabe. `status` ist ein Anzeige-Attribut, das
 * an mehreren Stellen gesetzt wird; die Tatsache „ab wann ist dieser
 * Kunde nicht mehr in Betreuung" haengt an `inaktiv_ab`. Ein Guard auf
 * `status` waere an dem Pfad vorbeigelaufen, der die beiden
 * Bestandsfaelle erzeugt hat.
 *
 * ── Drei Trigger, ZWEI Haerten ───────────────────────────────────────
 * Gemessen wurde vor dem Bau (Prod, read-only): von 165 aktiven Kunden
 * traefe irgendein Trigger bei 118 (71,5 %). Die Treiber sind B (89)
 * und C (71), und bei beiden liegt der Loewenanteil im LAUFENDEN Monat
 * — also im normalen Betrieb, nicht im Rueckstand.
 *
 * Ein harter Riegel auf alle drei waere deshalb keine Sicherung,
 * sondern eine Bremse bei sieben von zehn Deaktivierungen. Gewarnt wird
 * trotzdem, weil die Zahl fuer den EINZELNEN Kunden sehr wohl relevant
 * ist:
 *
 *  A  HART — Leistungsnachweis `pending`/`employee_signed` ohne
 *     Kundenunterschrift. Das ist der Zustand der Bestandsfaelle: der
 *     Nachweis ist nicht abrechenbar und wird es nach der Deaktivierung
 *     auch nicht mehr, weil niemand mehr hingeht.
 *  B  WARNUNG — Nachweis `completed`, dessen Termine auf keiner aktiven
 *     Rechnung stehen. Im laufenden Monat der Normalzustand.
 *  C  WARNUNG — Rechnung im Entwurf. Im laufenden Monat ebenfalls
 *     normal.
 *
 * Zahlungsverzug ist bewusst NICHT enthalten — dafuer gibt es das
 * Mahnwesen, und ein zweiter Begriff derselben Frage waere genau das,
 * was die SSoT-Regel verbietet.
 *
 * ── Was „hart" heisst ────────────────────────────────────────────────
 * A blockiert mit 409 und nennt die betroffenen Nachweise. Fortfahren
 * geht nur mit einer ausdruecklichen Begruendung (>= 10 Zeichen), die
 * im Audit-Log landet (`customer_deactivated_with_unsigned_ln`). Das
 * ist dasselbe Muster wie `skipDuplicateCheck` beim Dublettencheck —
 * nur dass hier eine Begruendung verlangt wird und nicht bloss ein
 * Haken, weil der Vorgang im Gegensatz zur Dublette Geld betrifft.
 */

/** Mindestlaenge der Begruendung, mit der Trigger A uebergangen wird. */
export const DEACTIVATION_OVERRIDE_MIN_LENGTH = 10;

export interface OpenServiceRecord {
  id: number;
  year: number;
  month: number;
  status: string;
}

export interface DraftInvoice {
  id: number;
  invoiceNumber: string;
  status: string;
}

export interface DeactivationBlockers {
  /** A — HART. Nachweise ohne Kundenunterschrift. */
  unsignedRecords: OpenServiceRecord[];
  /** B — Warnung. Fertige Nachweise, deren Termine nicht abgerechnet sind. */
  uninvoicedRecords: OpenServiceRecord[];
  /** C — Warnung. Rechnungen im Entwurf. */
  draftInvoices: DraftInvoice[];
}

/** Blockiert dieser Befund die Deaktivierung? Nur A tut das. */
export function isHardBlocked(b: DeactivationBlockers): boolean {
  return b.unsignedRecords.length > 0;
}

/** Gibt es ueberhaupt etwas zu melden (hart oder als Warnung)? */
export function hasAnyFinding(b: DeactivationBlockers): boolean {
  return isHardBlocked(b)
    || b.uninvoicedRecords.length > 0
    || b.draftInvoices.length > 0;
}

/**
 * Erhebt die offenen Posten eines Kunden — die SSoT dieses Guards.
 *
 * Bewusst EINE Funktion fuer alle drei Trigger: Anzeige (409-Details),
 * Blockade-Entscheidung und Audit-Eintrag lesen dieselbe Erhebung. Drei
 * getrennte Abfragen an drei Stellen waeren der Weg, auf dem die
 * Meldung und die tatsaechliche Blockade auseinanderlaufen.
 */
export async function collectDeactivationBlockers(customerId: number): Promise<DeactivationBlockers> {
  const [unsignedRecords, uninvoicedRows, draftInvoices] = await Promise.all([
    // A — `pending`/`employee_signed` ohne Kundenunterschrift.
    monthlyServiceRecordsRepo
      .selectColumnsFrom({
        id: monthlyServiceRecords.id,
        year: monthlyServiceRecords.year,
        month: monthlyServiceRecords.month,
        status: monthlyServiceRecords.status,
      })
      .where(and(
        eq(monthlyServiceRecords.customerId, customerId),
        monthlyServiceRecordsRepo.activeOnly(),
        isNull(monthlyServiceRecords.customerSignedAt),
        sql`${monthlyServiceRecords.status} IN ('pending', 'employee_signed')`,
      ))
      .orderBy(monthlyServiceRecords.year, monthlyServiceRecords.month),

    // B — `completed`, aber mindestens ein Termin ohne aktive Rechnung.
    //
    // `storniert_at IS NULL` ist hier wesentlich und nicht kosmetisch:
    // eine stornierte Rechnung deckt den Termin NICHT ab (GoBD —
    // Storno + Neuausstellung). Ohne die Bedingung waere ein Termin,
    // dessen einzige Rechnung storniert wurde, faelschlich „abgerechnet".
    monthlyServiceRecordsRepo
      .selectColumnsFrom({
        id: monthlyServiceRecords.id,
        year: monthlyServiceRecords.year,
        month: monthlyServiceRecords.month,
        status: monthlyServiceRecords.status,
      })
      .innerJoin(
        serviceRecordAppointments,
        eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id),
      )
      .innerJoin(appointments, eq(appointments.id, serviceRecordAppointments.appointmentId))
      .where(and(
        eq(monthlyServiceRecords.customerId, customerId),
        monthlyServiceRecordsRepo.activeOnly(),
        appointmentsRepo.activeOnly(),
        eq(monthlyServiceRecords.status, "completed"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${invoiceLineItems} li
          JOIN ${invoices} i ON i.id = li.invoice_id
          WHERE li.appointment_id = ${appointments.id}
            AND i.storniert_at IS NULL
        )`,
      )),

    // C — Rechnung im Entwurf.
    db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        status: invoices.status,
      })
      .from(invoices)
      .where(and(
        eq(invoices.customerId, customerId),
        isNull(invoices.storniertAt),
        eq(invoices.status, "entwurf"),
      )),
  ]);

  // B liefert eine Zeile je unabgerechnetem TERMIN; gemeldet wird der
  // NACHWEIS. Ohne diesen Schritt zaehlte ein Nachweis mit acht offenen
  // Terminen achtfach — dieselbe Einheiten-Falle wie in der
  // Nach-Cutoff-Erinnerung.
  const uninvoicedRecords = [...new Map(uninvoicedRows.map(r => [r.id, r])).values()]
    .sort((a, b) => a.year - b.year || a.month - b.month);

  return { unsignedRecords, uninvoicedRecords, draftInvoices };
}

/**
 * Wird der Kunde durch DIESE Änderung deaktiviert?
 *
 * Nur der Übergang zaehlt. Ein bereits inaktiver Kunde, an dem etwas
 * anderes bearbeitet wird — oder dessen `inaktiv_ab` nur verschoben
 * wird — darf nicht bei jedem Speichern gegen den Guard laufen; sonst
 * wird der 409 zum Dauerzustand und die Begruendung zur Formalie, die
 * man wegklickt.
 */
export function isBecomingInactive(
  previousInaktivAb: string | null | undefined,
  nextInaktivAb: string | null | undefined,
): boolean {
  if (nextInaktivAb === undefined) return false;   // Feld nicht angefasst
  return !previousInaktivAb && !!nextInaktivAb;
}

/** Traegt die Begruendung? */
export function isValidOverrideReason(reason: string | null | undefined): boolean {
  return typeof reason === "string"
    && reason.trim().length >= DEACTIVATION_OVERRIDE_MIN_LENGTH;
}

/** Menschlicher Text fuer die 409-Antwort. */
export function describeBlockers(b: DeactivationBlockers): string {
  const teile: string[] = [];
  if (b.unsignedRecords.length > 0) {
    teile.push(`${b.unsignedRecords.length} Leistungsnachweis${b.unsignedRecords.length === 1 ? "" : "e"} ohne Kundenunterschrift`);
  }
  if (b.uninvoicedRecords.length > 0) {
    teile.push(`${b.uninvoicedRecords.length} nicht abgerechnete${b.uninvoicedRecords.length === 1 ? "r" : ""} Leistungsnachweis${b.uninvoicedRecords.length === 1 ? "" : "e"}`);
  }
  if (b.draftInvoices.length > 0) {
    teile.push(`${b.draftInvoices.length} Rechnung${b.draftInvoices.length === 1 ? "" : "en"} im Entwurf`);
  }
  return teile.join(", ");
}
