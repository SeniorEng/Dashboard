// ---------------------------------------------------------------------------
// Boot-Guard: Der App-Server darf in NODE_ENV=test NUR gegen eine Wegwerf-/
// Ephemeral-DB hochfahren (Task #1429).
//
// Hintergrund: Die Workflow-Konfiguration `Start application` bootete den
// Dev-Preview-Server historisch mit `NODE_ENV=test` gegen die Dev-`DATABASE_URL`.
// Dadurch waren test-only-Routen (`/api/test`), der Mail-Stub und relaxte Rate-
// Limits aktiv und JEDER e2e-/API-Aufruf gegen diesen Server schrieb Test-Daten
// in die Dev-DB (heliumdb). Task #1427 hat den direkten `vitest run`-Pfad bereits
// abgesichert; dieser Guard schließt den verbleibenden Server-Boot-Pfad.
//
// Wiederverwendete SSoT: dieselbe Allow-List-Entscheidung wie der Vitest-Guard
// (`evaluateTestDbTarget` in `scripts/lib/ephemeral-db-guard.ts`). Es gibt genau
// EINE Antwort auf „ist das eine erlaubte Wegwerf-DB?".
//
// Wirkung: Nur in `NODE_ENV=test` aktiv. In `development` (Dev-Preview) und
// `production` ist der Guard ein No-Op — der Server bootet normal gegen die echte
// DB. Erlaubte Test-Boots (Orchestrator-Worker auf `cc_test_*`, e2e-Bundle, CI)
// passieren weiterhin.
// ---------------------------------------------------------------------------
import { evaluateTestDbTarget } from "../../scripts/lib/ephemeral-db-guard";

export function assertTestModeUsesEphemeralDb(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "test") return;

  const result = evaluateTestDbTarget(env);
  if (result.ok) return;

  const target = result.dbName ? `„${result.dbName}"` : "(DATABASE_URL nicht gesetzt)";
  throw new Error(
    [
      "",
      "==============================================================================",
      "  ABBRUCH: App-Server-Boot in NODE_ENV=test gegen NICHT-Wegwerf-DB (Task #1429).",
      "==============================================================================",
      `  Ziel-DB ${target} ist keine Ephemeral-/Wegwerf-DB.`,
      "",
      "  Im Test-Modus mountet der Server test-only-Routen, den Mail-Stub und",
      "  relaxte Rate-Limits — gegen die Dev-DB würde das sie mit Test-Daten fluten.",
      "",
      "  Der Dev-Preview-Server (`Start application`) MUSS mit NODE_ENV=development",
      "  booten. Test-Server laufen ausschließlich über den Orchestrator",
      "  (scripts/with-ephemeral-db.ts) gegen `cc_test_*`-Wegwerf-DBs.",
      "==============================================================================",
      "",
    ].join("\n"),
  );
}
