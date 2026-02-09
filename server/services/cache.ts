import type { BirthdayEntry } from "@shared/types";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class SimpleCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private defaultTtlMs: number;

  constructor(defaultTtlMs: number = 5 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.cache.set(key, { value, expiresAt });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  invalidateByPrefix(prefix: string): void {
    const keysToDelete: string[] = [];
    this.cache.forEach((_, key) => {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => this.cache.delete(key));
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

const CUSTOMER_IDS_TTL = 10 * 60 * 1000;

class CustomerIdsCacheService {
  private cache = new SimpleCache<number[]>(CUSTOMER_IDS_TTL);

  private getKey(employeeId: number): string {
    return `assigned_customers:${employeeId}`;
  }

  get(employeeId: number): number[] | undefined {
    return this.cache.get(this.getKey(employeeId));
  }

  set(employeeId: number, customerIds: number[]): void {
    this.cache.set(this.getKey(employeeId), customerIds);
  }

  invalidateForEmployee(employeeId: number): void {
    this.cache.delete(this.getKey(employeeId));
  }

  invalidateForCustomer(primaryEmployeeId?: number | null, backupEmployeeId?: number | null): void {
    if (primaryEmployeeId) {
      this.invalidateForEmployee(primaryEmployeeId);
    }
    if (backupEmployeeId) {
      this.invalidateForEmployee(backupEmployeeId);
    }
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}

export const customerIdsCache = new CustomerIdsCacheService();

// Cache for user/employee lists (5 minute TTL)
const USERS_CACHE_TTL = 5 * 60 * 1000;

interface SafeUser {
  id: number;
  email: string;
  displayName: string;
  vorname: string | null;
  nachname: string | null;
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
  stadt: string | null;
  geburtsdatum: string | null;
  isActive: boolean;
  isAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
  roles: string[];
  vacationDaysPerYear?: number | null;
}

class UsersCacheService {
  private allUsersCache = new SimpleCache<SafeUser[]>(USERS_CACHE_TTL);
  private activeEmployeesCache = new SimpleCache<SafeUser[]>(USERS_CACHE_TTL);

  getAllUsers(): SafeUser[] | undefined {
    return this.allUsersCache.get("all");
  }

  setAllUsers(users: SafeUser[]): void {
    this.allUsersCache.set("all", users);
  }

  getActiveEmployees(): SafeUser[] | undefined {
    return this.activeEmployeesCache.get("active");
  }

  setActiveEmployees(employees: SafeUser[]): void {
    this.activeEmployeesCache.set("active", employees);
  }

  invalidateAll(): void {
    this.allUsersCache.clear();
    this.activeEmployeesCache.clear();
  }
}

export const usersCache = new UsersCacheService();

// Cache for birthdays (1 hour TTL)
const BIRTHDAYS_CACHE_TTL = 60 * 60 * 1000;

class BirthdaysCacheService {
  private cache = new SimpleCache<BirthdayEntry[]>(BIRTHDAYS_CACHE_TTL);

  private getKey(userId: number, isAdmin: boolean, horizonDays: number): string {
    return `birthdays:${isAdmin ? 'admin' : userId}:${horizonDays}`;
  }

  get(userId: number, isAdmin: boolean, horizonDays: number): BirthdayEntry[] | undefined {
    return this.cache.get(this.getKey(userId, isAdmin, horizonDays));
  }

  set(userId: number, isAdmin: boolean, horizonDays: number, birthdays: BirthdayEntry[]): void {
    this.cache.set(this.getKey(userId, isAdmin, horizonDays), birthdays);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}

export const birthdaysCache = new BirthdaysCacheService();

const SESSION_CACHE_TTL = 2 * 60 * 1000;

interface CachedSession {
  user: import("@shared/schema").UserWithRoles;
  cachedAt: number;
}

class SessionCacheService {
  private cache = new Map<string, CachedSession>();

  get(tokenHash: string): import("@shared/schema").UserWithRoles | undefined {
    const entry = this.cache.get(tokenHash);
    if (!entry) return undefined;

    if (Date.now() - entry.cachedAt > SESSION_CACHE_TTL) {
      this.cache.delete(tokenHash);
      return undefined;
    }

    return entry.user;
  }

  set(tokenHash: string, user: import("@shared/schema").UserWithRoles): void {
    this.cache.set(tokenHash, { user, cachedAt: Date.now() });
  }

  invalidateByTokenHash(tokenHash: string): void {
    this.cache.delete(tokenHash);
  }

  invalidateByUserId(userId: number): void {
    const keysToDelete: string[] = [];
    this.cache.forEach((entry, key) => {
      if (entry.user.id === userId) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => this.cache.delete(key));
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}

export const sessionCache = new SessionCacheService();
