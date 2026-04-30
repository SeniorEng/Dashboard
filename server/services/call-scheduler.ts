import { scheduledCalls } from "@shared/schema";
import { eq, and, lte, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { initiateLeadCallBridge } from "./twilio-call-bridge";
import { prospectStorage } from "../storage/prospects";
import { withTimeout } from "../lib/with-timeout";
import { log } from "../lib/log";

const DELAY_MINUTES = 10;
const MONDAY_CALL_HOUR = 9;
const SATURDAY_CUTOFF_HOUR = 12;
const POLL_INTERVAL_MS = 60_000;

interface CallScheduleResult {
  callAt: Date;
  isWeekendDeferred: boolean;
  reason: string;
}

function getBerlinTime(date: Date): { day: number; hour: number } {
  // K5: TZ-neutral via Intl.DateTimeFormat.formatToParts statt
  // toLocaleString-String-Parsing. So entfällt jede Abhängigkeit von
  // der Server-TZ.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hourParsed = parseInt(hourStr, 10);
  // Intl liefert in en-US/hour12:false bei Mitternacht "24" statt "0".
  const hour = Number.isFinite(hourParsed) ? hourParsed % 24 : 0;
  return { day: dayMap[weekday] ?? date.getUTCDay(), hour };
}

function getNextMondayAt9Berlin(referenceDate: Date): Date {
  const berlin = getBerlinTime(referenceDate);
  const daysUntilMonday = berlin.day === 0 ? 1 : 2;

  const mondayCallAt = new Date(referenceDate);
  mondayCallAt.setDate(mondayCallAt.getDate() + daysUntilMonday);

  // Berlin-Kalenderdatum des Zieltags TZ-neutral extrahieren.
  const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });
  const mondayStr = dateFmt.format(mondayCallAt);
  const [year, month, dayOfMonth] = mondayStr.split("-").map(Number);

  // 09:00 Berlin in UTC umrechnen: utc = 09:00_local − berlinOffset.
  // Den Offset lesen wir am Zieltag selbst, damit DST-Übergänge korrekt
  // berücksichtigt werden.
  const utcGuess = Date.UTC(year, month - 1, dayOfMonth, MONDAY_CALL_HOUR, 0, 0);
  const offsetMs = getBerlinUtcOffsetMs(new Date(utcGuess));
  return new Date(utcGuess - offsetMs);
}

function getBerlinUtcOffsetMs(date: Date): number {
  // K5: Berlin-Offset via Intl.DateTimeFormat shortOffset, statt zwei
  // toLocaleString-Strings durch `new Date()` zu schicken (das
  // funktionierte mathematisch durch Differenzbildung, hing aber
  // implizit am Roundtrip-Verhalten der ICU-Locale).
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const match = tzName.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = parseInt(match[2], 10);
  const minutes = match[3] ? parseInt(match[3], 10) : 0;
  return sign * (hours * 60 + minutes) * 60 * 1000;
}

export function calculateNextCallTime(now: Date): CallScheduleResult {
  const callAt = new Date(now.getTime() + DELAY_MINUTES * 60_000);

  const berlin = getBerlinTime(callAt);

  const isSaturdayAfterCutoff = berlin.day === 6 && berlin.hour >= SATURDAY_CUTOFF_HOUR;
  const isSunday = berlin.day === 0;

  if (isSaturdayAfterCutoff || isSunday) {
    const mondayCallAt = getNextMondayAt9Berlin(callAt);
    return {
      callAt: mondayCallAt,
      isWeekendDeferred: true,
      reason: `Wochenende — Anruf verschoben auf Montag ${MONDAY_CALL_HOUR}:00 Uhr`,
    };
  }

  return {
    callAt,
    isWeekendDeferred: false,
    reason: `Anruf um ${DELAY_MINUTES} Min verzögert`,
  };
}

