import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { appointmentsRepo, monthlyServiceRecordsRepo } from "../repos";
import { recordHasUnbilledAppointmentSqlRaw } from "../lib/appointment-invoiced";
import { DEACTIVATION_OVERRIDE_MIN_LENGTH } from "@shared/domain/customer-deactivation";
import {
  appointments,
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
 * ── Der Ausloeser ist `status`, NICHT `inaktiv_ab` ───────────────────
 * Die Ticket-Vorgabe lautete umgekehrt und ist gemessen widerlegt;
 * Weiche W3 (Alrik, 16.09.2026) hat sie gedreht. Begruendung und
 * Messung stehen bei `isBecomingInactive` weiter unten — kurz: der
 * Deaktivieren-Dialog schickt nur `status`, die Listen filtern auf
 * `status`, und `inaktiv_ab` bedeutet in dieser App „Vertrag laeuft
 * aus" bei `status = 'aktiv'`.
 *
 * Dieser Absatz stand hier bis 17.09.2026 mit der GEGENTEILIGEN Aussage
 * und widersprach damit der Funktion 200 Zeilen weiter unten. Das ist
 * nicht bloss unsauber: die Mehrdeutigkeit von „inaktiv" hat beim
 * Protokollieren der Trigger-A-Messung zu einer falsch
 * verallgemeinerten Zahl gefuehrt
 * (`docs/corrections/2026-09-16_trigger-a-umfang-messung.md`).
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
 *     Kundenunterschrift, in JEDER Kundenklasse. Das ist der Zustand
 *     der Bestandsfaelle.
 *
 *     Die Frage ist „hat der KUNDE unterschrieben?" und NICHT „ist der
 *     Nachweis abrechenbar?". Beim SELBSTZAHLER fallen die beiden
 *     auseinander: dort ist `employee_signed` laut
 *     `isServiceRecordSignedForBilling` bereits abrechnungsfertig — und
 *     der Guard blockiert trotzdem.
 *
 *     ENTSCHIEDEN (Weiche W2, Alrik 16.09.2026): so bleibt es. Die
 *     Kundenunterschrift ist nicht nur Kassen-Compliance, sondern auch
 *     operatives Kunden-Review — der Kunde bestaetigt die erhaltene
 *     Leistung, unabhaengig vom Zahlungsweg. Wer hier
 *     `!isServiceRecordSignedForBilling(...)` einsetzt, verkuerzt die
 *     Signatur auf die Abrechenbarkeit und verliert diese zweite
 *     Funktion; es waere ausserdem ein Zweitbegriff. DG-20 haelt die
 *     Entscheidung fest und wird rot, wenn sie jemand zurueckdreht.
 *
 *     `billingType` wird hier deshalb bewusst NICHT gelesen.
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
 * im Audit-Log landet (`customer_deactivated_with_open_items`). Das
 * ist dasselbe Muster wie `skipDuplicateCheck` beim Dublettencheck —
 * nur dass hier eine Begruendung verlangt wird und nicht bloss ein
 * Haken, weil der Vorgang im Gegensatz zur Dublette Geld betrifft.
 */

/**
 * Mindestlaenge der Begruendung, mit der Trigger A uebergangen wird.
 * SSoT in `shared/`, weil der Client den Knopf an derselben Zahl sperrt.
 */
export { DEACTIVATION_OVERRIDE_MIN_LENGTH };

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
  const [unsignedRecords, uninvoicedRecords, draftInvoices] = await Promise.all([
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
    // Die GANZE Frage kommt aus `recordHasUnbilledAppointmentSqlRaw` und
    // wird hier nicht neu formuliert — auch nicht die Klammer um das
    // Rechnungs-Praedikat. Zwei Fassungen bedeuteten, dass eine Aenderung
    // an #1536 nur eine Haelfte trifft; dieselbe Funktion bedient
    // `process-health.ts`.
    //
    // Was die erste Fassung falsch machte: sie schrieb
    // `storniert_at IS NULL` von Hand und haette damit GUTSCHRIFTEN als
    // Abdeckung gewertet — an echten Daten gemessen tragen ALLE 114
    // Gutschriften `storniert_at = NULL`. Ein Termin auf einer
    // Gutschrift waere als abgerechnet durchgegangen und der offene
    // Posten unsichtbar geblieben; derselbe Fehler, den #1892 abgestellt
    // hat. Und der No-Show-Carve-out (#1536) fehlte ganz.
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
        eq(monthlyServiceRecords.status, "completed"),
        recordHasUnbilledAppointmentSqlRaw(sql`${monthlyServiceRecords.id}`),
      ))
      .orderBy(monthlyServiceRecords.year, monthlyServiceRecords.month),

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

  // Kein Dedup mehr noetig: `recordHasUnbilledAppointmentSqlRaw` ist ein
  // EXISTS am Nachweis und liefert je Nachweis genau eine Zeile. Die
  // erste Fassung jointe die Termine hinein und musste hinterher
  // zusammenfassen — ein Nachweis mit acht offenen Terminen zaehlte
  // sonst achtfach (DG-11 haelt das fest).
  return { unsignedRecords, uninvoicedRecords, draftInvoices };
}

