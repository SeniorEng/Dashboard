import { db } from "./db";
import { users } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import type { User, SafeUser } from "@shared/schema";
import { getAssignedCustomerIds } from "../storage/customers-storage";

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

export type ActorRole = "admin" | "teamLead" | "employee";

/**
 * Liefert die Rolle des handelnden Users für Audit-Logs.
 * Admin/SuperAdmin → "admin"; aktiver Teamleiter → "teamLead";
 * sonst (regulärer Mitarbeiter) → "employee".
 */
export function actorRole(
  user:
    | Pick<User, "isTeamLead" | "isActive" | "isAdmin" | "isSuperAdmin">
    | SafeUser
    | null
    | undefined,
): ActorRole {
  if (!user) return "employee";
  if (user.isAdmin || (user as { isSuperAdmin?: boolean }).isSuperAdmin) return "admin";
  if (isTeamLead(user)) return "teamLead";
  return "employee";
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
 * Liefert die Mitarbeiter-IDs, deren Termine ein Teamleiter sehen darf:
 * den Teamleiter selbst plus alle aktiven, nicht-anonymisierten Team-Mitglieder.
 * Liefert leeres Array, wenn die Person kein Teamleiter (mehr) ist.
 */
export async function getTeamLeadVisibleEmployeeIds(teamLeadId: number): Promise<number[]> {
  const memberIds = await getTeamMemberIds(teamLeadId);
  if (memberIds.length === 0) {
    // getTeamMemberIds liefert auch [], wenn der Lead selbst nicht (mehr) aktiv ist.
    const [lead] = await db
      .select({ id: users.id, isTeamLead: users.isTeamLead, isActive: users.isActive, isAnonymized: users.isAnonymized })
      .from(users)
      .where(eq(users.id, teamLeadId))
      .limit(1);
    if (!lead || !lead.isTeamLead || !lead.isActive || lead.isAnonymized) {
      return [];
    }
    return [teamLeadId];
  }
  const all = new Set<number>([teamLeadId, ...memberIds]);
  return Array.from(all).sort((a, b) => a - b);
}

/**
 * Liefert die Vereinigung aller Kunden-IDs, auf die der Teamleiter und seine
 * aktiven Team-Mitglieder Zugriff haben (Haupt-/Vertretungs-Mitarbeiter ODER
 * Mitarbeiter eines Termins für diesen Kunden).
 */
export async function getTeamLeadVisibleCustomerIds(teamLeadId: number): Promise<number[]> {
  const employeeIds = await getTeamLeadVisibleEmployeeIds(teamLeadId);
  if (employeeIds.length === 0) return [];
  const lists = await Promise.all(employeeIds.map((id) => getAssignedCustomerIds(id)));
  const set = new Set<number>();
  for (const list of lists) for (const id of list) set.add(id);
  return Array.from(set).sort((a, b) => a - b);
}

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
