/**
 * Task #1339 — Critical-SSoT-Boot-Gate.
 *
 * Hintergrund-Lehre aus dem Preis-Cutover (#1334): eine Daten-Migration im
 * `populate-prices`-Muster fand beim Publish ihre Quell-Tabellen nicht mehr vor
 * (der Schema-Diff hatte sie bereits gedroppt), lief als STILLER No-Op
 * (`changed=0`) und wurde im Ledger als „applied" verbucht — sie läuft nie
 * wieder. Ergebnis: die Ziel-SSoT `prices` blieb in Prod leer, alle
 * kundenspezifischen Preise fehlten live, OHNE dass der Boot fehlschlug.
 *
 * Dieses Gate ERSETZT das stille Hinnehmen dieser Konstellation: läuft EINMALIG
 * früh beim Boot (VOR dem Serving) und prüft für jede registrierte kritische
 * SSoT die gefährliche Kombination „Ziel leer + Quell-Tabellen weg + Leser
 * hängen davon ab". In PRODUKTION bricht es den Start hart ab
 * (`CriticalSsotDataLossError` → Prozess-Exit ≠ 0 → fehlschlagender Deploy →
 * alte Version bleibt online). In Dev/Test wird stattdessen LAUT gewarnt (die
 * Dev-DB läuft legitim mit leerer `prices`-Tabelle, würde sonst nie booten).
 *
 * Escape-Hatch: ein committeter, container-lesbarer Manifest-Eintrag
 * (`docs/db-backup-manifest.json`) mit verifiziertem Backup + passendem
 * Schema-Hash legitimiert den leeren Zustand bewusst (Operator hat ein Backup,
 * der Reset ist gewollt). `tmp/db-backups/` liegt NICHT im Deploy-Container,
 * deshalb der committete Manifest-Pfad statt einer Backup-Datei-Prüfung.
 *
 * Erweiterbar: weitere kritische Ziele einfach in `CRITICAL_SSOT_TARGETS`
 * registrieren.
 */
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

export class CriticalSsotDataLossError extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(
      `CRITICAL SSoT DATENVERLUST: ${failures.length} Ziel(e) leer, Quell-Tabellen ` +
        `fehlen und Leser hängen davon ab. Boot abgebrochen (Task #1339).\n` +
        failures.map((f) => `  - ${f}`).join("\n"),
    );
    this.name = "CriticalSsotDataLossError";
    this.failures = failures;
  }
}

export interface CriticalSsotTarget {
  /** Ziel-Tabelle (die SSoT, die nicht leer laufen darf). */
  readonly targetTable: string;
  /** Quell-Tabellen, aus denen die SSoT befüllt wird (Legacy/Alt-Tabellen). */
  readonly sourceTables: readonly string[];
  /** Menschlich lesbare Erklärung, was an dem Ziel hängt. */
  readonly description: string;
  /**
   * Zählt aktive Ziel-Zeilen. Default: `count(*)` der Tabelle. Für `prices`
   * werden nur nicht-soft-gelöschte Zeilen gezählt.
   */
  readonly countActiveTargetRows: () => Promise<number>;
  /**
   * Misst, ob Leser auf die SSoT angewiesen sind (Abhängigkeits-Sonde). > 0 ⇒
   * es gibt produktive Daten, die das leere Ziel brauchen würden.
   */
  readonly countDependents: () => Promise<number>;
}

