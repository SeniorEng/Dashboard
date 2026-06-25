import { db, type DbOrTx } from "../lib/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { employeeTimeEntries } from "@shared/schema";
import { getVacationHolidayDates } from "@shared/utils/holidays";
import { auditService } from "../services/audit";
import { log } from "../lib/log";

/**
 * Task #602: Bestandsdaten-Bereinigung — soft-löscht alle aktiven
 * `urlaub`-Einträge, deren Datum auf einen gesetzlichen Feiertag in
 * Sachsen fällt. Idempotent: läuft nur über `deletedAt IS NULL`-Zeilen,
 * setzt `deletedAt` und schreibt pro Eintrag einen Audit-Log
 * `vacation_holiday_cleanup`. Wenn alle betroffenen Einträge bereits
 * weggeräumt sind, ist der Aufruf ein No-Op.
 */
export async function cleanupVacationOnHolidays(exec: DbOrTx = db): Promise<number> {
  const candidates = await exec
    .select({
      id: employeeTimeEntries.id,
      userId: employeeTimeEntries.userId,
      entryDate: employeeTimeEntries.entryDate,
    })
    .from(employeeTimeEntries)
    .where(
      and(
        eq(employeeTimeEntries.entryType, "urlaub"),
        isNull(employeeTimeEntries.deletedAt),
      ),
    );

  if (candidates.length === 0) return 0;

  const yearCache = new Map<number, Set<string>>();
  function holidaysFor(year: number): Set<string> {
    let s = yearCache.get(year);
    if (!s) {
      s = getVacationHolidayDates(year);
      yearCache.set(year, s);
    }
    return s;
  }

  const toDelete = candidates.filter((c) => {
    const year = Number(c.entryDate.substring(0, 4));
    if (!Number.isFinite(year)) return false;
    return holidaysFor(year).has(c.entryDate);
  });

  if (toDelete.length === 0) return 0;

  const ids = toDelete.map((c) => c.id);
  await exec
    .update(employeeTimeEntries)
    .set({ deletedAt: sql`NOW()` })
    .where(inArray(employeeTimeEntries.id, ids));

  for (const c of toDelete) {
    try {
      await auditService.log(
        c.userId,
        "vacation_holiday_cleanup",
        "time_entry",
        c.id,
        {
          entryDate: c.entryDate,
          reason: "Task #602 — Urlaubseintrag auf gesetzlichem Feiertag soft-gelöscht",
        },
      );
    } catch (err) {
      log(`vacation_holiday_cleanup audit failed for entry ${c.id}: ${err}`, "startup");
    }
  }

  log(`Task #602: ${toDelete.length} Urlaubseintrag/-einträge auf Feiertagen soft-gelöscht`, "startup");
  return toDelete.length;
}
