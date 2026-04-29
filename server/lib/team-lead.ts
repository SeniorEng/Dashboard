import type { User, SafeUser } from "@shared/schema";

/**
 * Prüft, ob ein Benutzer als Teamleiter markiert ist und aktiv.
 * Admins/SuperAdmins sind keine Teamleiter, auch wenn sie das Flag tragen würden.
 * Anonymisierte oder inaktive Nutzer gelten ebenfalls nicht als Teamleitung.
 */
export function isTeamLead(
  user:
    | Pick<User, "isTeamLead" | "isActive" | "isAdmin" | "isSuperAdmin" | "isAnonymized">
    | SafeUser
    | null
    | undefined,
): boolean {
  if (!user) return false;
  if (user.isAdmin || (user as { isSuperAdmin?: boolean }).isSuperAdmin) return false;
  if ((user as { isAnonymized?: boolean }).isAnonymized) return false;
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
    | Pick<User, "isTeamLead" | "isActive" | "isAdmin" | "isSuperAdmin" | "isAnonymized">
    | SafeUser
    | null
    | undefined,
): ActorRole {
  if (!user) return "employee";
  if (user.isAdmin || (user as { isSuperAdmin?: boolean }).isSuperAdmin) return "admin";
  if (isTeamLead(user)) return "teamLead";
  return "employee";
}
