import { and, eq, gte, lte, isNull, inArray, notInArray, or, sql as sqlBuilder } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  auditLog,
  customers,
  employeeMonthClosings,
  employeeTimeEntries,
  users,
} from "@shared/schema";
import { log } from "../lib/log";
import {
  computeMonthCloseCutoff,
  daysUntilCutoff,
  isCutoffDay,
  previousMonth,
} from "@shared/utils/month-close-cutoff";
import { auditService } from "./audit";
import { createNotification } from "../storage/notifications";
import { notificationService } from "./notification-service";
import { storage } from "../storage";
import { sendEmail, buildEmailLayout } from "./email-service";
import { ensureMonthClosingTask, completeMonthClosingTask } from "../storage/tasks";
import { appointmentsRepo, employeeTimeEntriesRepo } from "../repos";

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1h

async function reminderAlreadySent(
  userId: number,
  year: number,
  month: number,
  wave: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "month_close_reminder_sent"),
        eq(auditLog.userId, userId),
        sqlBuilder`${auditLog.metadata}->>'year' = ${String(year)}`,
        sqlBuilder`${auditLog.metadata}->>'month' = ${String(month)}`,
        sqlBuilder`${auditLog.metadata}->>'wave' = ${wave}`,
      ),
    )
    .limit(1);
  return !!row;
}

function todayBerlinIso(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });
  return fmt.format(new Date());
}

function berlinHour(): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const parsed = parseInt(hourStr, 10);
  return Number.isFinite(parsed) ? parsed % 24 : 0;
}

function monthDateRange(year: number, month: number): { startDate: string; endDate: string } {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { startDate: start, endDate: end };
}

interface EmployeeBlocker {
  userId: number;
  displayName: string;
  email: string | null;
  openCount: number;
  unsignedCount: number;
}

async function getEmployeesWithMonthBlockers(year: number, month: number): Promise<EmployeeBlocker[]> {
  const { startDate, endDate } = monthDateRange(year, month);

  const activeEmployees = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
    })
    .from(users)
    .where(and(eq(users.isActive, true), eq(users.isAdmin, false)));

  if (activeEmployees.length === 0) return [];
  const employeeIds = activeEmployees.map((e) => e.id);

  // Reminders are attributed to the assigned employee, or — if no assignment
  // exists — to the customer's primary employee. Backup employees do NOT
  // receive month-close reminders because they are not responsible for
  // documenting the appointment; they only serve as fallback contacts.
  const employeeOr = or(
    inArray(appointments.assignedEmployeeId, employeeIds),
    and(
      isNull(appointments.assignedEmployeeId),
      inArray(customers.primaryEmployeeId, employeeIds),
    ),
  );

  const openRows = await appointmentsRepo.selectColumnsFrom({
      employeeId: sqlBuilder<number>`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`,
      count: sqlBuilder<number>`COUNT(*)::int`,
    }, db)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
        notInArray(appointments.status, ["completed", "cancelled", "expired_unsigned"]),
        employeeOr,
      ),
    )
    .groupBy(sqlBuilder`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`);

  const unsignedRows = await appointmentsRepo.selectColumnsFrom({
      employeeId: sqlBuilder<number>`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`,
      count: sqlBuilder<number>`COUNT(*)::int`,
    }, db)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
        eq(appointments.status, "completed"),
        isNull(appointments.signatureData),
        employeeOr,
      ),
    )
    .groupBy(sqlBuilder`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`);

  const openMap = new Map<number, number>();
  for (const row of openRows) openMap.set(Number(row.employeeId), Number(row.count));
  const unsignedMap = new Map<number, number>();
  for (const row of unsignedRows) unsignedMap.set(Number(row.employeeId), Number(row.count));

  return activeEmployees
    .map((e) => ({
      userId: e.id,
      displayName: e.displayName,
      email: e.email,
      openCount: openMap.get(e.id) ?? 0,
      unsignedCount: unsignedMap.get(e.id) ?? 0,
    }))
    .filter((e) => e.openCount > 0 || e.unsignedCount > 0);
}

async function findSystemActorId(): Promise<number | null> {
  // Auto-Close MUSS auch dann laufen, wenn (vorübergehend) kein
  // Superadmin/Admin existiert. Daher kaskadierende Suche:
  // 1) aktiver Superadmin → 2) aktiver Admin → 3) erster aktiver User
  // (für die NOT NULL FK auf audit_log.user_id und
  // employee_month_closings.closed_by_user_id).
  const su = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isSuperAdmin, true), eq(users.isActive, true)))
    .limit(1);
  if (su[0]) return su[0].id;
  const adm = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.isActive, true)))
    .limit(1);
  if (adm[0]) return adm[0].id;
  const any = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isActive, true))
    .limit(1);
  return any[0]?.id ?? null;
}

