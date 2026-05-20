import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;
// Pipeline TLS+auth in fewer round-trips — measurably reduces Neon cold-start
// latency on the initial WebSocket handshake (without this, the first query
// after a cold start regularly hits >5s).
neonConfig.useSecureWebSocket = true;
neonConfig.pipelineConnect = "password";
neonConfig.pipelineTLS = true;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL ist nicht gesetzt. Bitte die Umgebungsvariable konfigurieren.");
}

// Task #536 — Neon-Pool für realistische Parallelität (E2E-Tests + Browser +
// Scheduler) dimensioniert. `connectionTimeoutMillis` hochgesetzt, damit ein
// Neon-Compute-Wake (Cold Start) den ersten Acquire nicht killt; folgende
// Requests benutzen die warme WebSocket-Verbindung. `idleTimeoutMillis` bewusst
// hoch (5 min), damit wir warme Sockets nicht wegwerfen und in jedem Request
// neu aufbauen müssen.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 300_000,
  connectionTimeoutMillis: 15_000,
  keepAlive: true,
});

pool.on("error", (err) => {
  // Idle-Pool-Fehler dürfen den Prozess NICHT killen — der nächste Acquire
  // baut die Verbindung ohnehin neu auf. Wir loggen sie nur sichtbar, damit
  // ein Connection-Storm nicht im Rauschen verschwindet.
  console.warn("[db] Idle client error (non-fatal):", err.message);
});

export function logPoolStats(tag = "db") {
  console.log(
    `[${tag}] pool stats — total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`,
  );
}

console.log(
  `[db] pool configured — max=20 idleTimeout=300s connectTimeout=15s keepAlive=on`,
);

export const db = drizzle(pool);

export type DbOrTx = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;

// Strikt: nur das Transaktions-Argument aus db.transaction(async (tx) => ...).
// Wer pg_advisory_xact_lock o.ä. nutzt, MUSS diesen Typ erzwingen — sonst würde
// der Lock am Statement-Ende freigegeben und der nachfolgende MAX/Insert wäre
// race-anfällig.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Task #536 — Retry-Wrapper für transiente Neon-Connect-Fehler.
 *
 * NUR für idempotente Read-Pfade einsetzen. Schreib-Transaktionen mit
 * Lock-Semantik (z.B. `getNextInvoiceNumberTx`, `pg_advisory_xact_lock`)
 * dürfen NICHT automatisch retryed werden — ein zweiter Versuch nach einem
 * Connection-Drop würde den Lock auf einer neuen Verbindung neu beantragen
 * und damit die Serialisierungs-Garantie kaputtmachen.
 */
const TRANSIENT_PATTERNS = [
  /timeout exceeded when trying to connect/i,
  /Connection terminated unexpectedly/i,
  /terminating connection due to/i,
  /Client has encountered a connection error/i,
  /ECONNRESET/i,
  /WebSocket .* (closed|terminated)/i,
];

function isTransientDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return TRANSIENT_PATTERNS.some((re) => re.test(msg) || (cause && re.test(cause)));
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !isTransientDbError(err)) throw err;
      const delayMs = 100 * Math.pow(2, i - 1);
      console.warn(
        `[db] transient error on attempt ${i}/${attempts}${opts.label ? ` (${opts.label})` : ""}; retrying in ${delayMs}ms:`,
        err instanceof Error ? err.message : String(err),
      );
      // Bei Retry-Warnungen Pool-Snapshot mitloggen, damit erkennbar ist, ob
      // wir am Acquire warten (waitingCount > 0) oder ob Neon den Connect
      // gedroppt hat (totalCount unverändert, kein Wait).
      logPoolStats("db");
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
