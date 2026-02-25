import { eq, and, lt, gt, isNull, sql } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { formatDateISO } from "@shared/utils/datetime";
import {
  users,
  userRoles,
  sessions,
  passwordResetTokens,
  customerAssignmentHistory,
  type User,
  type UserWithRoles,
  type EmployeeRole,
  EMPLOYEE_ROLES,
} from "@shared/schema";
import { db } from "../lib/db";
import { sessionCache } from "./cache";

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const SESSION_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours absolute maximum
const PASSWORD_RESET_DURATION_MS = 60 * 60 * 1000; // 1 hour
const WELCOME_TOKEN_DURATION_MS = 48 * 60 * 60 * 1000; // 48 hours
const BCRYPT_ROUNDS = 12;

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.includes(":") && storedHash.length === 97) {
    const [salt, hash] = storedHash.split(":");
    const inputHash = createHash("sha256")
      .update(password + salt)
      .digest("hex");
    return hash === inputHash;
  }
  return bcrypt.compare(password, storedHash);
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreateUserData {
  email: string;
  password: string;
  vorname: string;
  nachname: string;
  telefon?: string;
  strasse?: string;
  hausnummer?: string;
  plz?: string;
  stadt?: string;
  geburtsdatum?: string;
  eintrittsdatum?: string;
  vacationDaysPerYear?: number;
  isAdmin?: boolean;
  haustierAkzeptiert?: boolean;
  isEuRentner?: boolean;
  employmentType?: string;
  weeklyWorkDays?: number;
  monthlyWorkHours?: number | null;
  roles?: EmployeeRole[];
}