export async function autoCloseMonthForCutoff(today: string): Promise<{ closed: number; expired: number; skipped: boolean }> {
  const { year, month } = previousMonth(today);
  if (!isCutoffDay(today, year, month)) {
    return { closed: 0, expired: 0, skipped: true };
  }

  const systemActorId = await findSystemActorId();
  if (systemActorId === null) {
    log("Auto-Close übersprungen: Kein Superadmin/Admin gefunden", "month-close");
    return { closed: 0, expired: 0, skipped: true };
  }

  const { startDate, endDate } = monthDateRange(year, month);

  // Step 1: Mark undocumented appointments as expired_unsigned.
  // Includes:
  //  - any appointment NOT in (cancelled, expired_unsigned) AND NOT completed
  //  - completed appointments without a signature (signature_data IS NULL)
  const expiredResult = await db
    .update(appointments)
    .set({ status: "expired_unsigned" })
    .where(
      and(
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
        notInArray(appointments.status, ["cancelled", "expired_unsigned"]),
        or(
          notInArray(appointments.status, ["completed"]),
          and(eq(appointments.status, "completed"), isNull(appointments.signatureData)),
        ),
      ),
    )
    .returning({ id: appointments.id, employeeId: appointments.assignedEmployeeId });

  for (const row of expiredResult) {
    await auditService.log(
      systemActorId,
      "appointment_expired_unsigned",
      "appointment",
      row.id,
      { year, month, autoClose: true },
    );
  }

  // Step 2: Close month for each active employee with activity in prev month
  const activeEmployees = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isActive, true), eq(users.isAdmin, false)));

  let closedCount = 0;

  for (const emp of activeEmployees) {
    const [hasTimeEntry] = await employeeTimeEntriesRepo.selectColumnsFrom({ count: sqlBuilder<number>`COUNT(*)::int` }, db)
      .where(
        and(
          eq(employeeTimeEntries.userId, emp.id),
          gte(employeeTimeEntries.entryDate, startDate),
          lte(employeeTimeEntries.entryDate, endDate),
          isNull(employeeTimeEntries.deletedAt),
        ),
      );

    // Activity = appointment direkt zugewiesen / ausgeführt ODER unassigned
    // Termin auf einem Kunden mit dieser Person als Primärbetreuung. Damit
    // ist die Attribution konsistent mit Reminder-/Banner-Aggregation
    // (assigned ∪ primary-fallback).
    const [hasAppointment] = await appointmentsRepo.selectColumnsFrom({ count: sqlBuilder<number>`COUNT(*)::int` }, db)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt),
          or(
            eq(appointments.assignedEmployeeId, emp.id),
            eq(appointments.performedByEmployeeId, emp.id),
            and(
              isNull(appointments.assignedEmployeeId),
              eq(customers.primaryEmployeeId, emp.id),
            ),
          ),
        ),
      );

    const hasActivity = Number(hasTimeEntry?.count ?? 0) > 0 || Number(hasAppointment?.count ?? 0) > 0;
    if (!hasActivity) continue;

    // Idempotent: Skip if already closed (and not reopened)
    const [existing] = await db
      .select()
      .from(employeeMonthClosings)
      .where(
        and(
          eq(employeeMonthClosings.userId, emp.id),
          eq(employeeMonthClosings.year, year),
          eq(employeeMonthClosings.month, month),
        ),
      )
      .limit(1);

    if (existing && !existing.reopenedAt) continue;

    await db.transaction(async (tx) => {
      if (existing) {
        await tx
          .update(employeeMonthClosings)
          .set({
            closedAt: new Date(),
            closedByUserId: systemActorId,
            reopenedAt: null,
            reopenedByUserId: null,
          })
          .where(eq(employeeMonthClosings.id, existing.id));
      } else {
        await tx.insert(employeeMonthClosings).values({
          userId: emp.id,
          year,
          month,
          closedByUserId: systemActorId,
        });
      }

      await ensureMonthClosingTask(emp.id, month, year, tx);
      await completeMonthClosingTask(emp.id, month, year, tx);
    });

    await auditService.log(
      systemActorId,
      "month_auto_closed",
      "month_closing",
      emp.id,
      { year, month, autoClose: true, expiredAppointmentsTotal: expiredResult.length },
    );

    closedCount += 1;
  }

  log(
    `Auto-Close für ${month}/${year}: ${closedCount} Mitarbeiter geschlossen, ${expiredResult.length} Termine als verfallen markiert`,
    "month-close",
  );

  return { closed: closedCount, expired: expiredResult.length, skipped: false };
}