async function scalarCount(query: ReturnType<typeof sql>): Promise<number> {
  const res = await db.execute(query);
  const rows = (res as unknown as { rows?: Array<{ n: number }> }).rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

export const CRITICAL_SSOT_TARGETS: readonly CriticalSsotTarget[] = [
  {
    targetTable: "prices",
    sourceTables: [
      "service_rates",
      "customer_contract_rates",
      "customer_service_prices",
    ],
    description:
      "Preis-SSoT (priceFor). Leer ⇒ Termin-Kostenberechnung & Rechnungen ohne Kundenpreise.",
    countActiveTargetRows: () =>
      scalarCount(sql`SELECT count(*)::int AS n FROM prices WHERE deleted_at IS NULL`),
    countDependents: () =>
      scalarCount(sql`SELECT count(*)::int AS n FROM appointment_services`),
  },
];

export interface ManifestEntry {
  target: string;
  backupId: string;
  schemaHash: string;
  timestamp: string;
  acknowledgedBy?: string;
}

export type GateAction = "pass" | "warn" | "fail";

export interface GateDecision {
  action: GateAction;
  reason: string;
}

/**
 * Reine Entscheidungslogik — DB-frei, unit-getestet. Bricht NUR in der
 * gefährlichen Kombination ab und nur in Produktion.
 */
export function evaluateCriticalSsotGate(input: {
  targetTable: string;
  targetRowCount: number;
  sourcesPresent: boolean;
  dependentCount: number;
  manifestEntry: ManifestEntry | undefined;
  currentSchemaHash: string;
  isProduction: boolean;
}): GateDecision {
  const {
    targetTable,
    targetRowCount,
    sourcesPresent,
    dependentCount,
    manifestEntry,
    currentSchemaHash,
    isProduction,
  } = input;

  if (targetRowCount > 0) {
    return { action: "pass", reason: `${targetTable}: ${targetRowCount} Zeile(n) vorhanden.` };
  }
  if (sourcesPresent) {
    return {
      action: "pass",
      reason: `${targetTable} leer, aber Quell-Tabellen vorhanden — Befüllung kann noch laufen.`,
    };
  }
  if (dependentCount === 0) {
    return {
      action: "pass",
      reason: `${targetTable} leer & Quellen weg, aber kein Leser hängt davon ab (0 Abhängige).`,
    };
  }
  // Gefährliche Kombination: Ziel leer + Quellen weg + Leser hängen davon ab.
  if (manifestEntry && manifestEntry.schemaHash === currentSchemaHash) {
    return {
      action: "pass",
      reason:
        `${targetTable} leer, aber per Manifest legitimiert (Backup ${manifestEntry.backupId}, ` +
        `Schema-Hash passt, ${manifestEntry.timestamp}).`,
    };
  }
  const detail =
    `${targetTable}: LEER, Quell-Tabellen fehlen, ${dependentCount} abhängige Zeile(n). ` +
    (manifestEntry
      ? `Manifest-Eintrag vorhanden, aber Schema-Hash veraltet (entwertet).`
      : `Kein gültiger Manifest-Eintrag.`);
  if (isProduction) {
    return { action: "fail", reason: detail };
  }
  return {
    action: "warn",
    reason: detail + " (Non-Prod ⇒ nur Warnung, kein Boot-Abbruch.)",
  };
}

async function tableExists(table: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
    LIMIT 1
  `);
  return ((res as { rows?: unknown[] }).rows?.length ?? 0) > 0;
}

/** Spalten-Hash des Ziels — eine spätere Schemaänderung entwertet das Manifest. */
async function computeTargetSchemaHash(table: string): Promise<string> {
  const res = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY column_name
  `);
  const rows = (res as unknown as { rows?: Array<{ column_name: string }> }).rows ?? [];
  const cols = rows.map((r) => r.column_name).join(",");
  return createHash("sha256").update(`${table}:${cols}`).digest("hex").slice(0, 16);
}

const MANIFEST_PATH = join("docs", "db-backup-manifest.json");

export async function loadBackupManifest(): Promise<ManifestEntry[]> {
  try {
    const raw = await readFile(MANIFEST_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { entries?: ManifestEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    log(`Backup-Manifest konnte nicht gelesen werden: ${err}`, "startup");
    return [];
  }
}

/**
 * Läuft das Gate über alle registrierten Ziele. Wirft `CriticalSsotDataLossError`
 * (⇒ Boot-Abbruch), sobald in Produktion mindestens ein Ziel die gefährliche
 * Kombination zeigt. In Dev/Test wird nur geloggt.
 */
export async function runCriticalSsotBootGate(): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  const manifest = await loadBackupManifest();
  const failures: string[] = [];

  for (const target of CRITICAL_SSOT_TARGETS) {
    const targetExists = await tableExists(target.targetTable);
    if (!targetExists) {
      // Ziel-Tabelle selbst fehlt ⇒ Schema noch nicht angelegt; nicht Sache
      // dieses Gates (Schema-Migrationen laufen ohnehin separat).
      continue;
    }
    const [targetRowCount, dependentCount] = await Promise.all([
      target.countActiveTargetRows(),
      target.countDependents(),
    ]);
    const sourcePresence = await Promise.all(
      target.sourceTables.map((t) => tableExists(t)),
    );
    const sourcesPresent = sourcePresence.some(Boolean);
    const currentSchemaHash = await computeTargetSchemaHash(target.targetTable);
    const manifestEntry = manifest.find((e) => e.target === target.targetTable);

    const decision = evaluateCriticalSsotGate({
      targetTable: target.targetTable,
      targetRowCount,
      sourcesPresent,
      dependentCount,
      manifestEntry,
      currentSchemaHash,
      isProduction,
    });

    if (decision.action === "fail") {
      failures.push(decision.reason);
    } else if (decision.action === "warn") {
      log(
        `⚠️  Critical-SSoT-Boot-Gate WARNUNG — ${decision.reason} ` +
          `Erwartete Quellen/Befüllung prüfen (Task #1339).`,
        "startup",
      );
    }
  }

  if (failures.length > 0) {
    throw new CriticalSsotDataLossError(failures);
  }
}
