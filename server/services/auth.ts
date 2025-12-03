import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and, lt, gt } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  users,
  userRoles,
  sessions,
  passwordResetTokens,
  type User,
  type UserWithRoles,
  type EmployeeRole,
  EMPLOYEE_ROLES,
} from "@shared/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PASSWORD_RESET_DURATION_MS = 60 * 60 * 1000; // 1 hour

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256")
    .update(password + salt)
    .digest("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  const inputHash = createHash("sha256")
    .update(password + salt)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(inputHash));
  } catch {
    return false;
  }
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthService {
  async createUser(
    email: string,
    password: string,
    displayName: string,
    isAdmin: boolean = false,
    roles: EmployeeRole[] = []
  ): Promise<UserWithRoles> {
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()));

    if (existingUser.length > 0) {
      throw new Error("Ein Benutzer mit dieser E-Mail-Adresse existiert bereits");
    }

    const passwordHash = hashPassword(password);

    const [newUser] = await db
      .insert(users)
      .values({
        email: email.toLowerCase(),
        passwordHash,
        displayName,
        isAdmin,
        isActive: true,
      })
      .returning();

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

    if (!verifyPassword(password, user.passwordHash)) {
      return null;
    }

    const roles = await this.getUserRoles(user.id);

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    await db.insert(sessions).values({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    return {
      user: { ...user, roles },
      token,
    };
  }

  async logout(token: string): Promise<boolean> {
    const tokenHash = hashToken(token);
    const result = await db
      .delete(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .returning();
    return result.length > 0;
  }

  async logoutAllSessions(userId: number): Promise<void> {
    await db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async validateSession(token: string): Promise<UserWithRoles | null> {
    const tokenHash = hashToken(token);

    const [session] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          gt(sessions.expiresAt, new Date())
        )
      );

    if (!session) {
      return null;
    }

    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, session.userId), eq(users.isActive, true)));

    if (!user) {
      return null;
    }

    const roles = await this.getUserRoles(user.id);
    return { ...user, roles };
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
    const allUsers = await db.select().from(users);
    const allRoles = await db.select().from(userRoles);

    return allUsers.map((user) => ({
      ...user,
      roles: allRoles
        .filter((r) => r.userId === user.id)
        .map((r) => r.role as EmployeeRole),
    }));
  }

  async getActiveEmployees(): Promise<UserWithRoles[]> {
    const allUsers = await db
      .select()
      .from(users)
      .where(and(eq(users.isActive, true), eq(users.isAdmin, false)));
    const allRoles = await db.select().from(userRoles);

    return allUsers.map((user) => ({
      ...user,
      roles: allRoles
        .filter((r) => r.userId === user.id)
        .map((r) => r.role as EmployeeRole),
    }));
  }

  async updateUser(
    id: number,
    updates: {
      displayName?: string;
      email?: string;
      isActive?: boolean;
      isAdmin?: boolean;
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

    const [updatedUser] = await db
      .update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    if (!updatedUser) {
      return null;
    }

    const roles = await this.getUserRoles(id);
    return { ...updatedUser, roles };
  }

  async changePassword(userId: number, newPassword: string): Promise<boolean> {
    const passwordHash = hashPassword(newPassword);

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

  async deactivateUser(id: number): Promise<boolean> {
    const result = await db
      .update(users)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    if (result.length > 0) {
      await this.logoutAllSessions(id);
      return true;
    }
    return false;
  }

  async activateUser(id: number): Promise<boolean> {
    const result = await db
      .update(users)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    return result.length > 0;
  }

  async deleteUser(id: number): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id)).returning();
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

    const passwordHash = hashPassword(newPassword);

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
    const expired = await db
      .select()
      .from(sessions)
      .where(lt(sessions.expiresAt, now));
    
    if (expired.length === 0) return 0;
    
    for (const session of expired) {
      await db.delete(sessions).where(eq(sessions.id, session.id));
    }
    return expired.length;
  }

  async cleanupExpiredResetTokens(): Promise<number> {
    const now = new Date();
    const expired = await db
      .select()
      .from(passwordResetTokens)
      .where(lt(passwordResetTokens.expiresAt, now));
    
    if (expired.length === 0) return 0;
    
    for (const token of expired) {
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, token.id));
    }
    return expired.length;
  }
}

export const authService = new AuthService();
