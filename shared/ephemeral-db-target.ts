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

/**
 * IPv4 nach inet_aton-Regeln in eine 32-Bit-Zahl — oder `null`.
 *
 * ERSETZT das Praefix-Muster `/^(localhost|127\.|…)/` als Loopback-Erkennung.
 * Ein Muster auf der Schreibweise prueft die falsche Sache: `getaddrinfo`
 * loest `0177.0.0.1` (oktal) und `2130706433` (dezimal) genauso auf 127.0.0.1
 * auf, beide passierten den alten Screen. Gemessen im Gate-2-Review von #121.
 *
 * inet_aton erlaubt 1–4 Teile; der letzte fuellt die restlichen Bytes auf
 * (`127.1` == 127.0.0.1). Dezimal, oktal (fuehrende 0) und hex (0x) je Teil.
 */
function alsIpv4Zahl(host: string): number | null {
  const teile = host.split(".");
  if (teile.length === 0 || teile.length > 4) return null;
  const zahlen: number[] = [];
  for (const t of teile) {
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(t)) n = parseInt(t.slice(2), 16);
    else if (/^0[0-7]+$/.test(t)) n = parseInt(t.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(t)) n = parseInt(t, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0) return null;
    zahlen.push(n);
  }
  const letzter = zahlen.pop() as number;
  // Die fuehrenden Teile sind je ein Byte, der letzte fuellt den Rest auf.
  const restBytes = 4 - zahlen.length;
  if (zahlen.some((z) => z > 255)) return null;
  if (letzter >= 2 ** (8 * restBytes)) return null;
  let wert = letzter;
  for (let i = 0; i < zahlen.length; i++) {
    wert += zahlen[i] * 2 ** (8 * (4 - 1 - i));
  }
  return wert >>> 0;
}

/**
 * Zeigt dieser Host auf die lokale Maschine?
 *
 * Deckt (gemessen, nicht vermutet): `localhost` und `*.localhost` (RFC 6761),
 * jede 127.0.0.0/8-Adresse in ALLEN inet_aton-Schreibweisen, `0.0.0.0` und
 * dessen Zahlform, IPv6-Loopback in jeder Schreibweise (`::1`,
 * `0:0:0:0:0:0:0:1`), IPv4-mapped (`::ffff:127.0.0.1` und die von WHATWG
 * normalisierte Hex-Form `::ffff:7f00:1`), `::` (unspecified) sowie jede
 * dieser Formen mit Trailing Dot.
 *
 * ERWARTET einen Host OHNE Port. `dbHostOf` liefert nie einen, aber
 * `new URL(...).host` (mit `.host` statt `.hostname`) schon — ein solcher Wert
 * landet hier still im IPv6-Zweig und kommt als `false` zurueck. Wer eine
 * andere Quelle anzapft, streift den Port vorher ab.
 */
export function istLoopback(host: string): boolean {
  // Trailing Dot abstreifen: `localhost.` ist derselbe FQDN, `getaddrinfo`
  // loest ihn genauso auf. `postgres` ist kein "special scheme", WHATWG
  // normalisiert den Punkt also NICHT weg — `localhost.`, `127.0.0.1.` und
  // `2130706433.` kamen dadurch an allen Formen vorbei (Gate-2 zu #122).
  const h = host
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/%.*$/, "")
    .replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // `::` ist das IPv6-Pendant zu `0.0.0.0` (unspecified) und wird von
  // server/index.ts als Bind-Adresse benutzt. Ohne diese Zeile war das
  // Praedikat asymmetrisch: `0.0.0.0` lokal, `::` nicht.
  if (h === "::") return true;

  const v4 = alsIpv4Zahl(h);
  if (v4 !== null) return v4 >>> 24 === 127 || v4 === 0;

  if (!h.includes(":")) return false;
  // IPv6: auf die Gruppen normalisieren, `::` einmal expandieren.
  const [links, rechts] = h.split("::", 2);
  const teile =
    rechts === undefined
      ? h.split(":")
      : (() => {
          const l = links ? links.split(":") : [];
          const r = rechts ? rechts.split(":") : [];
          const fehlend = 8 - l.length - r.length;
          if (fehlend < 0) return null;
          return [...l, ...Array(fehlend).fill("0"), ...r];
        })();
  if (!teile || teile.length !== 8) return false;

  // IPv4-mapped: die letzten 32 Bit als Adresse lesen.
  const letzte = teile[7];
  if (letzte.includes(".")) {
    const eingebettet = alsIpv4Zahl(letzte);
    const rest = teile.slice(0, 6).every((t) => parseInt(t || "0", 16) === 0);
    if (eingebettet !== null && rest && parseInt(teile[6] || "0", 16) === 0xffff) {
      return eingebettet >>> 24 === 127;
    }
  }
  const gruppen = teile.map((t) => parseInt(t || "0", 16));
  if (gruppen.some((g) => Number.isNaN(g))) return false;
  if (gruppen.slice(0, 7).every((g) => g === 0) && gruppen[7] === 1) return true;
  // ::ffff:7f00:1 — die von WHATWG normalisierte IPv4-mapped-Form.
  if (
    gruppen.slice(0, 5).every((g) => g === 0) &&
    gruppen[5] === 0xffff &&
    gruppen[6] >>> 8 === 127
  ) {
    return true;
  }
  return false;
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
