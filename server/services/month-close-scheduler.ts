import { and, eq, gte, lte, isNull, inArray, notInArray, sql as sqlBuilder } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  auditLog,
  employeeMonthClosings,
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
// Task #1195: Direkt das Blatt-Modul importieren (gehostete Funktions-
// Deklarationen), NICHT über die `timeTrackingStorage`-Facade. Die Facade ist
// ein Objekt-Literal, dessen Methoden-Referenzen zum Init-Zeitpunkt eingefroren
// werden; unter der Modul-Init-/Zirkular-Import-Reihenfolge konnte
// `getAdminMonthClosingReadiness` daher zur Aufrufzeit `undefined` sein
// ("is not a function"). Der Scheduler bindet hier — konsistent mit
// `../storage/notifications` und `../storage/tasks` — direkt an die Quelle.
import {
  getAdminMonthClosingReadiness,
  getMonthClosingReadiness,
  getMonthClosing,
  closeMonth,
} from "../storage/time-tracking/month-closing";
import { sendEmail, buildEmailLayout, buildLogoInlineAttachment, EMAIL_LOGO_SRC } from "./email-service";
import { ensureMonthClosingTask, completeMonthClosingTask } from "../storage/tasks";
import { generateAutoBreaksForMonth, insertAutoBreaks } from "./auto-breaks";
import { appointmentsRepo } from "../repos";
import { appointmentNotDocumentedCondition } from "../lib/appointment-signed";

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
  // Task #1172: Reminder-Blocker werden aus der EINEN geteilten Readiness-Definition
  // abgeleitet (`getAdminMonthClosingReadiness`), nicht mehr aus paralleler SQL.
  // Damit zählen Banner, Reminder, Auto-Close und Admin-Close exakt dieselben
  // offenen/unsignierten Termine (inkl. LN-bewusster „unsigniert"-Definition und
  // einheitlicher Verantwortlichkeits-Attribution).
  const readiness = await getAdminMonthClosingReadiness(year, month);
  const blocked = readiness.filter(
    (e) => !e.isClosed && (e.openAppointments.length > 0 || e.unsignedAppointments.length > 0),
  );
  if (blocked.length === 0) return [];

  const blockedIds = blocked.map((e) => e.userId);
  const emailRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, blockedIds));
  const emailMap = new Map(emailRows.map((r) => [r.id, r.email]));

  return blocked.map((e) => ({
    userId: e.userId,
    displayName: e.displayName,
    email: emailMap.get(e.userId) ?? null,
    openCount: e.openAppointments.length,
    unsignedCount: e.unsignedAppointments.length,
  }));
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

