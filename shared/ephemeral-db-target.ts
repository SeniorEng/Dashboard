/**
 * **Ist die Ziel-Datenbank eine Wegwerf-DB?** — reine Auswertung, EINE Quelle.
 *
 * Lag bis hierhin in `scripts/lib/ephemeral-db-guard.ts` und war damit nur für
 * Skripte und Tests erreichbar. Die Laufzeit-Schreibsperre
 * (`server/lib/prod-write-lock.ts`) braucht dieselbe Antwort — und `server/**`
 * darf nicht aus `scripts/**` importieren, sonst zöge der Server-Bundle
 * Test-Infrastruktur mit.
 *
 * ── Warum die Sperre das ueberhaupt fragt ───────────────────────────────
 * Es gibt ZWEI legitime Arten, wie ein Skript sein Ziel deklariert:
 *
 *   1. „Ich schreibe bewusst auf eine echte DB"  → `assertProdWriteAllowedOrThrow`
 *      (Host + `current_database()` + Superadmin + Begruendung)
 *   2. „Ich schreibe nur auf eine Wegwerf-DB"     → diese Auswertung
 *
 * Form 2 ist nicht die schwaechere: eine verifizierte `cc_test_`-DB kann per
 * Konstruktion keine Prod-Daten beschaedigen. Die CI-Seeds, der Schema-Migrator
 * und die Test-Cleanups gehoeren in diese Klasse — sie haben kein Prod-Gate,
 * weil sie nie auf Prod zeigen duerfen.
 *
 * Das ist keine nachtraegliche Ausnahme, sondern die zweite Haelfte derselben
 * Regel: **kein Schreibzugriff ohne geprueftes Ziel.**
 */

/** Praefix, den der Orchestrator seinen Wegwerf-DBs gibt. */
export const WEGWERF_DB_PRAEFIX = "cc_test_";

export type WegwerfZiel =
  | { ok: true; reason: string }
  | { ok: false; dbName: string | null };

export function dbNameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const pfad = new URL(url).pathname.replace(/^\//, "");
    return pfad.length > 0 ? pfad : null;
  } catch {
    return null;
  }
}

/**
 * Drei Wege, auf denen ein Ziel als wegwerfbar gilt.
 *
 * Rein (env wird uebergeben), damit sie ohne Prozess-Umbau testbar ist.
 */
export function evaluateTestDbTarget(env: NodeJS.ProcessEnv = process.env): WegwerfZiel {
  // 1) CI: der gesamte Postgres-Container ist wegwerfbar; die DB heisst dort
  //    statisch `careconnect`, nicht `cc_test_*`.
  //    Kehrseite, bewusst und dokumentiert (CLAUDE.md: „CI NICHT setzen"): wer
  //    lokal `CI=true` setzt, hebelt das aus. Derselbe Handel wie bisher.
  if (env.CI === "true") {
    return { ok: true, reason: "CI (wegwerfbarer Container)" };
  }

  // 2) Orchestrator: provisioniert pro Worker eine eigene `cc_test_*`-DB.
  if ((env.TEST_DATABASE_URLS || "").trim().length > 0) {
    return { ok: true, reason: "Orchestrator-Ephemeral-Worker-DBs" };
  }

  // 3) Sonst MUSS die effektive `DATABASE_URL` auf eine Wegwerf-DB zeigen.
  const dbName = dbNameOf(env.DATABASE_URL);
  if (dbName && dbName.startsWith(WEGWERF_DB_PRAEFIX)) {
    return { ok: true, reason: `Wegwerf-DB ${dbName}` };
  }

  return { ok: false, dbName };
}