type ReminderWave = "T-3" | "T-1" | "T-0";

function buildReminderEmail(
  displayName: string,
  cutoff: string,
  openCount: number,
  unsignedCount: number,
  daysLeft: number,
  companyName: string,
  logoUrl: string | null | undefined,
): { subject: string; html: string } {
  const cutoffDe = cutoff.split("-").reverse().join(".");
  const headline = daysLeft === 0
    ? `Letzter Tag: Monatsabschluss heute um 23:00 Uhr`
    : `Erinnerung: Monatsabschluss in ${daysLeft} Tag${daysLeft === 1 ? "" : "en"}`;
  const total = openCount + unsignedCount;
  const subject = `${headline} — ${total} offene Punkte`;
  const body = `
    <h2 style="margin:0 0 16px 0;">Hallo ${displayName},</h2>
    <p>${headline} (${cutoffDe}).</p>
    <p>Du hast aktuell:</p>
    <ul>
      ${openCount > 0 ? `<li><strong>${openCount}</strong> noch nicht dokumentierte Termine</li>` : ""}
      ${unsignedCount > 0 ? `<li><strong>${unsignedCount}</strong> Termine ohne Unterschrift</li>` : ""}
    </ul>
    <p>Bitte dokumentiere und unterschreibe diese vor dem Cutoff. Nach dem Cutoff können nur noch von der Geschäftsführung Änderungen vorgenommen werden.</p>
    <p>Termine, die bis dahin nicht dokumentiert sind, werden automatisch auf <em>nicht abgerechnet</em> gesetzt und nicht ausgezahlt.</p>
  `;
  return { subject, html: buildEmailLayout(companyName, logoUrl, body) };
}

export async function sendMonthCloseReminders(today: string): Promise<{ wave: ReminderWave | null; sent: number }> {
  const { year, month } = previousMonth(today);
  const cutoff = computeMonthCloseCutoff(year, month);
  const days = daysUntilCutoff(today, year, month);

  let wave: ReminderWave | null = null;
  if (days === 3) wave = "T-3";
  else if (days === 1) wave = "T-1";
  else if (days === 0) wave = "T-0";
  if (!wave) return { wave: null, sent: 0 };

  const blockers = await getEmployeesWithMonthBlockers(year, month);
  if (blockers.length === 0) return { wave, sent: 0 };

  const settings = await storage.getCompanySettings();
  const companyName = settings?.companyName ?? "CareConnect";
  const logoUrl = settings?.logoUrl ?? null;

  let sent = 0;

  for (const emp of blockers) {
    if (await reminderAlreadySent(emp.userId, year, month, wave)) continue;

    // In-App notification
    try {
      await createNotification({
        userId: emp.userId,
        type: "month_close_reminder",
        title:
          wave === "T-0"
            ? "Heute ist Cutoff — Monatsabschluss um 23:00"
            : `Monatsabschluss in ${days} Tag${days === 1 ? "" : "en"}`,
        message: `Du hast ${emp.openCount + emp.unsignedCount} offene Punkte für ${month}/${year}.`,
      });
    } catch (err) {
      console.error("[month-close] In-App-Reminder fehlgeschlagen:", err);
    }

    // WhatsApp
    try {
      await notificationService.dispatchWhatsApp("month_close_reminder", emp.userId, {
        openCount: emp.openCount + emp.unsignedCount,
        cutoffDate: cutoff,
        cutoffTime: "23:00",
      });
    } catch (err) {
      console.error("[month-close] WhatsApp-Reminder fehlgeschlagen:", err);
    }

    // Email
    if (emp.email && settings && settings.smtpHost) {
      try {
        const { subject, html } = buildReminderEmail(
          emp.displayName,
          cutoff,
          emp.openCount,
          emp.unsignedCount,
          days,
          companyName,
          logoUrl,
        );
        await sendEmail(settings, { to: emp.email, subject, html });
      } catch (err) {
        console.error("[month-close] E-Mail-Reminder fehlgeschlagen:", err);
      }
    }

    await auditService.log(
      emp.userId,
      "month_close_reminder_sent",
      "month_closing",
      emp.userId,
      { year, month, wave, openCount: emp.openCount, unsignedCount: emp.unsignedCount },
    );

    sent += 1;
  }

  log(`Reminder-Welle ${wave} für ${month}/${year}: ${sent} Mitarbeiter benachrichtigt`, "month-close");
  return { wave, sent };
}

