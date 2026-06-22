// Task #541: Memory-Watchdog gegen Workspace-Überlastung.
//
// Der Replit-Workspace hat begrenzten Arbeitsspeicher. Läuft der Server-Prozess
// in einen RSS-Anstieg (Leak, zu viele parallele PDF-Renderings, etc.), kommt es
// zu OOM-Kills und Preview-Disconnects. Dieser Watchdog sampelt periodisch den
// Speicherverbrauch des aktuellen Prozesses und loggt eine laute WARN-Zeile,
// sobald RSS eine konfigurierbare Schwelle überschreitet — damit der Operator
// die Eskalation in den Logs sieht, bevor der Kernel den Prozess killt.

const BYTES_PER_MB = 1024 * 1024;

export interface ProcessMemorySnapshot {
  rssMB: number;
  heapMB: number;
  heapTotalMB: number;
  externalMB: number;
  uptimeSec: number;
}

function roundMB(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

/**
 * Aktueller Speicher-Snapshot des laufenden Node-Prozesses. Wird sowohl vom
 * Watchdog-Interval als auch vom /api/health-Endpoint gelesen (eine Quelle).
 */
export function getProcessMemorySnapshot(): ProcessMemorySnapshot {
  const mem = process.memoryUsage();
  return {
    rssMB: roundMB(mem.rss),
    heapMB: roundMB(mem.heapUsed),
    heapTotalMB: roundMB(mem.heapTotal),
    externalMB: roundMB(mem.external),
    uptimeSec: Math.round(process.uptime()),
  };
}

/**
 * RSS-Schwelle (MB), ab der der Watchdog warnt. Override per Env
 * `MEMORY_WATCHDOG_WARN_MB`; Default 1024 MB.
 */
function warnThresholdMB(): number {
  const raw = process.env.MEMORY_WATCHDOG_WARN_MB;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1024;
}

/**
 * Sample-Intervall (ms). Override per Env `MEMORY_WATCHDOG_INTERVAL_MS`;
 * Default 60s.
 */
function intervalMs(): number {
  const raw = process.env.MEMORY_WATCHDOG_INTERVAL_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 60_000;
}

type LogFn = (message: string, source?: string) => void;

/**
 * Startet den periodischen Memory-Watchdog und gibt das Interval-Handle zurück,
 * damit der Aufrufer es in seine `intervals`-Liste für den Graceful-Shutdown
 * aufnehmen kann. Das Interval ist `unref()`'d, blockiert also den
 * Prozess-Exit nicht.
 */
export function startMemoryWatchdog(log: LogFn): NodeJS.Timeout {
  const threshold = warnThresholdMB();
  let warnedAt = 0;
  const sample = () => {
    const snap = getProcessMemorySnapshot();
    if (snap.rssMB >= threshold) {
      // Nur alle 5 Minuten warnen, um Log-Spam beim Dauer-Überschreiten zu
      // vermeiden.
      const now = Date.now();
      if (now - warnedAt >= 5 * 60 * 1000) {
        warnedAt = now;
        log(
          `WARN Memory-Watchdog: RSS ${snap.rssMB} MB überschreitet Schwelle ` +
            `${threshold} MB (heapUsed ${snap.heapMB} MB, uptime ${snap.uptimeSec}s). ` +
            `Mögliche Überlastung — schwere Workflows nicht parallel laufen lassen.`,
          "memory-watchdog",
        );
      }
    }
  };
  const handle = setInterval(sample, intervalMs());
  handle.unref();
  return handle;
}
