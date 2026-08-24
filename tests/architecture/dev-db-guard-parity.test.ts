// ---------------------------------------------------------------------------
// Dev-DB Prod-Schutz: Cross-Language-Paritäts-Test (Task #1438)
//
// Die Prod-Schutz-Guards der zerstörerischen Dev-DB-Werkzeuge leben in ZWEI
// Sprachen parallel:
//   - TypeScript: `server/lib/dev-db-guard.ts` (`dbHostOf`, `PROD_HOST_PATTERN`,
//     `assertDevDatabase`), re-exportiert vom Sweep-Skript
//     `server/scripts/sweep-dev-test-data.ts` (npm `db:sweep-dev`).
//   - Bash:      `scripts/lib/assert-dev-db.sh` (`db_host_of`, `assert_dev_db`),
//     gesourcet von `scripts/backup-dev-db.sh` und `scripts/reseed-dev-db.sh`.
//
// Ein TS-Modul kann eine Shell-Funktion nicht sourcen (und umgekehrt), daher
// lässt sich die Logik nicht physisch teilen. Dieser Test ist die geteilte,
// SPRACHÜBERGREIFEND PRÜFBARE Quelle: er definiert die Regeln EINMAL als
// Fixtures-Tabelle und reicht JEDE Fixture durch BEIDE Implementierungen. Ein
// Auseinanderdriften (z.B. ein angepasstes Prod-Pattern nur in einer Welt) wird
// dadurch sofort sichtbar — die Paritäts-Assertion bricht.
//
// Abgedeckt:
//   1. Host-Extraktion (`dbHostOf` ⇔ `db_host_of`) — gleicher Host aus gleicher
//      Connection-URL (mit/ohne Credentials, lowercasing, leerer Host).
//   2. Voller Guard-Verdikt (`assertDevDatabase` ⇔ `assert_dev_db`) — Abbruch
//      vs. Pass für alle vier Schutz-Bedingungen.
//
// DB-frei und damit IMMER laufendes Gate (unit-Project): der TS-Import berührt
// `../lib/db` nicht, der Shell-Aufruf parst nur Strings (Fake-Hosts, kein
// echter DB-Connect).
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
// NUR `dbNameOf` — `dbHostOf` kommt unten aus `dev-db-guard` (Re-Export der
// SSoT). Beides zu importieren band denselben Namen zweimal: `tsc` sieht es
// nicht (tsconfig schliesst `**/*.test.ts` aus), esbuild eliminierte den
// unbenutzten Specifier — welche Bindung gewinnt, entschied damit der
// Bundler statt des Quelltexts. Gate-2-Review PR #121.
import { dbNameOf } from "@shared/ephemeral-db-target";
import path from "node:path";
import {
  dbHostOf,
  assertDevDatabase,
  DEV_WRITE_CONFIRM_ENV,
} from "../../server/lib/dev-db-guard";

const SHELL_LIB = path.resolve(process.cwd(), "scripts/lib/assert-dev-db.sh");

// --- Shell-Brücken: rufen die gesourcete Guard-Lib als Black-Box auf ---------

/** Ruft `db_host_of "$url"` aus der Shell-Lib auf und liefert den Host (trimmed). */
function shellDbHostOf(url: string): string {
  const res = spawnSync(
    "bash",
    ["-c", `source "$0"; db_host_of "$1"`, SHELL_LIB, url],
    { encoding: "utf8" },
  );
  return (res.stdout ?? "").trim();
}

/**
 * Ruft `assert_dev_db` aus der Shell-Lib mit einem KONTROLLIERTEN Env auf.
 * Liefert `true`, wenn ein Guard abgebrochen hat (Exit-Code != 0). `undefined`
 * in den Overrides löscht die Variable im Kind-Env (das geerbte process.env
 * würde sonst durchgereicht — inkl. einer evtl. echten DATABASE_URL).
 */
function shellAssertAborts(env: {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  PROD_DATABASE_URL?: string;
}): boolean {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["NODE_ENV", "DATABASE_URL", "PROD_DATABASE_URL"] as const) {
    const value = env[key];
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const res = spawnSync(
    "bash",
    ["-c", `source "$0"; assert_dev_db "parity-test"`, SHELL_LIB],
    { env: childEnv, encoding: "utf8" },
  );
  return res.status !== 0;
}

/** Ruft den TS-Guard mit gesetztem process.env auf und liefert, ob er wirft. */
function tsAssertAborts(env: {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  PROD_DATABASE_URL?: string;
}): boolean {
  for (const key of ["NODE_ENV", "DATABASE_URL", "PROD_DATABASE_URL"] as const) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    assertDevDatabase();
    return false;
  } catch {
    return true;
  }
}

