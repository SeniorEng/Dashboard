/**
 * Typen für `check-pre-publish-backup.mjs`.
 *
 * Nötig, seit `script/**` im tsc-Scope liegt (`script/build.ts` importiert das
 * Modul dynamisch). Beachte den Zuschnitt: dieser Check liest DATEIEN in
 * `migrations/` und ist bei `drizzle-kit push` per Konstruktion blind — der
 * technische Riegel gegen einen destruktiven Push sitzt in
 * `scripts/release-schema-gate.ts`.
 */
export interface RecentBackup {
  name: string;
  path: string;
  ageMs: number;
}

export type PrePublishBackupStatus = "no-destructive-change" | "ok" | "missing-backup";

export interface PrePublishBackupResult {
  status: PrePublishBackupStatus;
  latestMigration: string | null;
  destructive: string[];
  recentBackup: RecentBackup | null;
}

export function findLatestMigration(): Promise<string | null>;
export function migrationDestructiveStatements(filename: string | null): Promise<string[]>;
export function findRecentBackup(now?: number): Promise<RecentBackup | null>;
export function checkPrePublishBackup(options?: { now?: number }): Promise<PrePublishBackupResult>;
export function printPrePublishBackupResult(
  result: PrePublishBackupResult,
  options?: { quietWhenOk?: boolean },
): void;
