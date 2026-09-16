import { and, eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  auditLog,
  customers,
  monthlyServiceRecords,
  serviceRecordAppointments,
  users,
} from "@shared/schema";
import { appointmentsRepo, customersRepo, monthlyServiceRecordsRepo } from "../repos";
import { createNotification } from "../storage/notifications";
import { auditService } from "./audit";
import { isPflegekasseBillingType } from "@shared/domain/billing-eligibility";

/**
 * Ticket 6hVwwxG9cxWGphfp — Monats-Erinnerung an den MITARBEITER.
 *
 * ── Die Regel ────────────────────────────────────────────────────────
 * Bis zum 15. des Folgemonats (Abrechnungsschluss 8. + 7 Tage Nachfrist)
 * soll für den Vormonat ALLES abgeschlossen sein: dokumentiert, in einen
 * Leistungsnachweis gelegt, beidseitig unterschrieben. Was bis dahin
 * offen ist, ist Rückstand — und Doku nachzuziehen wird mit der Zeit
 * schwerer, nicht leichter.
 *
 * Zielgruppe ist der MITARBEITER, nicht der Admin: er ist der einzige,
 * der dokumentieren und Unterschriften einholen kann.
 *
 * ── Vier Trigger-Zustände ────────────────────────────────────────────
 * Alles, was nicht `LN.status = 'completed'` ist:
 *
 *  F1  Termin `completed`, aber in KEINEM Leistungsnachweis
 *      → Mitarbeiter über `appointments.assigned_employee_id`
 *  F2  LN vorhanden, Dokumentation unvollständig (`status = 'pending'`)
 *  F3  LN `pending`, weder Mitarbeiter noch Kunde signiert
 *  F4  LN `employee_signed`, Kundenunterschrift fehlt (nur Pflegekasse —
 *      Selbstzahler brauchen sie nicht, siehe
 *      `isServiceRecordSignedForBilling`)
 *      → F2/F3/F4 jeweils über `monthly_service_records.employee_id`
 *
 * ── Warum die Zählung DEDUPLIZIERT sein MUSS ─────────────────────────
 * F2, F3 und F4 greifen auf dieselbe Tabelle und überlappen: ein
 * `pending`-LN ohne beide Signaturen erfüllt F2 UND F3. Würde der Text
 * die Einzelsummen addieren, stünde dort eine Zahl, die es nicht gibt —
 * ein Leistungsnachweis doppelt gezählt. Die Vorgangs-Menge ist deshalb
 * eine MENGE von Identitäten (`appointment:<id>` bzw. `sr:<id>`), nicht
 * eine Summe von Zählern.
 *
 * ── ZEIT-SCOPE: ausschliesslich der Vormonat ─────────────────────────
 * Bewusst eng. Ein LN aus Juni taucht im September-Batch NICHT auf —
 * die Erinnerung soll den frischen Rückstand treiben, nicht eine
 * wachsende Altlast wiederholen. Der Altbestand wird getrennt
 * abgearbeitet; neue Fälle dieser Klasse verhindert der
 * Deaktivierungs-Guard (Ticket 6hWcjpm3Q4V95Xwp).
 *
 * Das ist eine fachliche Entscheidung, keine technische Vereinfachung —
 * wer den Scope weitet, ändert damit die Bedeutung der Zahl im Text.
 *
 * ── Idempotenz ───────────────────────────────────────────────────────
 * Eine Notification pro Mitarbeiter und Vormonat, erzwungen über einen
 * `open_items_reminder_sent`-Eintrag im Audit-Log (dasselbe Muster wie
 * `month_close_reminder_sent`). Das Batch läuft täglich und prüft das
 * Datum selbst; ein zweiter Lauf am selben Tag — oder ein Neustart —
 * darf nicht doppelt benachrichtigen.
 */

/** Tag im Folgemonat, an dem erinnert wird (Abrechnungsschluss 8. + 7). */
export const OPEN_ITEMS_REMINDER_DAY = 15;

export interface OpenItemsForEmployee {
  employeeId: number;
  /** Deduplizierte Vorgänge — das ist die Zahl im Notification-Text. */
  count: number;
  /** Nur für Diagnose/Tests; der Text nennt sie NICHT (Weiche C: simpel). */
  appointmentsWithoutRecord: number;
  serviceRecords: number;
}