export async function scheduleLeadCall(params: {
  prospectId: number;
  leadName: string;
  leadPhone: string;
  quelle: string;
}): Promise<void> {
  const now = new Date();
  const schedule = calculateNextCallTime(now);

  const noteText = `Anruf geplant für ${formatGermanDateTime(schedule.callAt)} (${schedule.reason})`;
  await safeAddNote(params.prospectId, noteText);

  if (schedule.isWeekendDeferred) {
    await db.insert(scheduledCalls).values({
      prospectId: params.prospectId,
      leadName: params.leadName,
      leadPhone: params.leadPhone,
      quelle: params.quelle,
      scheduledAt: schedule.callAt,
      status: "pending",
      reason: schedule.reason,
    });
    log(`Weekend call scheduled for prospect ${params.prospectId} at ${schedule.callAt.toISOString()}`, "call-scheduler");
    return;
  }

  const delayMs = schedule.callAt.getTime() - now.getTime();
  log(`Call for prospect ${params.prospectId} delayed by ${Math.round(delayMs / 1000)}s via setTimeout (until ${schedule.callAt.toISOString()})`, "call-scheduler");

  setTimeout(() => {
    initiateLeadCallBridge({
      prospectId: params.prospectId,
      leadName: params.leadName,
      leadPhone: params.leadPhone,
      quelle: params.quelle,
    }).catch(err => {
      console.error(`[call-scheduler] Delayed call failed for prospect ${params.prospectId}:`, err);
    });
  }, delayMs);
}

const STALE_PROCESSING_TIMEOUT_MS = 5 * 60_000;

async function processPendingCalls(): Promise<void> {
  try {
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - STALE_PROCESSING_TIMEOUT_MS);

    await db.execute(sql`
      UPDATE scheduled_calls
      SET status = 'pending'
      WHERE status = 'processing'
        AND scheduled_at <= ${staleThreshold}
    `);

    const pendingCalls = await db
      .select()
      .from(scheduledCalls)
      .where(and(
        eq(scheduledCalls.status, "pending"),
        lte(scheduledCalls.scheduledAt, now)
      ));

    for (const call of pendingCalls) {
      const claimed = await db
        .update(scheduledCalls)
        .set({ status: "processing" })
        .where(and(
          eq(scheduledCalls.id, call.id),
          eq(scheduledCalls.status, "pending")
        ))
        .returning();

      if (claimed.length === 0) continue;

      try {
        await initiateLeadCallBridge({
          prospectId: call.prospectId,
          leadName: call.leadName,
          leadPhone: call.leadPhone,
          quelle: call.quelle || "unbekannt",
          throwOnError: true,
        });

        await db
          .update(scheduledCalls)
          .set({
            status: "completed",
            executedAt: new Date(),
            attempts: (call.attempts ?? 0) + 1,
          })
          .where(eq(scheduledCalls.id, call.id));

        log(`Executed scheduled call ${call.id} for prospect ${call.prospectId}`, "call-scheduler");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const newAttempts = (call.attempts ?? 0) + 1;
        const newStatus = newAttempts >= 3 ? "failed" : "pending";

        await db
          .update(scheduledCalls)
          .set({
            status: newStatus,
            attempts: newAttempts,
            lastError: errorMsg,
          })
          .where(eq(scheduledCalls.id, call.id));

        console.error(`[call-scheduler] Failed to execute scheduled call ${call.id} (attempt ${newAttempts}):`, errorMsg);

        if (newStatus === "failed") {
          await safeAddNote(call.prospectId, `Geplanter Anruf endgültig fehlgeschlagen nach ${newAttempts} Versuchen: ${errorMsg}`);
        }
      }
    }
  } catch (err) {
    console.error("[call-scheduler] Error processing pending calls:", err instanceof Error ? err.message : err);
  }
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

export function startCallSchedulerPoller(): void {
  if (pollInterval) return;
  pollInterval = setInterval(processPendingCalls, POLL_INTERVAL_MS);
  log(`Poller started (every ${POLL_INTERVAL_MS / 1000}s)`, "call-scheduler");
}

export function stopCallSchedulerPoller(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    log("Poller stopped", "call-scheduler");
  }
}

function formatGermanDateTime(date: Date): string {
  return date.toLocaleString("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

async function safeAddNote(prospectId: number, noteText: string): Promise<void> {
  try {
    await withTimeout(
      () => prospectStorage.addNote({ prospectId, noteText, noteType: "notiz" }),
      10000,
      `callScheduler addNote (prospect ${prospectId})`
    );
  } catch (err) {
    console.error(`[call-scheduler] Failed to save note for prospect ${prospectId}:`, err instanceof Error ? err.message : err);
  }
}