// --- Geteilte Fixtures (die EINE sprachübergreifende Quelle) -----------------

// Connection-URLs für die Host-Extraktions-Parität. `.example` ist reserviert
// (RFC 6761) → kein echter DB-Zugriff möglich.
const HOST_URLS = [
  "postgresql://user:pass@db.dev.example:5432/app", // mit Credentials
  "postgresql://db.dev.example:5432/app", // OHNE Credentials
  "postgresql://user:pass@DB.PROD.Example:5432/app", // lowercasing
  "postgresql://user:pass@shared-host.example:5432/dev",
  "garbage-without-host", // kein extrahierbarer Host → ""
  "", // leer → ""
  "postgres ://user@db.dev.example:5432/app", // malformtes Schema (Leerzeichen) → "" (fail-closed)
  "user@db.dev.example:5432/app", // kein Schema, nur @host → "" (fail-closed)
  // Mehrdeutige Autoritaet: unkodiertes `@` im Passwort. BEIDE Seiten
  // verweigern (W3, siehe Block unten) — vorher lasen sie verschiedene Hosts.
  "postgresql://admin:s@cret@db.dev.example:5432/app",
  // Gegenprobe: `@` im Query-String ist NICHT Teil der Autoritaet und darf
  // die Verweigerung nicht ausloesen.
  "postgresql://user:pass@db.dev.example:5432/app?options=a@b",
  // Gegenprobe: korrekt als %40 kodiert → ganz normaler Host.
  "postgresql://admin:s%40cret@db.dev.example:5432/app",
] as const;

interface GuardFixture {
  name: string;
  NODE_ENV?: string;
  DATABASE_URL?: string;
  PROD_DATABASE_URL?: string;
  expectAbort: boolean;
}

const DEV_OK = "postgresql://user:pass@db.dev.example:5432/app";

/**
 * Mehrdeutige Autoritaet — der W3-Fall, gemessen statt vermutet.
 *
 * Gate-2 von PR #121 meldete die Divergenz als "bash irrt". Nachgemessen
 * gegen die tatsaechlichen Konsumenten stimmt das nicht — sie irrten beide
 * nicht, sie bedienten verschiedene Parser:
 *
 *   psql/pg_dump (libpq)          -> "cret@db.dev.example"   (erstes `@`)
 *   node-postgres/Neon (WHATWG)   -> "db.dev.example"        (letztes `@`)
 *
 * (libpq-Messung: `psql "postgres://admin:s@cret@dbhost.invalid/db"` meldet
 * `could not translate host name "cret@dbhost.invalid"`; die node-Seite ueber
 * `pg-connection-string`, den node-postgres benutzt.)
 *
 * Angleichen waere daher falsch gewesen — es haette einen der Guards von
 * seinem eigenen Konsumenten geloest. Die URL bedeutet schlicht ZWEI
 * Datenbanken, je nachdem wer sie liest, und `scripts/migrate.sh` faehrt
 * beide Wege im selben Ablauf. Also loest sie keiner mehr auf.
 */
const MEHRDEUTIG = "postgresql://admin:s@cret@db.dev.example:5432/app";