export async function autoCloseMonthForCutoff(today: string): Promise<{ closed: number; expired: number; missingSignatures: number; skipped: boolean }> {
  const { year, month } = previousMonth(today);
  if (!isCutoffDay(today, year, month)) {
    return { closed: 0, expired: 0, missingSignatures: 0, skipped: true };
  }

  const systemActorId = await findSystemActorId();
  if (systemActorId === null) {
    log("Auto-Close übersprungen: Kein Superadmin/Admin gefunden", "month-close");
    return { closed: 0, expired: 0, missingSignatures: 0, skipped: true };
  }

  const { startDate, endDate } = monthDateRange(year, month);

  // Task #1496: „Nicht abgerechnet" ist ein abgeleitetes Anzeige-Label und
  // von der Unterschrift ENTKOPPELT — es zählt allein die nicht dokumentierten
  // Termine (status != 'completed'), nicht die unsignierten. Wir ermitteln die
  // Zahl nur READ-ONLY, für Log/Return/Audit-Metadaten — ohne Schreibvorgang.
  // Der Monatsabschluss überschreibt KEINEN Termin-Status; die Periodensperre
  // hängt allein an `employee_month_closings`.
  const [expiredAgg] = await appointmentsRepo.selectColumnsFrom({ count: sqlBuilder<number>`COUNT(*)::int` }, db)
    .where(
      and(
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
        notInArray(appointments.status, ["cancelled", "customer_no_show"]),
        appointmentNotDocumentedCondition(),
      ),
    );
  const expiredCount = Number(expiredAgg?.count ?? 0);

  // Task #1496: Der Auto-Close ist die EINZIGE Abschluss-Mechanik und schließt
  // BEDINGUNGSLOS — jeder Mitarbeiter mit Aktivität im Vormonat wird am Cutoff
  // geschlossen, UNABHÄNGIG von offenen/undokumentierten/unsignierten Terminen.
  // Es gibt keinen blockierenden/eskalierenden Pfad mehr; offene Termine werden
  // zu „Nicht abgerechnet" (abgeleitet), fehlende Unterschriften wandern in die
  // aktive „fehlende Unterschriften nach Abschluss"-Liste (siehe unten).
  // `getAdminMonthClosingReadiness` liefert weiterhin Aktivitäts-/Offen-/
  // Unsigniert-Zählungen für Audit-Metadaten und die Nachverfolgung.
  const readiness = await getAdminMonthClosingReadiness(year, month);

  let closedCount = 0;
  let missingSignatureEmployees = 0;

  for (const emp of readiness) {
    // Keine Aktivität im Vormonat → nichts abzuschließen.
    if (!emp.hasTimeEntries) continue;
    // Idempotent: bereits (nicht wieder geöffnet) geschlossen.
    if (emp.isClosed) continue;

    // Bedingungslos schließen, mit Parität zum bisherigen Close: Auto-Pausen
    // generieren+einfügen, Closing schreiben, Aufgabe abschließen.
    const existing = emp.closingId
      ? await getMonthClosing(emp.userId, year, month)
      : null;

    const autoBreaks = await generateAutoBreaksForMonth(emp.userId, year, month);

    const insertedCount = await db.transaction(async (tx) => {
      const inserted = await insertAutoBreaks(emp.userId, autoBreaks, tx);
      await closeMonth(emp.userId, year, month, systemActorId, existing?.id, tx);
      await ensureMonthClosingTask(emp.userId, month, year, tx);
      await completeMonthClosingTask(emp.userId, month, year, tx);
      return inserted;
    });

    await auditService.log(
      systemActorId,
      "month_auto_closed",
      "month_closing",
      emp.userId,
      {
        year,
        month,
        autoClose: true,
        autoBreaksInserted: insertedCount,
        expiredAppointmentsTotal: expiredCount,
        openAppointments: emp.openAppointments.length,
        missingSignatures: emp.unsignedAppointments.length,
      },
    );

    closedCount += 1;

    // Task #1496: Fehlende Unterschriften BLOCKIEREN den Abschluss nicht mehr,
    // sondern werden NACH dem Abschluss aktiv nachgehalten. Für jeden geschlossenen
    // Mitarbeiter mit dokumentierten, aber noch nicht unterschriebenen Terminen
    // wird eine Benachrichtigung erzeugt, damit die Unterschrift nachgeholt wird
    // (LN-Erstellung/-Signatur bleibt nach Abschluss erlaubt).
    if (emp.unsignedAppointments.length > 0) {
      missingSignatureEmployees += 1;
      try {
        await createNotification({
          userId: emp.userId,
          type: "month_close_missing_signature",
          title: `Fehlende Unterschriften: ${month}/${year}`,
          message: `Der Monat ${month}/${year} ist abgeschlossen, aber ${emp.unsignedAppointments.length} dokumentierte Termine sind noch nicht unterschrieben. Bitte hole die Unterschriften nach.`,
          referenceType: "employee",
          referenceId: emp.userId,
        });
      } catch (err) {
        console.error("[month-close] Benachrichtigung fehlende Unterschrift fehlgeschlagen:", err);
      }
    }
  }

  log(
    `Auto-Close für ${month}/${year}: ${closedCount} Mitarbeiter bedingungslos geschlossen, ${missingSignatureEmployees} mit fehlenden Unterschriften (nachgehalten), ${expiredCount} Termine nicht dokumentiert (abgeleitet „Nicht abgerechnet", kein Status-Schreibvorgang)`,
    "month-close",
  );

  return { closed: closedCount, expired: expiredCount, missingSignatures: missingSignatureEmployees, skipped: false };
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
  // Load the logo bytes once for the whole reminder wave and embed it as an
  // inline (cid:) attachment in every reminder email (Task #1092).
  const logoAttachment = await buildLogoInlineAttachment(settings?.logoUrl ?? null);
  const logoUrl = logoAttachment ? EMAIL_LOGO_SRC : null;

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
        await sendEmail(settings, {
          to: emp.email,
          subject,
          html,
          attachments: logoAttachment ? [logoAttachment] : undefined,
        });
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
  const cutoff = computeMonthCloseCutoff(year, month);
  const days = daysUntilCutoff(today, year, month);

  // Task #1172: Das Banner leitet offene/unsignierte Termine aus der EINEN
  // geteilten Readiness-Definition ab (Mechanism A: `employee_month_closings`
  // für „abgeschlossen" + `getMonthClosingReadiness` für die Blocker). Keine
  // parallele Banner-eigene SQL mehr — Banner, Reminder und Abschluss zählen
  // damit garantiert dasselbe.
  const readiness = await getMonthClosingReadiness(userId, year, month);

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

  let open = readiness.openAppointments.length;
  const unsigned = readiness.unsignedAppointments.length;
  let expired = 0;

  // Task #1496: „Nicht abgerechnet" ist ein abgeleitetes Anzeige-Label und von
  // der Unterschrift ENTKOPPELT. Ist der Monat geschlossen, gelten nur noch die
  // NICHT dokumentierten (offenen) Termine als verfallen (`expired`). Die
  // dokumentierten, aber noch nicht unterschriebenen Termine (`unsigned`) bleiben
  // als „fehlende Unterschriften" sichtbar und nachzuholen (LN nach Abschluss
  // weiterhin erlaubt) — sie verfallen NICHT. Vor dem Abschluss bleiben offene
  // Termine als offen sichtbar.
  if (isClosed) {
    expired = open;
    open = 0;
  }

  // Show banner whenever:
  //  - the previous month is closed (info row + fehlende Unterschriften), OR
  //  - the cutoff window is still active (days >= 0) — countdown for everyone
  //    with the previous-month context, OR
  //  - there are open/unsigned entries the user should see.
  // Only hide if the cutoff has long passed AND there is nothing to show.
  if (!isClosed && days < 0 && open === 0 && unsigned === 0) {
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
