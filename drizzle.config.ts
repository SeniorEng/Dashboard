import { defineConfig } from "drizzle-kit";
import { assertEphemeralDbForWrite } from "./scripts/lib/ephemeral-db-guard.ts";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// Fail-closed gegen versehentliche Pushes auf echte DBs. Die Allow-List ist die
// SSoT in `scripts/lib/ephemeral-db-guard.ts` (CI · Orchestrator · `cc_test_`-DB);
// die legitimen Nicht-Test-Ziele (`scripts/migrate.sh`, `npm run db:push`,
// `scripts/reseed-dev-db.sh`) erklären ihre Absicht über
// `ALLOW_NON_EPHEMERAL_DB_WRITE=1`.
// Der Guard läuft beim Config-Load, also VOR jedem Unterbefehl — er trifft
// damit auch `generate`/`check`/`up`/`studio`/`--dry-run`, nicht nur `push`.
assertEphemeralDbForWrite("drizzle-kit (Config-Load)");

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
