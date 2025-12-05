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
