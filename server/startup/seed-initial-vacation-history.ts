import { db } from "../lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { users, vacationEntitlementHistory } from "@shared/schema";
import { log } from "../lib/log";

/**
 * Bestandsdaten-Migration für Task #279 (Anteiliger Jahresurlaub bei
 * unterjähriger Änderung). Idempotent: erzeugt für jeden aktiven Mitarbeiter
 * ohne History-Eintrag einen Initial-Eintrag basierend auf Eintrittsdatum
 * (oder dem aktuellen Jahr) und dem aktuell gespeicherten
 * `vacationDaysPerYear`. So bleibt das Verhalten bestehender Datensätze
 * unverändert, neue unterjährige Änderungen werden anteilig berechnet.
 */
export async function seedInitialVacationHistory(): Promise<number> {
  const currentYear = new Date().getFullYear();

  const allEmployees = await db.select({
    id: users.id,
    vacationDaysPerYear: users.vacationDaysPerYear,
    eintrittsdatum: users.eintrittsdatum,
  })
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
      )
    );

  if (allEmployees.length === 0) return 0;

  const userIds = allEmployees.map(e => e.id);
  const existing = await db.select({ userId: vacationEntitlementHistory.userId })
    .from(vacationEntitlementHistory)
    .where(inArray(vacationEntitlementHistory.userId, userIds));
  const haveHistory = new Set(existing.map(r => r.userId));

  const toSeed = allEmployees.filter(e => !haveHistory.has(e.id));
  if (toSeed.length === 0) return 0;

  let seeded = 0;
  for (const emp of toSeed) {
    const vacDays = emp.vacationDaysPerYear ?? 30;
    let validFromYear = currentYear;
    let validFromMonth = 1;
    if (emp.eintrittsdatum) {
      // eintrittsdatum kommt als ISO-String (YYYY-MM-DD).
      const [yStr, mStr] = emp.eintrittsdatum.split("-");
      const y = Number(yStr);
      const m = Number(mStr);
      if (Number.isFinite(y) && Number.isFinite(m)) {
        validFromYear = y;
        validFromMonth = Math.max(1, Math.min(12, m));
      }
    }

    try {
      const inserted = await db.insert(vacationEntitlementHistory)
        .values({
          userId: emp.id,
          validFromYear,
          validFromMonth,
          daysPerYear: vacDays,
          createdBy: null,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) seeded++;
    } catch (err) {
      log(`Urlaubs-Historie-Seed-Fehler bei Mitarbeiter ${emp.id}: ${err}`, "startup");
    }
  }

  return seeded;
}