// Die vier Schutz-Bedingungen + Pass-Fälle. Erwartetes Verdikt ist hier nur die
// dritte Wächter-Instanz — entscheidend ist, dass TS UND Shell IDENTISCH urteilen.
const GUARD_FIXTURES: GuardFixture[] = [
  {
    name: "NODE_ENV=production bricht ab",
    NODE_ENV: "production",
    DATABASE_URL: DEV_OK,
    expectAbort: true,
  },
  {
    name: "Prod-aussehender Host (.prod.) bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@db.prod.example:5432/app",
    expectAbort: true,
  },
  {
    name: "'production'-Host bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@careconnect-production.example:5432/app",
    expectAbort: true,
  },
  {
    name: "prod-Präfix-Host bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@prod-db.example:5432/app",
    expectAbort: true,
  },
  {
    name: "fail-closed: nicht extrahierbarer Host bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "garbage-without-host",
    expectAbort: true,
  },
  {
    name: "fail-closed: leere DATABASE_URL bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "",
    expectAbort: true,
  },
  {
    name: "fail-closed: malformtes Schema (Leerzeichen) bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "postgres ://user@db.dev.example:5432/app",
    expectAbort: true,
  },
  {
    name: "fail-closed: kein Schema, nur @host bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "user@db.dev.example:5432/app",
    expectAbort: true,
  },
  {
    // Verschaerft: Host-Gleichheit allein genuegt nicht mehr, beide
    // Fixtures nennen deshalb dieselbe Datenbank.
    name: "DATABASE_URL == PROD_DATABASE_URL bricht ab (Host UND Datenbank)",
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@shared-host.example:5432/neondb",
    PROD_DATABASE_URL: "postgresql://other:secret@shared-host.example:5432/neondb",
    expectAbort: true,
  },
  {
    // Der W3-Fall: die URL loest fuer libpq und fuer den Treiber auf
    // VERSCHIEDENE Hosts auf. Kein Guard darf sie aufloesen — beide Seiten
    // muessen abbrechen, und zwar IDENTISCH.
    name: "mehrdeutige Autoritaet (unkodiertes @ im Passwort) bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: MEHRDEUTIG,
    expectAbort: true,
  },
  {
    // Gegenprobe: korrekt kodiert ist es ein voellig normaler Dev-Host. Die
    // Verweigerung darf legitime Passwoerter mit `@` nicht mittreffen.
    name: "korrekt kodiertes @ im Passwort (%40) passiert",
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://admin:s%40cret@db.dev.example:5432/app",
    expectAbort: false,
  },
  {
    name: "normaler Dev-Host passiert (PROD_DATABASE_URL auf anderem Host)",
    NODE_ENV: "development",
    DATABASE_URL: DEV_OK,
    PROD_DATABASE_URL: "postgresql://other:secret@db.prod.example:5432/app",
    expectAbort: false,
  },
  {
    name: "normaler Dev-Host passiert (ohne PROD_DATABASE_URL)",
    NODE_ENV: "development",
    DATABASE_URL: DEV_OK,
    expectAbort: false,
  },
  {
    name: "Staging-Host passiert (kein Prod-Pattern)",
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pass@staging-db.example:5432/app",
    expectAbort: false,
  },
];

// --- Tests -------------------------------------------------------------------

describe("Task #1438: Host-Extraktion TS ⇔ Shell (Parität)", () => {
  it.each(HOST_URLS)("liefert denselben Host für %j", (url) => {
    // Der Vertrag ist seit der Konsolidierung `string | null` statt `string`:
    // "kein Host ermittelbar" ist jetzt `null` und nicht mehr `""`. Die Shell
    // kann nur "" ausgeben, deshalb wird hier normalisiert — die AUSSAGE
    // (beide finden dasselbe bzw. beide finden nichts) bleibt dieselbe.
    expect(shellDbHostOf(url)).toBe(dbHostOf(url) ?? "");
  });
});