export async function getMonthCloseBanner(userId: number): Promise<{
  year: number;
  month: number;
  cutoff: string;
  daysUntilCutoff: number;
  openCount: number;
  unsignedCount: number;
  isClosed: boolean;
  expiredCount: number;
} | null> {
  const today = todayBerlinIso();
  const { year, month } = previousMonth(today);
  const { startDate, endDate } = monthDateRange(year, month);
  const cutoff = computeMonthCloseCutoff(year, month);
  const days = daysUntilCutoff(today, year, month);

  const employeeFilter = or(
    eq(appointments.assignedEmployeeId, userId),
    eq(appointments.performedByEmployeeId, userId),
    and(
      isNull(appointments.assignedEmployeeId),
      or(
        eq(customers.primaryEmployeeId, userId),
        eq(customers.backupEmployeeId, userId),
        eq(customers.backupEmployeeId2, userId),
      ),
    ),
  );

  const [openCount] = await appointmentsRepo.selectColumnsFrom({ count: sqlBuilder<number>`COUNT(*)::int` }, db)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
        notInArray(appointments.status, ["completed", "cancelled", "expired_unsigned"]),
        employeeFilter,
      ),
    );

  const [unsignedCount] = await appointmentsRepo.selectColumnsFrom({ count: sqlBuilder<number>`COUNT(*)::int` }, db)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
        eq(appointments.status, "completed"),
        isNull(appointments.signatureData),
        employeeFilter,
      ),
    );

  const [expiredCount] = await appointmentsRepo.selectColumnsFrom({ count: sqlBuilder<number>`COUNT(*)::int` }, db)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
        eq(appointments.status, "expired_unsigned"),
        employeeFilter,
      ),
    );

  const [closing] = await db
    .select()
    .from(employeeMonthClosings)
    .where(
      and(
        eq(employeeMonthClosings.userId, userId),
        eq(employeeMonthClosings.year, year),
        eq(employeeMonthClosings.month, month),
      ),
    )
    .limit(1);

  const isClosed = !!(closing && !closing.reopenedAt);

  const open = Number(openCount?.count ?? 0);
  const unsigned = Number(unsignedCount?.count ?? 0);
  const expired = Number(expiredCount?.count ?? 0);

  // Show banner whenever:
  //  - the previous month is closed (info row), OR
  //  - the cutoff window is still active (days >= 0) — countdown for everyone
  //    with the previous-month context, OR
  //  - there are blockers / expired entries the user should see.
  // Only hide if the cutoff has long passed AND there is nothing to show.
  if (!isClosed && days < 0 && open === 0 && unsigned === 0 && expired === 0) {
    return null;
  }

  return {
    year,
    month,
    cutoff,
    daysUntilCutoff: days,
    openCount: open,
    unsignedCount: unsigned,
    isClosed,
    expiredCount: expired,
  };
}

let lastDailyRunDate: string | null = null;

async function runDaily(): Promise<void> {
  const today = todayBerlinIso();
  const hour = berlinHour();

  // Reminders fire once per day (>= 8:00 Berlin)
  if (hour >= 8 && lastDailyRunDate !== today + "-reminder") {
    try {
      await sendMonthCloseReminders(today);
      lastDailyRunDate = today + "-reminder";
    } catch (err) {
      console.error("[month-close] Reminder-Fehler:", err);
    }
  }

  // Auto-close fires at >= 23:00 Berlin on the cutoff day
  if (hour >= 23 && lastDailyRunDate !== today + "-autoclose") {
    try {
      await autoCloseMonthForCutoff(today);
      lastDailyRunDate = today + "-autoclose";
    } catch (err) {
      console.error("[month-close] Auto-Close-Fehler:", err);
    }
  }
}

export function startMonthCloseScheduler(): { interval: NodeJS.Timeout } {
  const interval = setInterval(() => {
    runDaily().catch((err) => console.error("[month-close] Scheduler-Fehler:", err));
  }, POLL_INTERVAL_MS);
  // Run once on startup (best-effort)
  runDaily().catch((err) => console.error("[month-close] Scheduler-Initiallauf-Fehler:", err));
  return { interval };
}
