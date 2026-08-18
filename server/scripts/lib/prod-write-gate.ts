/**
 * Ziel- und Berechtigungs-Zaun für schreibende Einmal-Skripte auf Produktion.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Die handgeschriebene Kopie desselben Zauns in jedem Prod-Skript. Er stand
 * bisher zweimal wortgleich im Repo (`cleanup-duplicate-monthly-proofs.ts`,
 * `reconcile-km-drift.ts`); das Status-Migrations-Skript hatte ihn gar nicht.
 * Eine dritte Abschrift wäre derselbe Zweitbegriff gewesen, gegen den der
 * Status-Umbau selbst gerichtet ist.
 *
 * ── Wogegen der Zaun steht ──────────────────────────────────────────────
 * Ein `--apply` in einer Shell mit geerbter `DATABASE_URL`. Die Dev-DB ist
 * laut CLAUDE.md eine PROD-KOPIE mit echten Provider-Tokens — ein Skript, das
 * sie wortlos migriert, ist kein harmloser Fehlgriff.
 *
 * Er ist ausdrücklich KEIN Ersatz für den Wegwerf-DB-Guard
 * (`scripts/lib/ephemeral-db-guard.ts`): der hängt an `drizzle.config.ts` und
 * den beiden Seeds und greift für Skripte über `server/lib/db` gar nicht. Die
 * drei Marker-Setzer von `ALLOW_NON_EPHEMERAL_DB_WRITE` bleiben unverändert;
 * dieses Modul setzt den Marker NICHT und ist kein vierter Weg.
 *
 * Trockenläufe sind vom Zaun ausgenommen — sie dürfen (und sollen) auch gegen
 * eine Replica laufen, um den Blast-Radius zu bestimmen.
 */

import { eq } from "drizzle-orm";
import { db } from "../../lib/db";
import { users } from "@shared/schema";

export interface ProdWriteArgs {
  apply: boolean;
  userId?: number;
  reason?: string;
  confirmTarget?: string;
}

/** Liest die gemeinsamen Flags aus `process.argv`. */
export function parseProdWriteArgs(argv: string[] = process.argv): ProdWriteArgs {
  const get = (praefix: string): string | undefined => {
    const treffer = argv.find(a => a.startsWith(praefix));
    return treffer ? treffer.slice(praefix.length) : undefined;
  };
  const userArg = get("--user=");
  const userId = userArg ? Number.parseInt(userArg, 10) : undefined;
  return {
    apply: argv.includes("--apply"),
    // `Number.isFinite` faengt `--user=abc` ab: `parseInt` liefert dort `NaN`,
    // und ein `NaN` als `audit_log.user_id` kippt erst spaeter an der
    // Fremdschluessel-Bedingung — mitten in der Transaktion.
    userId: userId !== undefined && Number.isFinite(userId) ? userId : undefined,
    reason: get("--reason="),
    confirmTarget: get("--confirm-target="),
  };
}

/** Host-Teil einer Postgres-URL, klein geschrieben. `null`, wenn unlesbar. */
export function dbHostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Fail-closed: wirft, wenn `--apply` gegen irgendetwas anderes als die
 * bestätigte Prod-Primary liefe.
 */
export function assertApplyTargetIsProdPrimaryOrThrow(confirmTarget: string | undefined): void {
  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      `ABBRUCH: --apply erfordert NODE_ENV=production (aktuell: ${process.env.NODE_ENV ?? "(unset)"}).`,
    );
  }
  if ((process.env.TEST_DATABASE_URLS || "").trim().length > 0) {
    throw new Error("ABBRUCH: TEST_DATABASE_URLS gesetzt → Ephemeral-Test-Umgebung. --apply verweigert.");
  }
  const url = process.env.DATABASE_URL || "";
  const host = dbHostOf(url);
  if (!host) {
    throw new Error("ABBRUCH: DATABASE_URL-Host nicht ermittelbar (fail-closed). --apply verweigert.");
  }
  if (/cc_test_/.test(url)) {
    throw new Error("ABBRUCH: DATABASE_URL zeigt auf eine Wegwerf-/Test-DB (cc_test_). --apply verweigert.");
  }
  if (/^(localhost|127\.|::1|0\.0\.0\.0)/.test(host)) {
    throw new Error(`ABBRUCH: DB-Host '${host}' ist lokal. --apply verweigert.`);
  }
  if (/replica|readonly|read-only|([.-]ro[.-])/.test(host)) {
    throw new Error(
      `ABBRUCH: DB-Host '${host}' sieht nach einer Read-Replica aus. ` +
      `--apply braucht die Prod-Primary (Replica nur für den Trockenlauf).`,
    );
  }
  if (!confirmTarget || confirmTarget.toLowerCase() !== host) {
    throw new Error(
      `ABBRUCH: --apply erfordert --confirm-target=<host>, exakt passend zum ` +
      `DATABASE_URL-Host. Erwartet: '${host}'. Übergeben: '${confirmTarget ?? "(fehlt)"}'.`,
    );
  }
}

/** Wirft, wenn der angegebene Verantwortliche nicht existiert, inaktiv oder kein Superadmin ist. */
export async function assertSuperadminOrThrow(userId: number, zweck: string): Promise<string> {
  const [row] = await db
    .select({
      id: users.id,
      isSuperAdmin: users.isSuperAdmin,
      isActive: users.isActive,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht.`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv.`);
  if (!row.isSuperAdmin) {
    throw new Error(`--user=${userId} (${row.displayName}) ist kein Superadmin. ${zweck}`);
  }
  return row.displayName;
}

/** Mindestlänge der Begründung, die im Audit-Log landet. */
export const REASON_MIN_LAENGE = 10;

/**
 * Vollständiges Gate für einen Scharflauf. Gibt den Anzeigenamen des
 * Verantwortlichen zurück, damit das Skript ihn protokollieren kann.
 */
export async function assertProdWriteAllowedOrThrow(
  args: ProdWriteArgs,
  zweck: string,
): Promise<{ userId: number; displayName: string; reason: string }> {
  if (args.userId === undefined) {
    throw new Error("ABBRUCH: --apply erfordert --user=<superadmin-id> für die Audit-Attribution.");
  }
  if (!args.reason || args.reason.trim().length < REASON_MIN_LAENGE) {
    throw new Error(
      `ABBRUCH: --apply erfordert --reason="…" (mindestens ${REASON_MIN_LAENGE} Zeichen, landet im Audit-Log).`,
    );
  }
  assertApplyTargetIsProdPrimaryOrThrow(args.confirmTarget);
  const displayName = await assertSuperadminOrThrow(args.userId, zweck);
  return { userId: args.userId, displayName, reason: args.reason.trim() };
}
