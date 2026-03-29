import { scheduledCalls } from "@shared/schema";
import { eq, and, lte, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { initiateLeadCallBridge } from "./twilio-call-bridge";
import { prospectStorage } from "../storage/prospects";
import { withTimeout } from "../lib/with-timeout";

const DELAY_MINUTES = 10;
const MONDAY_CALL_HOUR = 9;
const SATURDAY_CUTOFF_HOUR = 12;
const POLL_INTERVAL_MS = 60_000;

interface CallScheduleResult {
  callAt: Date;
  isWeekendDeferred: boolean;
  reason: string;
}

interface ScheduledCallRow {
  id: number;
  prospect_id: number;
  lead_name: string;
  lead_phone: string;
  quelle: string | null;
  scheduled_at: Date;
  status: string;
  reason: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  executed_at: Date | null;
}

function getBerlinTime(date: Date): { day: number; hour: number } {
  const berlinStr = date.toLocaleString("en-US", { timeZone: "Europe/Berlin", weekday: "short", hour: "numeric", hour12: false });
  const parts = berlinStr.split(", ");
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[parts[0]] ?? date.getDay();
  const hour = parseInt(parts[1], 10);
  return { day, hour };
}

function getNextMondayAt9Berlin(referenceDate: Date): Date {
  const berlin = getBerlinTime(referenceDate);
  const daysUntilMonday = berlin.day === 0 ? 1 : 2;

  const mondayCallAt = new Date(referenceDate);
  mondayCallAt.setDate(mondayCallAt.getDate() + daysUntilMonday);

  const mondayStr = mondayCallAt.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
  const [year, month, dayOfMonth] = mondayStr.split("-").map(Number);

  const berlinMondayMorning = new Date(`${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}T${String(MONDAY_CALL_HOUR).padStart(2, "0")}:00:00`);

  const berlinOffset = getBerlinUtcOffsetMs(berlinMondayMorning);
  return new Date(berlinMondayMorning.getTime() - berlinOffset);
}

function getBerlinUtcOffsetMs(date: Date): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const berlinStr = date.toLocaleString("en-US", { timeZone: "Europe/Berlin" });
  const utcDate = new Date(utcStr);
  const berlinDate = new Date(berlinStr);
  return berlinDate.getTime() - utcDate.getTime();
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
    console.log(`[call-scheduler] Weekend call scheduled for prospect ${params.prospectId} at ${schedule.callAt.toISOString()}`);
    return;
  }

  const delayMs = schedule.callAt.getTime() - now.getTime();
  console.log(`[call-scheduler] Call for prospect ${params.prospectId} delayed by ${Math.round(delayMs / 1000)}s via setTimeout (until ${schedule.callAt.toISOString()})`);

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

    const claimedResult = await db.execute(sql`
      UPDATE scheduled_calls
      SET status = 'processing'
      WHERE id IN (
        SELECT id FROM scheduled_calls
        WHERE status = 'pending' AND scheduled_at <= ${now}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);

    const rows = claimedResult.rows as ScheduledCallRow[];

    for (const call of rows) {
      try {
        await initiateLeadCallBridge({
          prospectId: call.prospect_id,
          leadName: call.lead_name,
          leadPhone: call.lead_phone,
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

        console.log(`[call-scheduler] Executed scheduled call ${call.id} for prospect ${call.prospect_id}`);
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
          await safeAddNote(call.prospect_id, `Geplanter Anruf endgültig fehlgeschlagen nach ${newAttempts} Versuchen: ${errorMsg}`);
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
  console.log(`[call-scheduler] Poller started (every ${POLL_INTERVAL_MS / 1000}s)`);
}

export function stopCallSchedulerPoller(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log("[call-scheduler] Poller stopped");
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
