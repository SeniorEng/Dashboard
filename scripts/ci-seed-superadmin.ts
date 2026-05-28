/**
 * CI-Seed: legt einen Test-Superadmin in der frischen CI-Datenbank an.
 *
 * Hintergrund (Task #786):
 * Die CI-Gates `tests` und `e2e-smoke` loggen sich über `TEST_USER_EMAIL` /
 * `TEST_USER_PASSWORD` gegen den in CI gestarteten App-Server ein
 * (siehe `tests/globalSetup.ts`, `e2e/helpers/auth.ts`). In CI ist die
 * Postgres-Instanz aber frisch (`drizzle-kit push` legt nur das Schema an,
 * keine Daten). Die Superadmin-Promotion beim Server-Start (`SUPER_ADMIN_EMAIL`)
 * setzt nur ein Flag auf einer EXISTIERENDEN Zeile — sie legt den User nicht an.
 * Ohne diesen Seed schlägt das Login fehl und die Required-Checks würden auf
 * jedem Lauf rot laufen und damit jeden Merge (inkl. Renovate) blockieren.
 *
 * Dieser Seed läuft NACH `drizzle-kit push` und VOR dem Server-Start, ist
 * idempotent und no-op, wenn die Login-Secrets fehlen (z.B. in Forks) — dort
 * werden die Gates ohnehin sauber übersprungen.
 *
 * Aufruf:  npx tsx scripts/ci-seed-superadmin.ts
 */
import { eq } from "drizzle-orm";
import { db } from "../server/lib/db";
import { users } from "@shared/schema";
import { authService } from "../server/services/auth";

async function main(): Promise<void> {
  const email = process.env.TEST_USER_EMAIL;
  const password =
    process.env.TEST_USER_PASSWORD || process.env.TEST_USER_PASSWORD_INTERNAL;

  if (!email || !password) {
    console.log(
      "[ci-seed] TEST_USER_EMAIL/TEST_USER_PASSWORD nicht gesetzt — Seed übersprungen.",
    );
    return;
  }

  const normalized = email.toLowerCase();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized));

  if (existing.length === 0) {
    await authService.createUser({
      email: normalized,
      password,
      vorname: "CI",
      nachname: "Superadmin",
      isAdmin: true,
    });
    console.log(`[ci-seed] Test-User ${normalized} angelegt.`);
  } else {
    console.log(`[ci-seed] Test-User ${normalized} existiert bereits.`);
  }

  // Superadmin + aktiv erzwingen, damit alle Suiten (inkl. Monatsabschluss,
  // Audit-only-Operationen) durchlaufen — unabhängig von der Reihenfolge
  // gegenüber der Startup-Promotion.
  await db
    .update(users)
    .set({ isSuperAdmin: true, isActive: true })
    .where(eq(users.email, normalized));

  console.log("[ci-seed] Superadmin-Rechte + aktiv-Status sichergestellt.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[ci-seed] fehlgeschlagen:", err);
    process.exit(1);
  });