export interface CustomerLifecycleFields {
  status?: string | null;
}

/**
 * Wird der Kunde durch DIESE Änderung deaktiviert?
 *
 * ── Warum `status` und NICHT `inaktiv_ab` ────────────────────────────
 * Die Ticket-Vorgabe lautete umgekehrt: „Ausloeser ist `inaktiv_ab`,
 * NICHT `status`". Wortwoertlich umgesetzt fiel der Guard ins Leere, und
 * das ist nachgemessen, nicht vermutet:
 *
 *  • Der Dialog „Kunden deaktivieren" schickt `{ status: "inaktiv",
 *    deactivationReason, deactivationNote }` — KEIN `inaktivAb`
 *    (`client/src/pages/admin/customer-detail.tsx`).
 *  • `updateCustomer` leitet `inaktiv_ab` nicht aus `status` ab; die
 *    Felder sind unabhaengig.
 *  • Die Listen filtern auf `status`, nicht auf `inaktiv_ab`. Das
 *    „Verschwinden aus den Standard-Listen", das diesen Guard
 *    begruendet, haengt also an `status`.
 *  • `inaktiv_ab` heisst in dieser App etwas ANDERES: bei
 *    `status = 'aktiv'` traegt es das Vertragsende und erzeugt das
 *    Badge „Auslaufend". Es ist ein Termin in der Zukunft, kein
 *    Zustandswechsel.
 *
 * Gewacht wird deshalb ueber `status`, und NUR darueber (Weiche W3,
 * Alrik 16.09.2026). Eine Zwischenfassung pruefte zusaetzlich das
 * erstmalige Setzen von `inaktiv_ab` — das war inkonsistent: dieselbe
 * Spalte wird von `PATCH /customers/:id/contract` ungeguardet
 * geschrieben, und ein Vertragsende IST kein Zustandswechsel. Zwei
 * Antworten auf dieselbe fachliche Frage. Der Vertrags-Pfad bleibt
 * bewusst ungeguardet; ihn strukturell zu haerten ist ein eigenes
 * Ticket.
 *
 * Nur der UEBERGANG zaehlt. Ein bereits inaktiver Kunde, an dem etwas
 * anderes bearbeitet wird, darf nicht bei jedem Speichern gegen den
 * Guard laufen — sonst wird der 409 zum Dauerzustand und die
 * Begruendung zur Formalie, die man wegklickt.
 */
export function isBecomingInactive(
  previous: CustomerLifecycleFields,
  next: CustomerLifecycleFields,
): boolean {
  return next.status !== undefined
    && next.status === "inaktiv"
    && previous.status !== "inaktiv";
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
