import { getTableColumns, type Table } from "drizzle-orm";
import { isSensitiveDbColumn } from "@shared/schema";
import { encryptSecret, decryptSecret, isEncryptionConfigured } from "./crypto";

const sensitivePropsCache = new WeakMap<Table, readonly string[]>();

export function getSensitivePropsForTable(table: Table): readonly string[] {
  const cached = sensitivePropsCache.get(table);
  if (cached) return cached;
  const cols = getTableColumns(table) as Record<string, { name: string }>;
  const props: string[] = [];
  for (const [prop, col] of Object.entries(cols)) {
    if (col && typeof col.name === "string" && isSensitiveDbColumn(col.name)) {
      props.push(prop);
    }
  }
  sensitivePropsCache.set(table, props);
  return props;
}

export function decryptRow<T extends Record<string, unknown>>(table: Table, row: T): T {
  if (!isEncryptionConfigured()) return row;
  const props = getSensitivePropsForTable(table);
  if (props.length === 0) return row;
  const result: Record<string, unknown> = { ...row };
  for (const p of props) {
    const v = result[p];
    if (typeof v === "string" && v) result[p] = decryptSecret(v);
  }
  return result as T;
}

export function encryptRow<T extends Record<string, unknown>>(table: Table, data: T): T {
  if (!isEncryptionConfigured()) return data;
  const props = getSensitivePropsForTable(table);
  if (props.length === 0) return data;
  const result: Record<string, unknown> = { ...data };
  for (const p of props) {
    if (p in result) {
      const v = result[p];
      if (typeof v === "string" && v) result[p] = encryptSecret(v);
    }
  }
  return result as T;
}
