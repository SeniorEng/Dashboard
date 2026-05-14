import { text } from "drizzle-orm/pg-core";

const sensitiveDbColumns = new Set<string>();

export function encryptedText(name: string) {
  sensitiveDbColumns.add(name);
  return text(name);
}

export function isSensitiveDbColumn(name: string): boolean {
  return sensitiveDbColumns.has(name);
}

export function getSensitiveDbColumns(): readonly string[] {
  return Array.from(sensitiveDbColumns);
}