/** `{year, month}` des Vormonats zu einem ISO-Tag. */
export function previousMonthOf(iso: string): { year: number; month: number } {
  const [y, m] = iso.split("-").map(Number);
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

/**
 * Offene Vorgänge des Monats, je Mitarbeiter — die reine Erhebung.
 *
 * Getrennt vom Versand, damit der Verify-Lauf und die Tests dieselbe
 * Zahl sehen wie das Batch. Ein zweiter Ableitungspfad wäre genau die
 * Drift, an der die Baseline dieses Tickets schon einmal vorbeigelaufen
 * ist (Admin-Modell vs. MA-Modell).
 */
export async function collectOpenItems(
  year: number,
  month: number,
): Promise<OpenItemsForEmployee[]> {
  const proMitarbeiter = new Map<number, Set<string>>();
  const merke = (employeeId: number | null, key: string): void => {
    if (employeeId == null) return;
    const menge = proMitarbeiter.get(employeeId) ?? new Set<string>();
    menge.add(key);
    proMitarbeiter.set(employeeId, menge);
  };

  // ── F1: dokumentierter Termin ohne jeden Leistungsnachweis ──────────
  const ohneNachweis = await appointmentsRepo
    .selectColumnsFrom({ id: appointments.id, employeeId: appointments.assignedEmployeeId })
    .where(and(
      appointmentsRepo.activeOnly(),
      eq(appointments.status, "completed"),
      sql`EXTRACT(YEAR FROM ${appointments.date})::int = ${year}`,
      sql`EXTRACT(MONTH FROM ${appointments.date})::int = ${month}`,
      sql`${appointments.assignedEmployeeId} IS NOT NULL`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${serviceRecordAppointments} sra
        WHERE sra.appointment_id = ${appointments.id}
      )`,
    ));
  for (const a of ohneNachweis) merke(a.employeeId, `appointment:${a.id}`);

  // ── F2/F3/F4: Leistungsnachweise, die nicht `completed` sind ────────
  //
  // EINE Query statt dreier: die drei Fälle sind Teilmengen derselben
  // Zeilen und überlappen. Wer sie einzeln holt und addiert, zählt
  // doppelt — siehe Docblock.
  const offeneNachweise = await monthlyServiceRecordsRepo
    .selectColumnsFrom({
      id: monthlyServiceRecords.id,
      employeeId: monthlyServiceRecords.employeeId,
      status: monthlyServiceRecords.status,
      customerSignedAt: monthlyServiceRecords.customerSignedAt,
      billingType: customers.billingType,
    })
    .innerJoin(customers, eq(customers.id, monthlyServiceRecords.customerId))
    .where(and(
      monthlyServiceRecordsRepo.activeOnly(),
      customersRepo.activeOnly(),
      sql`${monthlyServiceRecords.employeeId} IS NOT NULL`,
      eq(monthlyServiceRecords.year, year),
      eq(monthlyServiceRecords.month, month),
    ));

  for (const r of offeneNachweise) {
    // F2 + F3 — `pending` deckt beide ab: ein pending-LN ist per
    // Definition weder fertig dokumentiert noch signiert.
    const offeneDoku = r.status === "pending";
    // F4 — nur Pflegekasse. Bei Selbstzahlern genügt die
    // Mitarbeiter-Unterschrift, ihr LN ist bereits abrechenbar.
    const fehlendeKundensignatur =
      r.status === "employee_signed"
      && r.customerSignedAt == null
      && isPflegekasseBillingType(r.billingType);

    if (offeneDoku || fehlendeKundensignatur) merke(r.employeeId, `sr:${r.id}`);
  }

  return [...proMitarbeiter.entries()]
    .map(([employeeId, menge]) => ({
      employeeId,
      count: menge.size,
      appointmentsWithoutRecord: [...menge].filter(k => k.startsWith("appointment:")).length,
      serviceRecords: [...menge].filter(k => k.startsWith("sr:")).length,
    }))
    .sort((a, b) => b.count - a.count || a.employeeId - b.employeeId);
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
 * Versendet die Erinnerungen, wenn `today` der Stichtag ist.
 *
 * Der Datums-Check steckt HIER und nicht im Aufrufer: das Batch läuft
 * täglich, und wer den Stichtag im Scheduler prüft, hat ihn beim
 * nächsten Umbau des Schedulers verloren.
 */
export async function sendOpenItemsReminders(todayIso: string): Promise<ReminderResult> {
  const { year, month } = previousMonthOf(todayIso);
  const tag = Number(todayIso.slice(8, 10));

  if (tag !== OPEN_ITEMS_REMINDER_DAY) {
    return { skipped: true, year, month, notified: 0, items: 0 };
  }

  const offen = await collectOpenItems(year, month);

  let notified = 0;
  let items = 0;

  for (const e of offen) {
    if (await bereitsErinnert(e.employeeId, year, month)) continue;

    // Ein ausgeschiedener Mitarbeiter kann nichts mehr nachholen — die
    // Erinnerung liefe ins Leere. (Beim Kunden löst der
    // Deaktivierungs-Guard dasselbe Problem strukturell; für den
    // Mitarbeiter gibt es kein Gegenstück, deshalb hier der Filter.)
    const [u] = await db
      .select({ id: users.id, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, e.employeeId))
      .limit(1);
    if (!u || !u.isActive) continue;

    const monatsName = `${MONATSNAMEN[month - 1]} ${year}`;
    try {
      await createNotification({
        userId: e.employeeId,
        type: "open_items_reminder",
        title: `Offene Vorgänge: ${monatsName}`,
        // Weiche C — bewusst OHNE Aufschlüsselung nach Fällen. Die Zahl
        // ist die DEDUPLIZIERTE Vorgangs-Menge.
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
        appointmentsWithoutRecord: e.appointmentsWithoutRecord,
        serviceRecords: e.serviceRecords,
      },
    );

    notified += 1;
    items += e.count;
  }

  return { skipped: false, year, month, notified, items };
}