export class AuthService {
  async createUser(data: CreateUserData): Promise<UserWithRoles> {
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, data.email.toLowerCase()));

    if (existingUser.length > 0) {
      throw new Error("Ein Benutzer mit dieser E-Mail-Adresse existiert bereits");
    }

    const passwordHash = await hashPassword(data.password);
    const displayName = `${data.vorname} ${data.nachname}`;

    const [newUser] = await db
      .insert(users)
      .values({
        email: data.email.toLowerCase(),
        passwordHash,
        displayName,
        vorname: data.vorname,
        nachname: data.nachname,
        telefon: data.telefon || null,
        strasse: data.strasse || null,
        hausnummer: data.hausnummer || null,
        plz: data.plz || null,
        stadt: data.stadt || null,
        geburtsdatum: data.geburtsdatum || null,
        eintrittsdatum: data.eintrittsdatum || null,
        vacationDaysPerYear: data.vacationDaysPerYear ?? 30,
        isAdmin: data.isAdmin ?? false,
        haustierAkzeptiert: data.haustierAkzeptiert ?? true,
        isEuRentner: data.isEuRentner ?? false,
        employmentType: data.employmentType ?? "sozialversicherungspflichtig",
        weeklyWorkDays: data.weeklyWorkDays ?? 5,
        monthlyWorkHours: data.monthlyWorkHours ?? null,
        isActive: true,
      })
      .returning();

    const roles = data.roles ?? [];
    if (roles.length > 0) {
      await db.insert(userRoles).values(
        roles.map((role) => ({
          userId: newUser.id,
          role,
        }))
      );
    }

    return { ...newUser, roles };
  }

  async login(
    email: string,
    password: string
  ): Promise<{ user: UserWithRoles; token: string } | null> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()));

    if (!user || !user.isActive) {
      return null;
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      return null;
    }

    const roles = await this.getUserRoles(user.id);

    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS);

    await db.insert(sessions).values({
      userId: user.id,
      tokenHash,
      expiresAt,
      lastActivityAt: now,
    });

    return {
      user: { ...user, roles },
      token,
    };
  }

  async logout(token: string): Promise<boolean> {
    const tokenHash = hashToken(token);
    sessionCache.invalidateByTokenHash(tokenHash);
    const result = await db
      .delete(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .returning();
    return result.length > 0;
  }

  async logoutAllSessions(userId: number): Promise<void> {
    sessionCache.invalidateByUserId(userId);
    await db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async validateSession(token: string, touch: boolean = true): Promise<UserWithRoles | null> {
    const tokenHash = hashToken(token);

    const now = new Date();

    const results = await db
      .select({
        session: sessions,
        user: users,
      })
      .from(sessions)
      .innerJoin(users, and(eq(sessions.userId, users.id), eq(users.isActive, true)))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          gt(sessions.expiresAt, now)
        )
      );

    if (results.length === 0) {
      sessionCache.invalidateByTokenHash(tokenHash);
      return null;
    }

    const { session, user } = results[0];

    const lastActivity = session.lastActivityAt?.getTime() ?? session.createdAt.getTime();
    if (now.getTime() - lastActivity > SESSION_IDLE_TIMEOUT_MS) {
      sessionCache.invalidateByTokenHash(tokenHash);
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
      return null;
    }

    if (touch) {
      db.update(sessions)
        .set({ lastActivityAt: now })
        .where(eq(sessions.id, session.id))
        .execute()
        .catch(() => {});
    }

    const cached = sessionCache.get(tokenHash);
    if (cached) {
      return cached;
    }

    const roleRows = await db
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, user.id));

    const roles = roleRows.map((r) => r.role as EmployeeRole);
    const userWithRoles = { ...user, roles };
    sessionCache.set(tokenHash, userWithRoles);
    return userWithRoles;
  }

  async getSessionInfo(token: string): Promise<{ idleExpiresAt: number; absoluteExpiresAt: number } | null> {
    const tokenHash = hashToken(token);
    const now = new Date();

    const results = await db
      .select({
        expiresAt: sessions.expiresAt,
        lastActivityAt: sessions.lastActivityAt,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          gt(sessions.expiresAt, now)
        )
      );

    if (results.length === 0) return null;

    const session = results[0];
    const lastActivity = session.lastActivityAt?.getTime() ?? session.createdAt.getTime();
    const idleExpiresAt = lastActivity + SESSION_IDLE_TIMEOUT_MS;
    const absoluteExpiresAt = session.expiresAt.getTime();

    return { idleExpiresAt, absoluteExpiresAt };
  }

  async touchSession(token: string): Promise<boolean> {
    const tokenHash = hashToken(token);
    const now = new Date();

    const result = await db
      .update(sessions)
      .set({ lastActivityAt: now })
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          gt(sessions.expiresAt, now)
        )
      )
      .returning({ id: sessions.id });

    if (result.length > 0) {
      sessionCache.invalidateByTokenHash(tokenHash);
    }
    return result.length > 0;
  }

  async getUserRoles(userId: number): Promise<EmployeeRole[]> {
    const roles = await db
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, userId));

    return roles.map((r) => r.role as EmployeeRole);
  }

  async setUserRoles(userId: number, roles: EmployeeRole[]): Promise<void> {
    await db.delete(userRoles).where(eq(userRoles.userId, userId));

    if (roles.length > 0) {
      await db.insert(userRoles).values(
        roles.map((role) => ({
          userId,
          role,
        }))
      );
    }
    sessionCache.invalidateByUserId(userId);
  }

  async getUser(id: number): Promise<UserWithRoles | null> {
    const [user] = await db.select().from(users).where(eq(users.id, id));

    if (!user) {
      return null;
    }

    const roles = await this.getUserRoles(user.id);
    return { ...user, roles };
  }

  async getUserByEmail(email: string): Promise<UserWithRoles | null> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()));

    if (!user) {
      return null;
    }

    const roles = await this.getUserRoles(user.id);
    return { ...user, roles };
  }

  async getAllUsers(): Promise<UserWithRoles[]> {
    return this.getUsersWithRoles();
  }

  async getActiveEmployees(): Promise<UserWithRoles[]> {
    return this.getUsersWithRoles(true);
  }

  private async getUsersWithRoles(activeOnly?: boolean): Promise<UserWithRoles[]> {
    const baseQuery = db
      .select({
        user: users,
        roleEntry: userRoles,
      })
      .from(users)
      .leftJoin(userRoles, eq(users.id, userRoles.userId));
    
    const results = activeOnly
      ? await baseQuery.where(and(eq(users.isActive, true), eq(users.isAnonymized, false)))
      : await baseQuery;

    const userMap = new Map<number, UserWithRoles>();
    for (const row of results) {
      if (!userMap.has(row.user.id)) {
        userMap.set(row.user.id, { ...row.user, roles: [] });
      }
      if (row.roleEntry?.role) {
        userMap.get(row.user.id)!.roles.push(row.roleEntry.role as EmployeeRole);
      }
    }
    return Array.from(userMap.values());
  }

  async updateUser(
    id: number,
    updates: {
      email?: string;
      vorname?: string;
      nachname?: string;
      telefon?: string;
      strasse?: string;
      hausnummer?: string;
      plz?: string;
      stadt?: string;
      geburtsdatum?: string;
      eintrittsdatum?: string;
      austrittsDatum?: string | null;
      vacationDaysPerYear?: number;
      isActive?: boolean;
      isAdmin?: boolean;
      haustierAkzeptiert?: boolean;
      isEuRentner?: boolean;
      employmentType?: string;
      weeklyWorkDays?: number;
      monthlyWorkHours?: number | null;
      employmentStatus?: string;
      lbnr?: string | null;
      personalnummer?: string | null;
      notfallkontaktName?: string;
      notfallkontaktTelefon?: string;
      notfallkontaktBeziehung?: string;
    }
  ): Promise<UserWithRoles | null> {
    if (updates.email) {
      updates.email = updates.email.toLowerCase();
      const existing = await db
        .select()
        .from(users)
        .where(and(eq(users.email, updates.email)));
      if (existing.length > 0 && existing[0].id !== id) {
        throw new Error("Diese E-Mail-Adresse wird bereits verwendet");
      }
    }

    const dbUpdates: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.email !== undefined) dbUpdates.email = updates.email;
    if (updates.vorname !== undefined) dbUpdates.vorname = updates.vorname;
    if (updates.nachname !== undefined) dbUpdates.nachname = updates.nachname;
    if (updates.telefon !== undefined) dbUpdates.telefon = updates.telefon || null;
    if (updates.strasse !== undefined) dbUpdates.strasse = updates.strasse || null;
    if (updates.hausnummer !== undefined) dbUpdates.hausnummer = updates.hausnummer || null;
    if (updates.plz !== undefined) dbUpdates.plz = updates.plz || null;
    if (updates.stadt !== undefined) dbUpdates.stadt = updates.stadt || null;
    if (updates.geburtsdatum !== undefined) dbUpdates.geburtsdatum = updates.geburtsdatum || null;
    if (updates.eintrittsdatum !== undefined) dbUpdates.eintrittsdatum = updates.eintrittsdatum || null;
    if (updates.vacationDaysPerYear !== undefined) dbUpdates.vacationDaysPerYear = updates.vacationDaysPerYear;
    if (updates.isActive !== undefined) dbUpdates.isActive = updates.isActive;
    if (updates.isAdmin !== undefined) dbUpdates.isAdmin = updates.isAdmin;
    if (updates.haustierAkzeptiert !== undefined) dbUpdates.haustierAkzeptiert = updates.haustierAkzeptiert;
    if (updates.austrittsDatum !== undefined) dbUpdates.austrittsDatum = updates.austrittsDatum || null;
    if (updates.isEuRentner !== undefined) dbUpdates.isEuRentner = updates.isEuRentner;
    if (updates.employmentType !== undefined) dbUpdates.employmentType = updates.employmentType;
    if (updates.weeklyWorkDays !== undefined) dbUpdates.weeklyWorkDays = updates.weeklyWorkDays;
    if (updates.monthlyWorkHours !== undefined) dbUpdates.monthlyWorkHours = updates.monthlyWorkHours;
    if (updates.employmentStatus !== undefined) dbUpdates.employmentStatus = updates.employmentStatus;
    if (updates.lbnr !== undefined) dbUpdates.lbnr = updates.lbnr || null;
    if (updates.personalnummer !== undefined) dbUpdates.personalnummer = updates.personalnummer || null;
    if (updates.notfallkontaktName !== undefined) dbUpdates.notfallkontaktName = updates.notfallkontaktName || null;
    if (updates.notfallkontaktTelefon !== undefined) dbUpdates.notfallkontaktTelefon = updates.notfallkontaktTelefon || null;
    if (updates.notfallkontaktBeziehung !== undefined) dbUpdates.notfallkontaktBeziehung = updates.notfallkontaktBeziehung || null;

    if (updates.vorname !== undefined || updates.nachname !== undefined) {
      const currentUser = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (currentUser.length > 0) {
        const newVorname = updates.vorname ?? currentUser[0].vorname ?? "";
        const newNachname = updates.nachname ?? currentUser[0].nachname ?? "";
        dbUpdates.displayName = `${newVorname} ${newNachname}`.trim();
      }
    }

    const [updatedUser] = await db
      .update(users)
      .set(dbUpdates)
      .where(eq(users.id, id))
      .returning();

    if (!updatedUser) {
      return null;
    }

    sessionCache.invalidateByUserId(id);
    const roles = await this.getUserRoles(id);
    return { ...updatedUser, roles };
  }

  async adminResetPassword(userId: number, newPassword: string): Promise<boolean> {
    const passwordHash = await hashPassword(newPassword);
    const result = await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (result.length > 0) {
      await this.logoutAllSessions(userId);
      return true;
    }
    return false;
  }

  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return { success: false, error: "Benutzer nicht gefunden" };

    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) return { success: false, error: "Aktuelles Passwort ist falsch" };

    const passwordHash = await hashPassword(newPassword);

    const result = await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();

    if (result.length > 0) {
      await this.logoutAllSessions(userId);
      return { success: true };
    }
    return { success: false, error: "Passwort konnte nicht geändert werden" };
  }

  async deactivateUser(id: number): Promise<boolean> {
    const now = new Date();
    const today = formatDateISO(now);
    
    const result = await db
      .update(users)
      .set({ isActive: false, deactivatedAt: now, updatedAt: now })
      .where(eq(users.id, id))
      .returning();

    if (result.length > 0) {
      await db.update(customerAssignmentHistory)
        .set({ validTo: today })
        .where(and(
          eq(customerAssignmentHistory.employeeId, id),
          isNull(customerAssignmentHistory.validTo)
        ));

      await this.logoutAllSessions(id);
      return true;
    }
    return false;
  }

  async activateUser(id: number): Promise<boolean> {
    const user = await this.getUser(id);
    if (user?.isAnonymized) {
      throw new Error("Anonymisierte Mitarbeiter können nicht reaktiviert werden");
    }
    const result = await db
      .update(users)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    return result.length > 0;
  }

  async deleteUser(id: number): Promise<boolean> {
    const result = await db
      .update(users)
      .set({ isActive: false, deactivatedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return result.length > 0;
  }

  async createPasswordResetToken(email: string): Promise<string | null> {
    const user = await this.getUserByEmail(email);
    if (!user) {
      return null;
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_DURATION_MS);

    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    return token;
  }

  async createWelcomeToken(userId: number): Promise<string> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + WELCOME_TOKEN_DURATION_MS);

    await db.insert(passwordResetTokens).values({
      userId,
      tokenHash,
      expiresAt,
    });

    return token;
  }

  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    const tokenHash = hashToken(token);

    const [resetToken] = await db
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          gt(passwordResetTokens.expiresAt, new Date())
        )
      );

    if (!resetToken || resetToken.usedAt) {
      return false;
    }

    const passwordHash = await hashPassword(newPassword);

    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, resetToken.userId));

    await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, resetToken.id));

    await this.logoutAllSessions(resetToken.userId);

    return true;
  }

  async hasAnyAdmin(): Promise<boolean> {
    const [admin] = await db
      .select()
      .from(users)
      .where(eq(users.isAdmin, true));
    return !!admin;
  }

  async cleanupExpiredSessions(): Promise<number> {
    const now = new Date();
    const idleThreshold = new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS);
    const result = await db
      .delete(sessions)
      .where(
        sql`${sessions.expiresAt} < ${now} OR ${sessions.lastActivityAt} < ${idleThreshold}`
      )
      .returning({ id: sessions.id });
    return result.length;
  }

  async cleanupExpiredResetTokens(): Promise<number> {
    const now = new Date();
    const result = await db
      .delete(passwordResetTokens)
      .where(lt(passwordResetTokens.expiresAt, now))
      .returning({ id: passwordResetTokens.id });
    return result.length;
  }
}

export const authService = new AuthService();
