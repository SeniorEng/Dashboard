import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  auditLog,
  customers,
  monthlyServiceRecords,
  serviceRecordAppointments,
} from "@shared/schema";
import { appointmentsRepo } from "../repos";
import { monthClosingResponsibilityCoalesce } from "../storage/appointment-helpers";
import { getAdminMonthClosingReadiness } from "../storage/time-tracking/month-closing";
import { monthDateRange } from "../storage/time-tracking/shared";
import { createNotification } from "../storage/notifications";
import { auditService } from "./audit";
import { isServiceRecordSignedForBilling } from "@shared/domain/billing-eligibility";

/**
 * Ticket 6hVwwxG9cxWGphfp — Nach-Cutoff-Erinnerung an den Mitarbeiter.
 *
 * ── Die Regel ────────────────────────────────────────────────────────
 * Am 15. des Folgemonats soll für den Vormonat alles abgeschlossen sein:
 * dokumentiert, in einen Leistungsnachweis gelegt, unterschrieben. Was
 * bis dahin offen ist, ist Rückstand — und Doku nachzuziehen wird mit
 * der Zeit schwerer, nicht leichter.
 *
 * ── Was das hier ERSETZT ─────────────────────────────────────────────
 * Die erste Fassung dieses Dienstes stellte eine EIGENE SQL neben die
 * bestehende Monatsabschluss-Readiness und definierte „offener Vorgang"
 * ein zweites Mal. Das war in drei Punkten falsch — und zwar genau in
 * den drei Punkten, die die vorhandene SSoT bereits richtig hat:
 *
 *  • ATTRIBUTION — sie ordnete über `assigned_employee_id` zu. Bei einer
 *    VERTRETUNG (zugewiesen an A, geleistet von B) hätte A eine
 *    Erinnerung für Arbeit bekommen, die er nicht dokumentieren kann,
 *    und B — der einzige, der den Nachweis unterschreiben darf — keine.
 *    Richtig ist `COALESCE(performed_by, assigned, primary)`
 *    (`monthClosingResponsibilityCoalesce`), dieselbe Zuordnung, die
 *    Banner, Reminder, Auto-Close und Admin-Abschluss benutzen.
 *  • ERSTBERATUNG — sie filterte den Carve-out nicht. Erstberatungs-
 *    Termine hängen am Prospect (`customer_id = NULL`) und können
 *    deshalb NIE in einem Leistungsnachweis landen; sie wären Monat für
 *    Monat als offener Vorgang gemeldet worden, ohne dass der
 *    Mitarbeiter irgendetwas hätte tun können, das die Meldung
 *    wegräumt. Genau der Fehlalarm, den CLAUDE.md verbietet.
 *  • GELÖSCHTE NACHWEISE — ihr `NOT EXISTS` sah nur die Junction-Zeile,
 *    nicht den Zustand des Nachweises. Ein Termin, dessen einziger
 *    Nachweis soft-gelöscht wurde (so arbeitet der Reconcile-Lauf, der
 *    Termine bewusst zur Neu-Dokumentation ausweist), galt als „hat
 *    einen Nachweis" und verschwand aus BEIDEN Zweigen.
 *
 * Die Basis-Erhebung ist deshalb jetzt `getAdminMonthClosingReadiness`
 * — dieselbe Definition, aus der der bestehende `month_close_reminder`
 * seine Zahl zieht (Task #1172 hat sie ausdrücklich konsolidiert). Die
 * beiden Erinnerungen können damit nicht mehr auseinanderlaufen.
 *
 * ── Was ERGÄNZT wird und warum ───────────────────────────────────────
 * Eine Lücke hat die Readiness-SSoT für DIESE Frage: ihr Prädikat
 * `completedButUnsignedSqlRaw` akzeptiert einen Nachweis im Status
 * `employee_signed` als „unterschrieben". Für den Monatsabschluss ist
 * das richtig — der Mitarbeiter hat seinen Teil getan. Für die
 * Abrechnung ist es das nicht: bei einer Pflegekasse fehlt dann noch
 * die KUNDENUNTERSCHRIFT, und einholen kann sie nur der Mitarbeiter.
 *
 * Dieser Zweig fragt die Kassen-Regel NICHT selbst ab, sondern ruft
 * `isServiceRecordSignedForBilling` — dieselbe Funktion, die auch der
 * Rechnungsentwurf benutzt. Beim Selbstzahler ist ein `employee_signed`
 * damit fertig und taucht hier nicht auf.
 *
 * ── Eine Einheit: Termine ────────────────────────────────────────────
 * Alle drei Quellen zählen TERMINE und werden über die Termin-ID
 * vereinigt. Die erste Fassung mischte Termine mit Nachweisen in einer
 * Zahl — „7 Vorgänge" war dann keine Arbeitsmengen-Aussage mehr, weil
 * ein Nachweis mit acht Terminen genauso viel zählte wie ein einzelner
 * Termin.
 *
 * ── Zeit-Scope: ausschliesslich der Vormonat ─────────────────────────
 * Bewusst eng. Ein Nachweis aus Juni taucht im September-Batch NICHT
 * auf — die Erinnerung soll den frischen Rückstand treiben, nicht eine
 * wachsende Altlast wiederholen. Der Altbestand wird getrennt
 * abgearbeitet; neue Fälle verhindert der Deaktivierungs-Guard
 * (6hWcjpm3Q4V95Xwp).
 *
 * ── Idempotenz ───────────────────────────────────────────────────────
 * Eine Benachrichtigung pro Mitarbeiter und Vormonat, erzwungen über
 * `open_items_reminder_sent` im Audit-Log — dasselbe Muster wie
 * `month_close_reminder_sent`. Nicht über einen Zähler im Prozess: der
 * Scheduler startet bei jedem Deploy neu.
 */