describe("Task #1438: Guard-Verdikt TS ⇔ Shell (Parität)", () => {
  // assertDevDatabase() liest process.env zur Aufrufzeit → pro Test setzen und
  // danach den Originalzustand wiederherstellen (der Shell-Aufruf bekommt sein
  // Env separat über childEnv und beeinflusst process.env nicht).
  let savedEnv: {
    NODE_ENV?: string;
    DATABASE_URL?: string;
    PROD_DATABASE_URL?: string;
  };

  beforeEach(() => {
    savedEnv = {
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_URL: process.env.DATABASE_URL,
      PROD_DATABASE_URL: process.env.PROD_DATABASE_URL,
    };
  });

  afterEach(() => {
    for (const key of ["NODE_ENV", "DATABASE_URL", "PROD_DATABASE_URL"] as const) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each(GUARD_FIXTURES)("$name", (fx) => {
    const env = {
      NODE_ENV: fx.NODE_ENV,
      DATABASE_URL: fx.DATABASE_URL,
      PROD_DATABASE_URL: fx.PROD_DATABASE_URL,
    };
    const tsAborts = tsAssertAborts(env);
    const shellAborts = shellAssertAborts(env);
    // 1. Beide Welten urteilen IDENTISCH (Drift-Schutz).
    expect(tsAborts).toBe(shellAborts);
    // 2. ...und das gemeinsame Verdikt entspricht der Erwartung.
    expect(tsAborts).toBe(fx.expectAbort);
  });
});

/**
 * Paritaet der POSITIVEN Ziel-Pruefung (PR #117).
 *
 * `assert_dev_db` / `assertDevDatabase` sind negative Praedikate — im Gate-2
 * gemessen bestehen `helium` (die Replit-Default-DB, NICHT Prod), die Neon-Prod-Form und
 * `localhost` sie glatt. Deshalb erteilen sie kein Schreibrecht mehr; das tut
 * die positive Pruefung, und die muss es auf BEIDEN Seiten geben — an der
 * Bash-Seite haengen die vier `psql`-Skripte (`reseed-dev-db.sh`,
 * `post-merge.sh`, die zwei Backup-Skripte), die den TS-Chokepoint nie sehen.
 */
describe("positive Dev-Ziel-Pruefung — TS ⇔ Bash", () => {
  const shell = readFileSync(SHELL_LIB, "utf8");

  it("beide Seiten kennen die Funktion und dieselbe Env", () => {
    expect(shell).toMatch(/assert_dev_write_target\(\)/);
    expect(shell).toContain("DEV_WRITE_CONFIRM_TARGET");
    expect(DEV_WRITE_CONFIRM_ENV).toBe("DEV_WRITE_CONFIRM_TARGET");
  });

  it("beide holen den DB-Namen aus der OFFENEN Verbindung, nicht aus der URL", () => {
    // Der Kern des 18.08.-Vorfalls: `helium` stimmte, `heliumdb` statt
    // `neondb` nicht. Wer den Namen aus der URL liest, sieht das nicht.
    expect(shell).toMatch(/current_database\(\)/);
    const ts = readFileSync(
      path.resolve(process.cwd(), "server/lib/dev-db-guard.ts"),
      "utf8",
    );
    expect(ts).toContain("currentDatabaseName()");
  });

  it("Bash bricht ohne benanntes Ziel ab", () => {
    const res = spawnSync(
      "bash",
      ["-c", `source "$0"; assert_dev_write_target "parity-test"`, SHELL_LIB],
      {
        env: {
          ...process.env,
          NODE_ENV: "development",
          DATABASE_URL: "postgres://u:p@dev-host/careconnect_dev",
          DEV_WRITE_CONFIRM_TARGET: "",
        },
        encoding: "utf8",
      },
    );
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/DEV_WRITE_CONFIRM_TARGET/);
  });

  it("Bash bricht auch bei helium ohne Ziel ab — der negative Screen laesst es durch", () => {
    const res = spawnSync(
      "bash",
      ["-c", `source "$0"; assert_dev_write_target "parity-test"`, SHELL_LIB],
      {
        env: {
          ...process.env,
          NODE_ENV: "development",
          DATABASE_URL: "postgres://u:p@helium/neondb",
          DEV_WRITE_CONFIRM_TARGET: "",
        },
        encoding: "utf8",
      },
    );
    expect(res.status).not.toBe(0);
  });
});

/**
 * `db_name_of` ⇔ `dbNameOf` — zeichenweise Parität der Datenbanknamen-Extraktion.
 *
 * Diese Tabelle fehlte, und genau deshalb blieb eine echte Divergenz grün: die
 * erste Bash-Fassung benutzte `sed 's#…#…#'` statt `sed -n … p`. Trifft das
 * Muster nicht, gibt `sed` die EINGABE unveraendert zurueck — der Rueckgabewert
 * war also die ganze URL, damit nicht-leer, damit griff der `[[ -z … ]]`-Zweig
 * der Aufrufer nicht. Fail-OPEN, wo `dbNameOf` fail-closed ist. An
 * `reseed-dev-db.sh` haengt hinter diesem Guard ein `DROP SCHEMA public CASCADE`.
 *
 * Die Faelle unten sind bewusst die haesslichen: kein Pfad, Grossschreibung,
 * Muell, Fragment, Query, leerer Pfad.
 */
describe("db_name_of ⇔ dbNameOf — Paritaet der Namens-Extraktion", () => {
  const FAELLE = [
    "postgres://u:p@helium/neondb",
    "postgres://u:p@helium",
    "postgres://u:p@helium/",
    "POSTGRES://u:p@helium/neondb",
    "garbage-without-host",
    "",
    "postgres://h/neondb#frag",
    "postgres://u:p@h:5432/db?sslmode=require",
    "postgresql://user:pa%2Fss@host:5432/careconnect_dev",
  ];

  it.each(FAELLE)("liefert dasselbe fuer %j", (url) => {
    const ts = (dbNameOf(url) ?? "").toLowerCase();
    const res = spawnSync("bash", ["-c", `source "$0"; db_name_of "$1"`, SHELL_LIB, url], {
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(ts);
  });
});

/**
 * `db_host_of` ⇔ `dbHostOf` — zeichenweise Parität der HOST-Extraktion.
 *
 * Das Gegenstück zur Namens-Tabelle aus PR #118. Dort blieb eine echte
 * Divergenz grün, weil niemand die beiden Implementierungen verglich; hier gab
 * es sogar ZWEI TS-Fassungen mit verschiedenen Verträgen
 * (`string` vs `string | null`). Beide sind jetzt eine, und diese Tabelle hält
 * sie mit der Shell zusammen.
 *
 * Die Fälle sind bewusst die hässlichen: malformter Scheme-Prefix, Passwort
 * mit Sonderzeichen, IPv6, Grossschreibung, Müll, leer.
 */
describe("db_host_of ⇔ dbHostOf — Paritaet der Host-Extraktion", () => {
  const FAELLE = [
    "postgres://u:p@helium:5432/neondb",
    "postgres://u:p@helium/neondb",
    "POSTGRES://U:P@Helium/DB",
    "postgres://u:p%2Fx@helium/neondb",
    "postgres://u:p@[::1]:5432/db",
    // Aus dem Gate-2-Review von PR #121: geklammerte Hosts, an denen
    // `new URL()` WIRFT — hier entscheidet auf beiden Seiten der Fallback,
    // und genau dort war die Klammer-Alternative zunaechst nur in bash.
    "postgres://u:p@[::1]x/db",
    "postgres://u:p@[::1]./db",
    "postgres://u:p@[fe80::1%25eth0]:5432/db",
    "postgres ://user@host/db",
    "garbage",
    "",
    "postgres://u:p@ho st/db",
  ];

  it.each(FAELLE)("liefert dasselbe fuer %j", (url) => {
    const ts = dbHostOf(url) ?? "";
    const res = spawnSync("bash", ["-c", `source "$0"; db_host_of "$1"`, SHELL_LIB, url], {
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(ts);
  });

  /**
   * BEKANNTE, bewusst akzeptierte Divergenz — hier festgenagelt statt
   * verschwiegen (Gate-2-Review PR #121).
   *
   * Fuer geklammerte IPv6-Adressen, die `new URL()` ANNIMMT, normalisiert
   * WHATWG die Adresse (Nullgruppen-Kompression, IPv4-mapped in Hex); `sed`
   * kann das nicht. Eine Regex holt das nicht ein, und die Gegenrichtung waere
   * SCHLECHTER: liesse TS die Normalisierung weg, wuerde
   * `[0:0:0:0:0:0:0:1]` den Loopback-Screen in prod-write-gate.ts nicht mehr
   * treffen. Die normalisierende Seite ist die strengere.
   *
   * Tragbar ist es, weil die Divergenz in BEIDE Richtungen fail-closed faellt:
   * die Host-Vergleiche verlangen Gleichheit, ein Auseinanderlaufen bricht ab —
   * es laesst nie beide Seiten faelschlich passieren. Dieser Test haelt genau
   * diese Zusage fest: sobald eine Seite still zur anderen kippt, wird er rot.
   */
  it.each([
    ["postgres://u:p@[0:0:0:0:0:0:0:1]/db", "[::1]", "[0:0:0:0:0:0:0:1]"],
    ["postgres://u:p@[::FFFF:127.0.0.1]:5432/db", "[::ffff:7f00:1]", "[::ffff:127.0.0.1]"],
  ])("%j divergiert bekannt — und faellt dabei fail-closed", (url, erwartetTs, erwartetBash) => {
    const ts = dbHostOf(url);
    const res = spawnSync("bash", ["-c", `source "$0"; db_host_of "$1"`, SHELL_LIB, url], {
      encoding: "utf8",
    });
    expect(ts).toBe(erwartetTs);
    expect(res.stdout).toBe(erwartetBash);

    // Der Punkt, auf den es ankommt: beide finden EINEN Host (kein fail-open
    // ueber einen leeren String), und sie sind ungleich — jeder
    // Gleichheits-Vergleich darueber bricht ab statt durchzulassen.
    expect(ts).not.toBe("");
    expect(res.stdout).not.toBe("");
    expect(ts).not.toBe(res.stdout);
  });

  it("ein malformter Scheme-Prefix liefert auf BEIDEN Seiten nichts", () => {
    // Der Fall, den der Fallback ausdruecklich NICHT durchlassen darf: eine
    // reine `@host`-Regex wuerde hier faelschlich `host` extrahieren und die
    // Guards passieren lassen, waehrend die Shell abbricht.
    expect(dbHostOf("postgres ://user@host/db")).toBeNull();
    const res = spawnSync(
      "bash",
      ["-c", `source "$0"; db_host_of "$1"`, SHELL_LIB, "postgres ://user@host/db"],
      { encoding: "utf8" },
    );
    expect(res.stdout).toBe("");
  });
});

/**
 * Destruktive Shell-Skripte muessen die POSITIVE Ziel-Pruefung rufen.
 *
 * ── Der Anlass ──────────────────────────────────────────────────────────
 * `assert_dev_write_target` existierte seit #118 als Spiegelbild zu
 * `assertDevWriteTargetOrThrow` — und hatte im Gate-2 zu #122 gemessen
 * KEINEN einzigen Aufrufer. Die positive Pruefung lag als tote Zeichenkette
 * herum, waehrend `reseed-dev-db.sh` sein `DROP SCHEMA public CASCADE` am
 * NEGATIVEN Screen (`assert_dev_db`) haengen hatte. Genau die Konstellation,
 * gegen die #118 angetreten war: "nicht Prod" ist auch fuer eine unbekannte
 * oder falsch konfigurierte DB wahr.
 *
 * Ein Test, der nur „die Funktion existiert" prueft, haette das nie gezeigt.
 * Dieser prueft die Kopplung: wer zerstoert, benennt sein Ziel.
 *
 * Kommentare werden entfernt, bevor gesucht wird — `backup-prod-db.sh`
 * ERWAEHNT `DROP TABLE` in seinem Kopfkommentar und ist trotzdem ein reines
 * Lese-Skript. Dieselbe Falle, die auf der TS-Seite schon zweimal eine Regel
 * wirkungslos gemacht hat.
 */
describe("destruktive Shell-Skripte deklarieren ihr Ziel positiv", () => {
  const DESTRUKTIV = /\b(DROP\s+SCHEMA|DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i;

  /** Shell-Kommentare raus (ohne Zeilen in Here-Docs zu zerstoeren). */
  function ohneKommentare(text: string): string {
    return text
      .split("\n")
      .map((z) => (/^\s*#/.test(z) ? "" : z))
      .join("\n");
  }

  it("jedes zerstoerende scripts/*.sh ruft assert_dev_write_target", () => {
    const verzeichnis = path.resolve(process.cwd(), "scripts");
    const dateien = readdirSync(verzeichnis).filter((d) => d.endsWith(".sh"));
    // Gegenprobe gegen einen leeren Glob: findet der Test gar nichts, waere er
    // trivial gruen. Beim Schreiben lagen 10 Skripte dort.
    expect(dateien.length).toBeGreaterThan(3);

    const ungegatet = dateien.filter((d) => {
      const text = ohneKommentare(readFileSync(path.join(verzeichnis, d), "utf8"));
      if (!DESTRUKTIV.test(text)) return false;
      return !/\bassert_dev_write_target\s+/.test(text);
    });
    expect(
      ungegatet,
      "Diese Skripte fuehren zerstoerendes SQL aus, benennen ihr Ziel aber nicht:\n  " +
        ungegatet.join("\n  ") +
        "\nRuf `assert_dev_write_target \"<name>\"` vor dem ersten destruktiven Schritt.",
    ).toEqual([]);
  });

  it("jedes schreibende scripts/*.sh hat mindestens den Ziel-Screen", () => {
    // Zweite Stufe, aus dem Gate-2 zu #123: `post-merge.sh` fuhr ein
    // `ALTER TABLE` per psql und ein `db:push` gegen die geerbte DATABASE_URL,
    // ohne JEDEN Ziel-Guard — und laeuft laut CLAUDE.md unbeaufsichtigt. Das
    // Destruktiv-Muster oben kannte weder `ALTER TABLE` noch `db:push`.
    //
    // Bewusst zwei Stufen: zerstoerend verlangt die POSITIVE Pruefung (oben),
    // schreibend verlangt mindestens den negativen Screen. Ein unbeaufsichtigter
    // Hook kann `DEV_WRITE_CONFIRM_TARGET` nicht setzen; ihm die positive
    // Pruefung aufzuzwingen hiesse, ihn dauerhaft zu deaktivieren.
    const SCHREIBEND = /\b(ALTER\s+TABLE|CREATE\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|db:push)\b/i;
    const verzeichnis = path.resolve(process.cwd(), "scripts");
    const ungegatet = readdirSync(verzeichnis)
      .filter((d) => d.endsWith(".sh"))
      .filter((d) => {
        const text = ohneKommentare(readFileSync(path.join(verzeichnis, d), "utf8"));
        if (!SCHREIBEND.test(text)) return false;
        return !/\bassert_dev_(db|write_target)\b/.test(text);
      });
    expect(
      ungegatet,
      "Diese Skripte schreiben in die DB, pruefen ihr Ziel aber nicht:\n  " +
        ungegatet.join("\n  ") +
        "\nMindestens `assert_dev_db` vor den Schreibschritten.",
    ).toEqual([]);
  });

  it("die Regel greift ueberhaupt — mindestens ein Skript ist destruktiv", () => {
    // Ohne diese Zeile waere die Regel oben auch dann gruen, wenn das
    // Destruktiv-Muster ins Leere liefe (Tippfehler, umbenanntes Skript).
    const verzeichnis = path.resolve(process.cwd(), "scripts");
    const destruktive = readdirSync(verzeichnis)
      .filter((d) => d.endsWith(".sh"))
      .filter((d) => DESTRUKTIV.test(ohneKommentare(readFileSync(path.join(verzeichnis, d), "utf8"))));
    expect(destruktive).toContain("reseed-dev-db.sh");
  });

  it("ein blosser Kommentar erfuellt die Destruktiv-Erkennung NICHT", () => {
    // backup-prod-db.sh nennt `DROP TABLE` im Kopfkommentar und ist ein reines
    // Lese-Skript. Ohne `ohneKommentare` haette die Regel es geflaggt.
    expect(DESTRUKTIV.test(ohneKommentare("#   DROP TABLE) auf die Production-DB"))).toBe(false);
    expect(DESTRUKTIV.test(ohneKommentare("DROP SCHEMA public CASCADE;"))).toBe(true);
  });
});

/**
 * Keine VIERTE Host-/Loopback-Fassung.
 *
 * ── Der Anlass ──────────────────────────────────────────────────────────
 * #121 hat zwei `dbHostOf` zusammengefuehrt, W3 sechs weitere — und der
 * Gate-2-Review zu #122 fand trotzdem noch drei lokale Eigenformen. Jedes Mal
 * dieselbe Sorte Fehler, jedes Mal erst durch einen Menschen gefunden. Der
 * Grund: es gab nie einen WAECHTER, nur Kommentare mit dem Wort "SSoT".
 *
 * Diese Regel ist der Waechter. Sie ERSETZT die Kommentar-Behauptung durch
 * etwas, das rot wird.
 *
 * Bewusst eng gefasst: geprueft wird auf die beiden Muster, mit denen die
 * gefundenen Eigenformen gebaut waren — Host aus einer DATABASE_URL/
 * Verbindungs-URL ziehen, und Loopback per Schreibweisen-Vergleich erkennen.
 * Eine Regel auf `new URL(` schlechthin waere unbrauchbar (das Repo parst
 * ueberall legitim URLs) und haette als erstes ihre eigene SSoT geflaggt.
 */
describe("keine zweite Antwort auf 'welcher Host?' / 'ist das lokal?'", () => {
  // NUR die SSoT selbst. Der frueher hier ebenfalls gelistete Eintrag fuer
  // DIESE Testdatei war tot: `quellen()` laeuft ueber server/scripts/shared,
  // `tests/**` kann also nie getroffen werden. Ein toter Eintrag suggeriert
  // eine Abdeckung, die es nicht gibt (Gate-2 zu #123).
  //
  // BEKANNTE GRENZE, hier benannt: ungeprueft bleiben `tests/`, `client/`,
  // `script/` (Singular) und das Repo-Root, sowie `.mjs`/`.js` generell.
  const SSOT_DATEIEN = new Set(["shared/ephemeral-db-target.ts"]);

  function quellen(): string[] {
    const wurzeln = ["server", "scripts", "shared"];
    const treffer: string[] = [];
    const lauf = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const voll = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === "dist") continue;
          lauf(voll);
        } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
          treffer.push(path.relative(process.cwd(), voll));
        }
      }
    };
    for (const w of wurzeln) lauf(path.resolve(process.cwd(), w));
    return treffer;
  }

  /**
   * Kommentare raus — sonst erfuellt eine blosse Erwaehnung die Regel.
   *
   * Die Zeichenklasse vor dem Doppel-Slash ist NICHT kosmetisch. Die naive
   * Fassung schnitt an JEDEM Doppel-Slash ab und fraß damit zwei haeufige
   * Nicht-Kommentare: einen escapten Slash in einem Regex-Literal, und den
   * Schema-Trenner in einer http-URL. In beiden Faellen verschwand der REST
   * DER ZEILE.
   *
   * Genau daran ist die Gegenprobe zu dieser Regel zuerst gruen geblieben:
   * in `reencrypt-company-secrets.resolveDbTarget` stehen der pathname-Zugriff
   * mit so einem Regex-Literal und `host: u.hostname` in DERSELBEN Zeile — der
   * Host-Zugriff wurde mitgeloescht, und die Regel sah nichts. (Gate-2 zu
   * #123.) Ausgenommen sind deshalb ein vorangehender Backslash und ein
   * vorangehender Doppelpunkt.
   */
  function entkommentiert(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^\\:])\/\/[^\n]*/gm, "$1 ");
  }

  it("niemand zieht den Host selbst aus DATABASE_URL", () => {
    const eigenbau = quellen().filter((rel) => {
      if (SSOT_DATEIEN.has(rel)) return false;
      const text = entkommentiert(readFileSync(path.resolve(process.cwd(), rel), "utf8"));
      // Die einzeilige Kette `new URL(x).hostname` war NICHT die haeufigste
      // Bauform — zwei der drei in W4 entfernten Eigenformen waren anders
      // gebaut, und die erste Fassung dieser Regel fing sie nicht (Gate-2 zu
      // #123). Deshalb zwei Lockerungen:
      //
      //   1. KEIN `DATABASE_URL`-Vorfilter mehr. Er schloss
      //      `deactivate-selbstzahler-45b.ts` aus, das nur `TEST_BASE_URL`
      //      kennt — und dessen Host-Frage genau dieselbe ist.
      //   2. Die Bindung darf ueber Zeilen laufen: `const u = new URL(x);`
      //      gefolgt von `u.hostname` irgendwo danach. Das war die Form von
      //      `reencrypt-company-secrets.resolveDbTarget` und ist die
      //      naheliegendste ueberhaupt.
      if (/new URL\([\s\S]*?\)\s*\.\s*host(?:name)?\b/.test(text)) return true;
      if (/\.match\(\s*\/\^?\.*@\(\[\^/.test(text)) return true;
      // Zweizeilig: an einen Bezeichner gebunden, dann `.host`/`.hostname`.
      //
      // ABER: wer vom selben Bezeichner auch `.protocol`/`.search` liest,
      // ZERLEGT eine URL fuer einen Request und beantwortet keine Host-Frage — `server/services/letterxpress-http.ts` baut so seine
      // https.request-Optionen. `dbHostOf` waere dort schlicht das falsche
      // Werkzeug. Unterschieden wird an der Bauform, nicht an einer
      // Dateiliste: eine Namensliste waechst mit jedem neuen HTTP-Client.
      //
      // `.pathname` gehoert AUSDRUECKLICH NICHT in diese Ausschlussliste —
      // `dbNameOf` liest genau das, und die erste Fassung dieser Zeile liess
      // deshalb `reencrypt-company-secrets.resolveDbTarget` (Host + Pfad in
      // einem) wieder durch. Beim Gegenproben aufgefallen. Ein DB-Ziel-Leser
      // braucht `.protocol` nie, ein HTTP-Client immer.
      const gebunden = text.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new URL\(/g) ?? [];
      for (const treffer of gebunden) {
        const name = treffer.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/)?.[1];
        if (!name) continue;
        const liestHost = new RegExp(`\\b${name}\\s*\\.\\s*host(?:name)?\\b`).test(text);
        const zerlegt = new RegExp(
          `\\b${name}\\s*\\.\\s*(?:protocol|search)\\b`,
        ).test(text);
        if (liestHost && !zerlegt) return true;
      }
      return false;
    });
    expect(
      eigenbau,
      "Diese Dateien lesen den DB-Host selbst statt ueber `dbHostOf`:\n  " +
        eigenbau.join("\n  ") +
        "\nNimm `dbHostOf` aus @shared/ephemeral-db-target.",
    ).toEqual([]);
  });

  it("niemand beantwortet 'ist das lokal?' per Schreibweisen-Vergleich", () => {
    // Genau die Form aus scripts/deactivate-selbstzahler-45b.ts:
    //   h === "localhost" || h === "127.0.0.1" || h === "::1"
    const eigenbau = quellen().filter((rel) => {
      if (SSOT_DATEIEN.has(rel)) return false;
      const text = entkommentiert(readFileSync(path.resolve(process.cwd(), rel), "utf8"));
      return /===\s*["'](localhost|127\.0\.0\.1|::1)["']/.test(text);
    });
    expect(
      eigenbau,
      "Diese Dateien vergleichen Loopback-Schreibweisen statt `istLoopback` zu nutzen:\n  " +
        eigenbau.join("\n  ") +
        "\n`0177.0.0.1`, `2130706433` und Trailing-Dot-Formen loesen genauso auf 127.0.0.1 auf.",
    ).toEqual([]);
  });
});
