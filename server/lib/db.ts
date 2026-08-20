import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import ws from "ws";
import { mitSchreibsperre } from "./prod-write-lock";

// Replit-Exit — schaltbarer DB-Treiber (additiv, Strangler-Prinzip):
//   DB_DRIVER=neon (Default) → @neondatabase/serverless via WebSocket
//                              (Replit/Neon; heutiger Pfad, unverändert)
//   DB_DRIVER=pg             → node-postgres via plain TCP
//                              (Hetzner/Coolify: Standard-Postgres 16)
const DB_DRIVER = (process.env.DB_DRIVER ?? "neon").trim().toLowerCase();
if (DB_DRIVER !== "neon" && DB_DRIVER !== "pg") {
  throw new Error(`DB_DRIVER muss "neon" oder "pg" sein (ist: "${DB_DRIVER}").`);
}

if (DB_DRIVER === "neon") {
  neonConfig.webSocketConstructor = ws;

  // CI/Local-only: gegen eine plain Postgres-Instanz hinter einem
  // Neon-WebSocket-Proxy (z.B. ghcr.io/timowilhelm/local-neon-http-proxy) testen.
  // Der Neon-Serverless-Treiber spricht sonst ausschließlich Secure-WebSocket/TLS
  // und kann sich nicht mit einem nackten `postgres:16`-Service-Container
  // verbinden (ECONNREFUSED). Ist `NEON_LOCAL_WS_PROXY` gesetzt (z.B.
  // `localhost:4444`), schalten wir Secure-WS/TLS-Pipelining AB und routen den
  // WebSocket über den Proxy. Der Produktivpfad (echter Neon-Host) bleibt
  // unverändert, solange die Variable NICHT gesetzt ist.
  const localWsProxy = process.env.NEON_LOCAL_WS_PROXY?.trim();
  if (localWsProxy) {
    neonConfig.wsProxy = () => `${localWsProxy}/v2`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineConnect = false;
    neonConfig.pipelineTLS = false;
    console.log(`[db] NEON_LOCAL_WS_PROXY gesetzt — WebSocket über Proxy ${localWsProxy} (kein TLS).`);
  } else {
    // Pipeline TLS+auth in fewer round-trips — measurably reduces Neon cold-start
    // latency on the initial WebSocket handshake (without this, the first query
    // after a cold start regularly hits >5s).
    neonConfig.useSecureWebSocket = true;
    neonConfig.pipelineConnect = "password";
    neonConfig.pipelineTLS = true;
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL ist nicht gesetzt. Bitte die Umgebungsvariable konfigurieren.");
}

// Task #536 — Neon-Pool für realistische Parallelität (E2E-Tests + Browser +
// Scheduler) dimensioniert. `connectionTimeoutMillis` hochgesetzt, damit ein
// Neon-Compute-Wake (Cold Start) den ersten Acquire nicht killt; folgende
// Requests benutzen die warme WebSocket-Verbindung.
//
// Task #1807 — Neon-Kosten-Abwägung (compute-hours):
// Neon bricht die berechneten Compute-Stunden erst ab, wenn der Compute-
// Endpoint autosuspendet — und das passiert nur, solange KEINE offenen Client-
// Verbindungen mehr anliegen. Ein hoher `idleTimeoutMillis` (früher 5 min) hielt
// leere Pool-Sockets künstlich offen und verhinderte damit das Scale-to-Zero in
// ruhigen Phasen (nachts/Wochenende), obwohl das Nutzungsprofil überwiegend
// Bürozeiten ist. Wir setzen den Default darum bewusst niedrig (60s), damit
// ungenutzte Sockets zügig schließen und Neon in Leerlaufphasen suspendieren kann.
// Die Cold-Start-Mitigationen bleiben vollständig erhalten: TLS/Auth-Pipelining
// (siehe oben) + großzügiges `connectionTimeoutMillis` (15s) fangen den nächsten
// Compute-Wake ab; `keepAlive` hält AKTIVE Sockets stabil (kein Idle-Effekt).
// Override per `NEON_POOL_IDLE_TIMEOUT_MS` (z.B. für Last-/E2E-Läufe, die viele
// warme Verbindungen halten wollen). Rationale/Runbook: docs/dev-database-runbook.md.
const idleTimeoutMillis = Number(process.env.NEON_POOL_IDLE_TIMEOUT_MS) || 60_000;
const poolOptions = {
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis,
  connectionTimeoutMillis: 15_000,
  keepAlive: true,
};
// pg.Pool und Neon-Pool teilen die node-postgres-Pool-API. Der Export bleibt auf
// dem Neon-Typ, damit alle bestehenden Aufrufer (inkl. PoolClient-Typ-Annotationen,
// z.B. server/index.ts Advisory-Lock) unverändert kompilieren — zur Laufzeit steckt
// je nach DB_DRIVER die passende Implementierung dahinter.
export const pool: NeonPool =
  DB_DRIVER === "pg"
    ? (new pg.Pool(poolOptions) as unknown as NeonPool)
    : new NeonPool(poolOptions);

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
  `[db] driver=${DB_DRIVER} pool configured — max=20 idleTimeout=${Math.round(idleTimeoutMillis / 1000)}s connectTimeout=15s keepAlive=on`,
);

// Drizzle-Instanz passend zum Treiber. Beide Varianten sind PgDatabase-basiert und
// API-gleich; typisiert wird einheitlich auf den Neon-Typ, damit `Tx`/`DbOrTx`
// (SSoT unten) und alle Konsumenten eine einzige statische Sicht behalten.
const neonDb = () => drizzleNeon(pool);
type AppDb = ReturnType<typeof neonDb>;

const roheDb: AppDb =
  DB_DRIVER === "pg"
    ? (drizzlePg(pool as unknown as pg.Pool) as unknown as AppDb)
    : neonDb();

/**
 * Der EINE Schreibpfad der Anwendung — und damit die einzige Stelle, an der
 * sich „Skript schreibt ohne Ziel-Freigabe" ortsunabhaengig abfangen laesst.
 *
 * `mitSchreibsperre` ist im App- und Test-Kontext ein reiner Durchreicher
 * (siehe `ermittleKontext`); nur im Skript-Kontext verlangt es die Freigabe
 * aus `assertProdWriteAllowedOrThrow`. Die Huelle umfasst ausdruecklich das
 * `tx` aus `transaction(...)`: genau darueber schreiben die Storage-Helfer,
 * und ohne sie fielen die Indirektions-Faelle durch.
 */
export const db: AppDb = mitSchreibsperre(roheDb);

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
  /ECONNREFUSED/i,
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
