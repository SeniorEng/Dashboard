import { db } from "./db";
import { users } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import type { User, SafeUser } from "@shared/schema";

/**
 * Prüft, ob ein Benutzer als Teamleiter markiert ist und aktiv.
 * Admins/SuperAdmins sind keine Teamleiter, auch wenn sie das Flag tragen würden.
 */
export function isTeamLead(
  user:
    | Pick<User, "isTeamLead" | "isActive" | "isAdmin" | "isSuperAdmin">
    | SafeUser
    | null
    | undefined,
): boolean {
  if (!user) return false;
  if (user.isAdmin || (user as { isSuperAdmin?: boolean }).isSuperAdmin) return false;
  return Boolean(user.isTeamLead) && Boolean(user.isActive);
}

/**
 * Liefert die IDs aller aktiven, nicht-anonymisierten Mitarbeiter, die dem
 * gegebenen Teamleiter zugeordnet sind. Liefert leeres Array, wenn der
 * Teamleiter selbst nicht mehr aktiv ist oder die Markierung fehlt.
 */
export async function getTeamMemberIds(teamLeadId: number): Promise<number[]> {
  const [lead] = await db
    .select({ id: users.id, isTeamLead: users.isTeamLead, isActive: users.isActive, isAnonymized: users.isAnonymized })
    .from(users)
    .where(eq(users.id, teamLeadId))
    .limit(1);

  if (!lead || !lead.isTeamLead || !lead.isActive || lead.isAnonymized) {
    return [];
  }

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.teamLeadId, teamLeadId),
        eq(users.isActive, true),
        eq(users.isAnonymized, false),
      ),
    );

  return rows.map((r) => r.id);
}

/**
 * Liefert alle aktiven Mitarbeiter, die dem gegebenen Teamleiter zugeordnet sind
 * (auch wenn der Teamleiter selbst aktuell deaktiviert wäre — für Validierungs-/
 * Aufräumzwecke).
 */
export async function countActiveReports(teamLeadId: number): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.teamLeadId, teamLeadId),
        eq(users.isActive, true),
        eq(users.isAnonymized, false),
      ),
    );
  return rows.length;
}
