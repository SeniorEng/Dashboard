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

import { eq, sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { users } from "@shared/schema";
import { freigabeErteilen } from "../../lib/prod-write-lock";
import { dbNameOf } from "@shared/ephemeral-db-target";

export interface ProdWriteArgs {
  apply: boolean;
  userId?: number;
  reason?: string;
  confirmTarget?: string;
  /**
   * `--target=prod|dev` — nur fuer Skripte, die legitim in BEIDEN Umgebungen
   * laufen (siehe `dual-target-gate.ts`). Die uebrigen ignorieren sie.
   */
  target?: string;
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
    target: get("--target="),
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
 * Liest den Datenbanknamen aus der TATSÄCHLICHEN Verbindung.
 *
 * Bewusst nicht aus dem URL-Pfad: die URL sagt, wohin verbunden werden SOLLTE,
 * `current_database()` sagt, wo man GELANDET ist. Bei Poolern und Aliassen ist
 * das nicht dasselbe — und genau diese Differenz ist der Fall, für den dieser
 * Zaun existiert.
 */
export async function currentDatabaseName(): Promise<string> {
  const res = await db.execute(sql`SELECT current_database() AS db`) as unknown;
  const rows = Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
  const erste = rows[0] as { db?: unknown } | undefined;
  return String(erste?.db ?? "");
}

/**
 * Fail-closed: wirft, wenn `--apply` gegen irgendetwas anderes als die
 * bestätigte Prod-Primary liefe.
 *
 *
 * ── Warum `--confirm-target` jetzt ZWEI Teile hat ───────────────────────
 * Die erste Fassung verglich nur den HOST aus der `DATABASE_URL`. Das hat in
 * der Praxis versagt: auf Replit heißt der interne Postgres-Host `helium` —
 * in der Dev-Umgebung genauso wie in Prod. Ein `--confirm-target=helium` ging
 * damit gegen BEIDE Datenbanken durch, und der Trockenlauf lief unbemerkt
 * gegen die falsche (`heliumdb` statt `neondb`): 0/0/633 statt 54/0/114.
 *
 * Der Host allein kann Prod also nicht identifizieren. Der DATENBANKNAME kann
 * es — und er wird an der offenen Verbindung erfragt, nicht aus der URL
 * geparst. Die alte einteilige Form wird ABGELEHNT statt still weiter
 * akzeptiert: sie ist genau der Weg, auf dem der Fehler passiert ist.
 *
 * ACHTUNG beim Umstellen bestehender Skripte: diese Funktion ist `async`. Die
 * handgeschriebenen Kopien in `cleanup-duplicate-monthly-proofs.ts` und
 * anderswo sind SYNCHRON. Wer nur den Import tauscht, bekommt eine Zeile, die
 * ohne `await` durchkompiliert — das Gate ist dann wirkungslos, und `eslint`
 * meldet es nicht (kein `no-floating-promises` in diesem Repo). Immer ueber
 * `assertProdWriteAllowedOrThrow` gehen, das den Aufruf mit `await` kapselt.
 */
export async function assertApplyTargetIsProdPrimaryOrThrow(confirmTarget: string | undefined): Promise<void> {
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
  // Klammern abstreifen: `new URL("postgres://…@[::1]/db").hostname` liefert
  // `"[::1]"` MIT eckigen Klammern. Ein Muster, das `::1` am Anfang erwartet,
  // greift dann nicht — und ausgerechnet der Loopback rutschte durch.
  const hostNackt = host.replace(/^\[|\]$/g, "");
  if (/^(localhost|127\.|::1|::ffff:127\.|0\.0\.0\.0)/.test(hostNackt)) {
    throw new Error(`ABBRUCH: DB-Host '${host}' ist lokal. --apply verweigert.`);
  }
  if (/replica|readonly|read-only|([.-]ro[.-])/.test(host)) {
    throw new Error(
      `ABBRUCH: DB-Host '${host}' sieht nach einer Read-Replica aus. ` +
      `--apply braucht die Prod-Primary (Replica nur für den Trockenlauf).`,
    );
  }
  const teile = (confirmTarget ?? "").toLowerCase().split("/");
  if (teile.length !== 2 || !teile[0] || !teile[1]) {
    throw new Error(
      `ABBRUCH: --apply erfordert --confirm-target=<host>/<datenbank>. ` +
      `Übergeben: '${confirmTarget ?? "(fehlt)"}'. ` +
      `Die einteilige Form (nur Host) wird nicht mehr akzeptiert — auf Replit heißt ` +
      `der Host in Dev und Prod gleich ('helium'), sie hat einen Lauf gegen die ` +
      `falsche Datenbank durchgelassen.`,
    );
  }
  const [zielHost, zielDb] = teile;

  if (zielHost !== host) {
    throw new Error(
      `ABBRUCH: Host stimmt nicht. DATABASE_URL zeigt auf '${host}', ` +
      `--confirm-target nennt '${zielHost}'.`,
    );
  }

  // Der eigentliche Diskriminator, an der offenen Verbindung erfragt.
  const istDb = (await currentDatabaseName()).toLowerCase();
  if (istDb !== zielDb) {
    throw new Error(
      `ABBRUCH: Verbunden mit Datenbank '${istDb}', bestätigt wurde '${zielDb}'. ` +
      `Der Lauf hätte die falsche Datenbank getroffen. ` +
      `(Prüfen: läuft die Shell mit der Deployment-DATABASE_URL oder mit einer eigenen?)`,
    );
  }

  // POSITIVE Prod-Identität — die eine Stelle, an der „ist das Prod?"
  // beantwortet wird.
  //
  // Vorher war das ein FORM-Test: „nicht cc_test_, nicht lokal, keine
  // Replica" ⇒ gilt als Prod-Primary. Gemessen stufte er damit auch
  // `helium/heliumdb` als Prod-Primary ein — die Replit-Wegwerf-Default-DB,
  // also ausgerechnet das Near-Miss-Ziel des Vorfalls. Ein Wegwerf-Ziel als
  // „Prod-Primary" durchzuwinken ist kein harmloser Etikettenfehler: es
  // reicht eine versehentliche Default-DB durch die volle Prod-Zeremonie.
  //
  // Prod ist ab hier, was `PROD_DATABASE_URL` sagt — Host UND Datenbankname,
  // letzterer aus der offenen Verbindung. Wegwerf bleibt `cc_test_`. Alles
  // dazwischen (die Default-DB, eine Dev-Kopie) ist WEDER und wird
  // fail-closed abgelehnt: es muss erst deklariert werden.
  const prodUrl = (process.env.PROD_DATABASE_URL || "").trim();
  if (!prodUrl) {
    throw new Error(
      `ABBRUCH: PROD_DATABASE_URL ist nicht gesetzt — ohne sie lässt sich nicht ` +
      `feststellen, OB '${host}/${istDb}' die Produktionsdatenbank ist.\n` +
      `Ein Ziel, das weder als Prod nachweisbar noch eine Wegwerf-DB (cc_test_) ` +
      `ist, wird nicht beschrieben.\n` +
      `Setze PROD_DATABASE_URL (siehe docs/pre-publish-backup-runbook.md, §2) ` +
      `oder benutze den Dev-Pfad (DEV_WRITE_CONFIRM_TARGET).`,
    );
  }
  const prodHost = (dbHostOf(prodUrl) || "").toLowerCase();
  const prodDb = (dbNameOf(prodUrl) || "").toLowerCase();
  if (!prodHost || !prodDb) {
    throw new Error(
      "ABBRUCH: PROD_DATABASE_URL ist nicht auswertbar (Host oder Datenbankname fehlt). Fail-closed.",
    );
  }
  if (host !== prodHost || istDb !== prodDb) {
    throw new Error(
      `ABBRUCH: '${host}/${istDb}' ist NICHT die Produktionsdatenbank ` +
      `(PROD_DATABASE_URL nennt '${prodHost}/${prodDb}').\n` +
      `Weder Prod noch Wegwerf-DB (cc_test_) — dieses Ziel muss erst deklariert ` +
      `werden. Für die Dev-DB: DEV_WRITE_CONFIRM_TARGET.\n` +
      `Hinweis: die Replit-Default-DB fällt genau hierunter. Sie galt dem ` +
      `früheren Form-Test als „Prod-Primary" und wurde durchgereicht.`,
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
  await assertApplyTargetIsProdPrimaryOrThrow(args.confirmTarget);
  const displayName = await assertSuperadminOrThrow(args.userId, zweck);
  // Erst JETZT — nach Ziel, Superadmin und Begruendung — faellt die
  // Laufzeit-Sperre. Sie sitzt am Treiber und deckt damit auch Schreibzugriffe
  // ueber Storage-Helfer und innerhalb von Transaktionen ab, die kein
  // statischer Waechter sehen kann.
  freigabeErteilen(args.confirmTarget ?? "(ohne Zielangabe)");
  return { userId: args.userId, displayName, reason: args.reason.trim() };
}
