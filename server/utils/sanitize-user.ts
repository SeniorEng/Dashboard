import type { User, SafeUser } from "@shared/schema";

export function sanitizeUser<T extends { passwordHash?: string | null }>(user: T): Omit<T, "passwordHash"> {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}
