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

/**
 * Sind die beiden Parser sich uneinig, WO der Host steht?
 *
 * ── Warum das KEIN Parser-Angleich-Problem ist ──────────────────────────
 * Gemessen an `postgres://admin:s@cret@dbhost/db` (unkodiertes `@` im
 * Passwort) lesen die beiden Konsumenten dieses Repos VERSCHIEDENE Hosts:
 *
 *   psql / pg_dump (libpq)         -> "cret@dbhost"   (erstes `@`)
 *   node-postgres / Neon (WHATWG)  -> "dbhost"        (letztes `@`)
 *
 * Beide Guards spiegelten damit ihren jeweiligen Konsumenten KORREKT — die
 * Shell-Seite libpq, die TS-Seite den Treiber. Angleichen waere deshalb
 * falsch: es wuerde einen der beiden Guards von seinem eigenen Konsumenten
 * loesen. Und `scripts/migrate.sh` faehrt beide Wege im selben Ablauf.
 *
 * Der Punkt ist also nicht, dass eine Seite irrt, sondern dass so eine URL
 * ZWEI Datenbanken bedeutet, je nachdem wer sie liest. Ein Guard, der sie
 * aufloest, gibt eine Antwort, die fuer den anderen Weg nachweislich falsch
 * ist. Deshalb loest sie hier keiner mehr auf.
 *
 * ── ERSETZT die erste Fassung („mehr als ein `@` vor dem Pfad") ──────────
 * Die zaehlte `@` innerhalb der WHATWG-Autoritaet — und schnitt damit an
 * `?`/`#` ab. libpq tut das NICHT: dort beendet nur `/` die Autoritaet.
 * Gemessen (Gate-2 zu #122):
 *
 *   postgres://u:p?x@dbhost.invalid/db
 *     libpq  -> "dbhost.invalid"      (userinfo laeuft ueber das `?` hinweg)
 *     WHATWG -> "u"                   (Autoritaet endet am `?`, kein `@` mehr)
 *
 * Beide Guards lasen dort den BENUTZERNAMEN als Host — und `careconnect` als
 * Host sieht nach nichts Verdaechtigem aus, passiert also alle vier
 * Bash-Guards, waehrend `psql` gegen den echten Prod-Host faehrt. Genau die
 * Klasse, die geschlossen sein sollte, mit `?` statt `@` als Trennzeichen.
 *
 * Eine zweite Syntaxregel danebenzustellen haette dieselbe Wette nur
 * wiederholt. Geprueft wird deshalb die Frage selbst: beide Regeln bestimmen
 * den Host-BEREICH, und nur wenn sie zeichengleich denselben meinen, wird
 * ueberhaupt weitergelesen.
 *
 * Verglichen wird der rohe Ausschnitt, NICHT der geparste Host — sonst
 * schluege die bekannte WHATWG-Normalisierung (`[0:0:0:0:0:0:0:1]` -> `[::1]`)
 * faelschlich als Uneinigkeit an und wuerde legitime IPv6-URLs verweigern.
 *
 * RFC 3986 deckt beides: `@`, `?` und `#` gehoeren in der userinfo kodiert.
 * Kodierte Passwoerter (`p%40w`, `p%3Fx`) passieren unveraendert.
 */
function hostBereichUneinig(url: string): boolean {
  const nachSchema = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([\s\S]*)$/);
  if (!nachSchema) return false;
  const rest = nachSchema[1];

  // libpq: nur `/` beendet die Autoritaet, die userinfo endet am ERSTEN `@`.
  const bisSlash = rest.split("/")[0];
  const libpq = bisSlash.includes("@") ? bisSlash.slice(bisSlash.indexOf("@") + 1) : bisSlash;

  // WHATWG: `/`, `?` und `#` beenden sie, die userinfo endet am LETZTEN `@`.
  const bisTrenner = rest.split(/[/?#]/)[0];
  const whatwg = bisTrenner.includes("@")
    ? bisTrenner.slice(bisTrenner.lastIndexOf("@") + 1)
    : bisTrenner;

  return libpq !== whatwg;
}

/**
 * Host-Teil einer Connection-URL, klein geschrieben. `null`, wenn keiner
 * ermittelbar ist — die Aufrufer behandeln das als fail-closed.
 *
 * ── Warum es diese eine Fassung gibt ────────────────────────────────────
 * Bis hierhin existierten ZWEI, mit verschiedenen Verträgen:
 *   `server/lib/dev-db-guard.ts`      → `string`, "" wenn nichts
 *   `server/scripts/lib/prod-write-gate.ts` → `string | null`, ohne Fallback
 *
 * Das ist dieselbe Divergenz-Klasse, die diese ganze Welle bekämpft: zwei
 * Antworten auf eine Frage driften auseinander, und die schwächere fällt
 * fail-open. Genau so ist die Bash-Namensextraktion gekippt (PR #118).
 *
 * Vereinheitlicht auf den strengeren Vertrag `string | null`: wer `string`
 * erwartete, muss `null` jetzt behandeln — sonst versteckt sich dort der
 * nächste Fehler.
 *
 * ── Der Fallback bleibt, und zwar bewusst ───────────────────────────────
 * `new URL()` wirft bei malformten Hosts. Gemessen feuert der Fallback dort
 * tatsächlich und liefert z.B. `ho st`, `[bad`, `h|ost`. Das ist kein
 * Versehen: die Shell-Lib (`scripts/lib/assert-dev-db.sh`, `db_host_of`)
 * benutzt dieselbe Regex, und die Cross-Language-Parität verlangt dasselbe
 * Ergebnis. Ein malformter Scheme-Prefix (`postgres ://…`) darf auf BEIDEN
 * Seiten KEINEN Host liefern.
 *
 * Für die Aufrufer bleibt es fail-closed: ein Mülls-Host besteht die
 * anschliessenden Vergleiche (`--confirm-target`, `current_database()`,
 * `PROD_DATABASE_URL`) nicht.
 */
export function dbHostOf(url: string | undefined): string | null {
  if (!url) return null;
  if (hostBereichUneinig(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    // Nur mit GUELTIGEM Schema (`scheme://`) — zeichengleich zu `db_host_of`
    // in scripts/lib/assert-dev-db.sh, BEIDE Alternativen in derselben
    // Reihenfolge:
    //
    //   1. geklammerte IPv6 (`[...]`) ZUERST — `[^:/?#]+` stoppt sonst am
    //      ersten `:` und liefert nur `[`.
    //   2. sonst das gewoehnliche Host-Muster.
    //
    // Die erste Alternative kam im Gate-2-Review von PR #121 dazu, nachdem
    // sie zunaechst NUR auf der Bash-Seite eingebaut war. Genau daran haette
    // die Konsolidierung fail-open gedreht: `postgres://u:p@[::1]x/db` lieferte
    // hier `[`, nach dem Strippen der Klammern `""` — und der Loopback-Screen
    // in prod-write-gate.ts lief ins Leere. VOR der Konsolidierung war dieser
    // Pfad dort fallback-frei und starb bei "Host nicht ermittelbar".
    const geklammert = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@\/?#]*@)?(\[[^\]]*\])/);
    if (geklammert) return geklammert[1].toLowerCase();
    const m = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@\/?#]*@)?([^:\/?#]+)/);
    return m ? m[1].toLowerCase() : null;
  }
}

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