/** Frühester Tag im Folgemonat, an dem erinnert wird. */
export const OPEN_ITEMS_REMINDER_DAY = 15;

export interface OpenItemsForEmployee {
  employeeId: number;
  /** Deduplizierte Termine — das ist die Zahl im Benachrichtigungstext. */
  count: number;
  /** Aufschlüsselung, nur für Diagnose und Tests. Der Text nennt sie NICHT. */
  notDocumented: number;
  unsigned: number;
  awaitingCustomerSignature: number;
}

/** `{year, month}` des Vormonats zu einem ISO-Tag. */
export function previousMonthOf(iso: string): { year: number; month: number } {
  const [y, m] = iso.split("-").map(Number);
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

/**
 * Termine des Monats unter einem Nachweis, der noch auf die
 * KUNDENUNTERSCHRIFT wartet — die Ergänzung zur Readiness-SSoT.
 *
 * Die Kassen-Regel wird in TS mit `isServiceRecordSignedForBilling`
 * entschieden und NICHT in SQL nachgebaut. Eine zweite Fassung dieser
 * Regel wäre genau der Zweitbegriff, den die erste Fassung hier hatte;
 * das Monatsvolumen ist klein genug, dass Filtern in TS nichts kostet.
 */
async function appointmentsAwaitingCustomerSignature(
  year: number,
  month: number,
): Promise<Array<{ appointmentId: number; employeeId: number }>> {
  const { startDate, endDate } = monthDateRange(year, month);

  const rows = await appointmentsRepo
    .selectColumnsFrom({
      appointmentId: appointments.id,
      employeeId: monthClosingResponsibilityCoalesce().as("employee_id"),
      recordStatus: monthlyServiceRecords.status,
      customerSignedAt: monthlyServiceRecords.customerSignedAt,
      billingType: customers.billingType,
    })
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .innerJoin(
      serviceRecordAppointments,
      eq(serviceRecordAppointments.appointmentId, appointments.id),
    )
    .innerJoin(
      monthlyServiceRecords,
      eq(monthlyServiceRecords.id, serviceRecordAppointments.serviceRecordId),
    )
    .where(and(
      appointmentsRepo.activeOnly(),
      sql`${monthlyServiceRecords.deletedAt} IS NULL`,
      sql`${customers.deletedAt} IS NULL`,
      gte(appointments.date, startDate),
      lte(appointments.date, endDate),
    ));

  return rows
    .filter(r =>
      !isServiceRecordSignedForBilling(r.billingType, r.recordStatus)
      && r.customerSignedAt == null
      && r.employeeId != null)
    .map(r => ({ appointmentId: r.appointmentId, employeeId: Number(r.employeeId) }));
}

/**
 * Offene Vorgänge des Monats, je Mitarbeiter — die reine Erhebung.
 *
 * Getrennt vom Versand, damit Verify-Läufe und Tests dieselbe Zahl sehen
 * wie das Batch. Ein zweiter Ableitungspfad wäre genau die Drift, an der
 * die Baseline dieses Tickets schon einmal vorbeigelaufen ist.
 */
export async function collectOpenItems(
  year: number,
  month: number,
): Promise<OpenItemsForEmployee[]> {
  // `getAdminMonthClosingReadiness` liefert bereits NUR aktive
  // Nicht-Admins — der frühere handgeschriebene `isActive`-Filter im
  // Versand ist damit ersetzt.
  const readiness = await getAdminMonthClosingReadiness(year, month);
  const wartend = await appointmentsAwaitingCustomerSignature(year, month);

  const wartendJeMitarbeiter = new Map<number, number[]>();
  for (const w of wartend) {
    const liste = wartendJeMitarbeiter.get(w.employeeId) ?? [];
    liste.push(w.appointmentId);
    wartendJeMitarbeiter.set(w.employeeId, liste);
  }

  const ergebnis: OpenItemsForEmployee[] = [];

  for (const emp of readiness) {
    const wartendIds = wartendJeMitarbeiter.get(emp.userId) ?? [];

    // Vereinigung über die TERMIN-ID: dieselbe Einheit in allen drei
    // Quellen, und ein Termin, der in zweien auftaucht, zählt einmal.
    const menge = new Set<number>();
    for (const a of emp.openAppointments) menge.add(a.id);
    for (const a of emp.unsignedAppointments) menge.add(a.id);
    for (const id of wartendIds) menge.add(id);

    if (menge.size === 0) continue;

    ergebnis.push({
      employeeId: emp.userId,
      count: menge.size,
      notDocumented: emp.openAppointments.length,
      unsigned: emp.unsignedAppointments.length,
      awaitingCustomerSignature: wartendIds.length,
    });
  }

  return ergebnis.sort((a, b) => b.count - a.count || a.employeeId - b.employeeId);
}

/** Wurde für diesen Mitarbeiter und Monat schon erinnert? */
async function bereitsErinnert(employeeId: number, year: number, month: number): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, "open_items_reminder_sent"),
      eq(auditLog.userId, employeeId),
      sql`${auditLog.metadata}->>'year' = ${String(year)}`,
      sql`${auditLog.metadata}->>'month' = ${String(month)}`,
    ))
    .limit(1);
  return !!row;
}

