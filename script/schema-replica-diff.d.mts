/**
 * Typen für `schema-replica-diff.mjs`.
 *
 * Nötig, seit `scripts/**` und `script/**` im tsc-Scope liegen: ohne
 * Deklaration ist der Import implizit `any`, und `noImplicitAny` schlägt an.
 * Das ist kein Formalismus — `scripts/release-schema-gate.ts` importiert die
 * Ack-Helfer hier als SSoT; ohne Typen wäre eine Formänderung an `Drop` auf der
 * Aufruferseite unsichtbar geblieben.
 */

/** Eine destruktive Einzeländerung. `column` fehlt ⇒ die ganze Tabelle. */
export interface Drop {
  table: string;
  column?: string;
}

export interface DestructiveSchemaDiff {
  droppedTables: string[];
  droppedColumns: { table: string; column: string }[];
}

/** Schema-Momentaufnahme: Tabellenname → Spaltennamen. */
export type SchemaSnapshot = Record<string, string[]>;

export const STARTUP_MIGRATION_REFERENCED_TABLES: string[];

/** Stabiler Schlüssel: `column:<tabelle>.<spalte>` bzw. `table:<tabelle>`. */
export function dropKey(drop: Drop): string;

/** Menschlich lesbar: `DROP COLUMN x.y` bzw. `DROP TABLE x`. */
export function describeDrop(drop: Drop): string;

export function computeDestructiveSchemaDiff(
  targetSnapshot: SchemaSnapshot,
  prodSnapshot: SchemaSnapshot,
): DestructiveSchemaDiff;

export function flattenDestructiveDiff(diff: DestructiveSchemaDiff): Drop[];

export function checkExpandMigrateContract(
  drops: Drop[],
  referencedTables?: string[],
): { violations: Drop[] };

export function partitionAcknowledgedDrops(
  drops: readonly Drop[],
  ackList: readonly string[],
): { acknowledged: Drop[]; unacknowledged: Drop[] };

/** `PUBLISH_ACK_DROPS` (Komma-/Whitespace-separiert) → Drop-Keys. */
export function parseAckList(raw: string | undefined | null): string[];

export function resolveSchemaSnapshotSsl(
  connectionString: string,
): false | { rejectUnauthorized: boolean };

export function fetchSchemaSnapshot(connectionString: string): Promise<SchemaSnapshot>;

export function detectDestructiveSchemaDiffAgainstProd(options?: {
  targetUrl?: string;
  prodUrl?: string;
}): Promise<
  | { available: false; reason: string }
  | { available: true; drops: Drop[]; diff: DestructiveSchemaDiff }
>;