const MONATSNAMEN = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export interface ReminderResult {
  skipped: boolean;
  year: number;
  month: number;
  notified: number;
  items: number;
}

/**
 * Versendet die Erinnerungen, wenn `today` am oder nach dem Stichtag liegt.
 *
 * Der Datums-Check steckt HIER und nicht im Aufrufer: das Batch läuft
 * täglich, und wer den Stichtag im Scheduler prüft, hat ihn beim
 * nächsten Umbau des Schedulers verloren.
 *
 * `>=` und nicht `===`: bei strikter Gleichheit fiele die Erinnerung für
 * einen ganzen Monat ERSATZLOS aus, wenn die App am 15. durchgehend
 * unten ist (Deploy-Fenster, Host-Reboot, DB-Ausfall) — still, ohne
 * Log. Die Doppel-Sperre sitzt ohnehin im Audit-Log je Mitarbeiter und
 * Monat, `>=` ist also gefahrlos und heilt sich selbst. Dass dabei ein
 * Mitarbeiter, dessen Rückstand erst am 20. entsteht, noch erreicht
 * wird, ist gewollt: es ist derselbe Rückstand.
 */
export async function sendOpenItemsReminders(todayIso: string): Promise<ReminderResult> {
  const { year, month } = previousMonthOf(todayIso);
  const tag = Number(todayIso.slice(8, 10));

  if (tag < OPEN_ITEMS_REMINDER_DAY) {
    return { skipped: true, year, month, notified: 0, items: 0 };
  }

  const offen = await collectOpenItems(year, month);

  let notified = 0;
  let items = 0;

  for (const e of offen) {
    if (await bereitsErinnert(e.employeeId, year, month)) continue;

    const monatsName = `${MONATSNAMEN[month - 1]} ${year}`;
    try {
      await createNotification({
        userId: e.employeeId,
        type: "open_items_reminder",
        title: `Offene Vorgänge: ${monatsName}`,
        // Weiche C — bewusst OHNE Aufschlüsselung nach Fällen. Die Zahl
        // ist die deduplizierte Termin-Menge.
        message:
          `Für ${monatsName} hast du ${e.count} noch nicht abgeschlossene `
          + `${e.count === 1 ? "Vorgang" : "Vorgänge"}. `
          + "Bitte schnellstmöglich dokumentieren und Unterschriften einholen.",
        referenceType: "employee",
        referenceId: e.employeeId,
      });
    } catch (err) {
      console.error("[open-items] Benachrichtigung fehlgeschlagen:", err);
      // Ohne Audit-Eintrag weitergehen: beim nächsten Lauf erneut
      // versuchen ist besser als eine still verlorene Erinnerung.
      continue;
    }

    await auditService.log(
      e.employeeId,
      "open_items_reminder_sent",
      "employee",
      e.employeeId,
      {
        year, month,
        count: e.count,
        notDocumented: e.notDocumented,
        unsigned: e.unsigned,
        awaitingCustomerSignature: e.awaitingCustomerSignature,
      },
    );

    notified += 1;
    items += e.count;
  }

  return { skipped: false, year, month, notified, items };
}
