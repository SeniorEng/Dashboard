// ---------------------------------------------------------------------------
// Prod-Migrationspfad als Black-Box (Follow-up zum Gate-2-Review von PR #21)
//
// `scripts/migrate.sh` ist der Coolify-Pre-Deploy-Command. Er hatte bis hierhin
// NULL automatisierte Abdeckung: `tsc` schliesst `drizzle.config.ts` und
// `scripts/` aus (`tsconfig.json` include), `npm run lint` ebenfalls (Scope
// `client/src server shared tests`), und der `docker-build`-Job pusht das Schema
// auf dem RUNNER statt im Image. Ein Review fand dadurch einen Blocker, den kein
// Gate gesehen hätte: `drizzle.config.ts` importiert seit dem Wegwerf-DB-Guard
// aus `scripts/lib/`, das Image kopierte den Ordner aber nicht → der Config-Load
// wäre im Pre-Deploy mit „Cannot find module" gescheitert.
//
// Dieser Test fängt genau diese Klasse: er ruft `migrate.sh` als Black-Box auf
// und unterscheidet, WORAN es scheitert.
//  1. Der nackte `drizzle-kit push` auf dieselbe DB bricht am Guard ab.
//  2. `migrate.sh` (der echte Pre-Deploy, setzt den Marker selbst) lädt die
//     Config, startet drizzle-kit und kommt bis zum Verbindungsversuch — KEIN
//     Modul-/Guard-/Syntaxfehler.
//  3. Das Image trägt alles, was der Config-Load braucht (Dockerfile-COPY).
//
// Keine DB wird berührt: der Fake-Host nutzt die reservierte `.example`-TLD
// (RFC 6761) und löst als NXDOMAIN auf.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const MIGRATE = path.resolve(process.cwd(), "scripts/migrate.sh");
const FAKE_DB = "postgresql://user:pass@db.dev.example:5432/careconnect";

// `migrate.sh` ruft `npx --yes drizzle-kit@<Version aus package-lock.json>`.
// Liegt genau diese Version lokal, nimmt npx sie; sonst LÄDT es aus dem Netz —
// im Unit-Project, das offline laufen können muss. Wir überspringen den
// Black-Box-Lauf in dem Fall (frisch nach einem Renovate-Bump vor `npm ci`,
// teilinstallierter Baum) statt ihn netzabhängig rot werden zu lassen.
const pinnedDrizzleKit = (() => {
  try {
    const lock = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package-lock.json"), "utf8"),
    );
    const want = lock.packages?.["node_modules/drizzle-kit"]?.version;
    const have = JSON.parse(
      readFileSync(
        path.resolve(process.cwd(), "node_modules/drizzle-kit/package.json"),
        "utf8",
      ),
    ).version;
    return want && want === have;
  } catch {
    return false;
  }
})();

function runMigrate(env: Record<string, string>) {
  return spawnSync("bash", [MIGRATE, "--force"], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      CI: "",
      TEST_DATABASE_URLS: "",
      ALLOW_NON_EPHEMERAL_DB_WRITE: "",
      PGCONNECT_TIMEOUT: "3",
      DATABASE_URL: FAKE_DB,
      ...env,
    },
  });
}

describe("scripts/migrate.sh — Prod-Migrationspfad", () => {
  // Gegenstück: OHNE `migrate.sh` (also der nackte Aufruf in einer Shell mit
  // geerbter DATABASE_URL) muss derselbe Config-Load am Guard scheitern. Das ist
  // der Fall, den `migrate.sh` per Marker bewusst ausnimmt.
  it.skipIf(!pinnedDrizzleKit)(
    "nackter `drizzle-kit push` auf dieselbe DB bricht am Guard ab",
    () => {
      const res = spawnSync("npx", ["drizzle-kit", "push", "--force"], {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          CI: "",
          TEST_DATABASE_URLS: "",
          ALLOW_NON_EPHEMERAL_DB_WRITE: "",
          DATABASE_URL: FAKE_DB,
        },
      });
      expect(`${res.stdout}${res.stderr}`).toMatch(/NICHT-Wegwerf-Datenbank/);
      expect(res.status).not.toBe(0);
    },
  );

  it.skipIf(!pinnedDrizzleKit)(
    "lädt die Module und kommt bis zum Verbindungsversuch",
    () => {
      const res = runMigrate({});
      const out = `${res.stdout}${res.stderr}`;

      // Der Guard darf hier NICHT greifen …
      expect(out).not.toMatch(/NICHT-Wegwerf-Datenbank/);
      // … und der Modul-Load muss durchlaufen. Genau hier wäre ein fehlender
      // COPY im Image sichtbar geworden — jetzt für die ganze Kette, die der
      // Release-Step braucht (Schema-Riegel, Datenstand-Prüfung, drizzle-kit).
      expect(out).not.toMatch(/Cannot find module/);
      expect(out).not.toMatch(/SyntaxError/);
      // Beleg, dass der Release-Step wirklich bis zur DB kommt und erst an der
      // (nicht auflösbaren) Adresse scheitert. Schritt 0d verbindet über
      // `server/lib/db`, nicht über die drizzle-kit-CLI — die Evidenz ist
      // deshalb der Pool-Aufbau plus die gescheiterte Ziel-Abfrage.
      expect(out).toMatch(
        /driver=\w+ pool configured|SELECT current_database|ENOTFOUND|EAI_AGAIN|getaddrinfo/,
      );
      // Und dass er beim ERSTEN gatenden Schritt scheitert, nicht
      // stillschweigend weiterläuft. Erster Schritt ist die Identitäts-Kette;
      // ohne erreichbare DB kommt der Lauf nicht über sie hinaus — und darf es
      // auch nicht, denn ohne bekanntes Ziel ist jede spätere Prüfung wertlos.
      expect(out).toMatch(/Schritt 0a/);
      expect(out).not.toMatch(/Schritt 1 — Schema/);
      expect(res.status).not.toBe(0);
    },
  );

  // Schritt 1 wird seit dem Riegel (0d) im Black-Box-Lauf nicht mehr erreicht —
  // 0d bricht vorher an der nicht auflösbaren DB ab. Die Aussage des früheren
  // Tests („drizzle-kit liest die Config und scheitert erst danach an der DB")
  // ist damit NICHT weg, sie wird hier direkt geübt. Ohne diesen Test wäre der
  // Beleg ersatzlos entfallen, dass der Prod-Migrationspfad die Config lädt.
  it.skipIf(!pinnedDrizzleKit)(
    "Schritt 1 — drizzle-kit liest die Config und scheitert erst an der DB",
    () => {
      const version = JSON.parse(
        readFileSync(path.resolve(process.cwd(), "package-lock.json"), "utf8"),
      ).packages["node_modules/drizzle-kit"].version;

      const res = spawnSync("npx", ["--yes", `drizzle-kit@${version}`, "push", "--force"], {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          CI: "",
          TEST_DATABASE_URLS: "",
          PGCONNECT_TIMEOUT: "3",
          DATABASE_URL: FAKE_DB,
          // Denselben Marker setzt `migrate.sh` — das ist der legitime
          // Prod-Migrationspfad, deshalb greift der Wegwerf-DB-Guard hier nicht.
          ALLOW_NON_EPHEMERAL_DB_WRITE: "1",
        },
      });
      const out = `${res.stdout}${res.stderr}`;

      expect(out).not.toMatch(/NICHT-Wegwerf-Datenbank/);
      expect(out).not.toMatch(/Cannot find module/);
      expect(out).not.toMatch(/SyntaxError/);
      expect(out).toMatch(
        /driver for database querying|Pulling schema|ENOTFOUND|EAI_AGAIN|getaddrinfo/,
      );
    },
  );

  it("migrate.sh ruft Schritt 1 mit der aus dem Lockfile gepinnten Version", () => {
    // Die Verbindung zwischen dem oben direkt geübten Schritt 1 und dem Skript.
    const skript = readFileSync(MIGRATE, "utf8");
    expect(skript).toMatch(/npx --yes "drizzle-kit@\$\{VERSION\}" push "\$@"/);
    expect(skript).toMatch(/package-lock\.json/);
  });

  it("die Identitaets-Kette umschliesst den Push (S7/S8)", () => {
    // Ein Gate, das eine andere Verbindung prueft als der Push benutzt, ist
    // wertlos — das ist die heliumdb-Klasse. Die Kette muss deshalb VOR dem
    // Riegel eroeffnet und NACH dem Push geschlossen werden. Steht die Pruefung
    // vor dem Push, kann sie einen Zielwechsel per Konstruktion nicht sehen.
    const skript = readFileSync(MIGRATE, "utf8");
    const eroeffnen = skript.indexOf("release-identity.ts --schreiben");
    const dropGate = skript.indexOf("release-schema-gate.ts --drop-gate");
    const push = skript.indexOf('npx --yes "drizzle-kit@${VERSION}" push');
    const schliessen = skript.indexOf("release-identity.ts --pruefen");
    expect(eroeffnen).toBeGreaterThan(-1);
    expect(schliessen).toBeGreaterThan(-1);
    expect(dropGate).toBeGreaterThan(eroeffnen);
    expect(schliessen).toBeGreaterThan(push);
  });

  it("die Nachbedingung steht NACH dem Push — sonst misst sie nichts", () => {
    // `drizzle-kit push` meldet DDL-Fehlschläge mit exit 0 (gemessen, 0.31.10).
    // Der Erfolg wird deshalb an der Wirkung gemessen. Stünde 1b vor dem Push,
    // wäre die Messung wertlos — dieser Wächter hält die Reihenfolge fest.
    const skript = readFileSync(MIGRATE, "utf8");
    const push = skript.indexOf('npx --yes "drizzle-kit@${VERSION}" push');
    const nachbedingung = skript.indexOf("release-schema-gate.ts --nachbedingung");
    const dropGate = skript.indexOf("release-schema-gate.ts --drop-gate");
    expect(dropGate).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(dropGate);
    expect(nachbedingung).toBeGreaterThan(push);
  });
});

describe("Dockerfile — Runner-Stage trägt den Pre-Deploy-Pfad", () => {
  const dockerfile = readFileSync(
    path.resolve(process.cwd(), "Dockerfile"),
    "utf8",
  );

  // `drizzle.config.ts` wird von drizzle-kit zur LAUFZEIT gelesen, nicht
  // gebündelt. Jeder Import daraus muss deshalb im Image liegen.
  it("kopiert alles, was drizzle.config.ts zur Laufzeit importiert", () => {
    const config = readFileSync(
      path.resolve(process.cwd(), "drizzle.config.ts"),
      "utf8",
    );

    // Muss BEIDE Formen fangen: `from "./x"` UND den bindungslosen
    // Side-Effect-Import `import "./x"` (den dieser Commit selbst in die Seeds
    // eingeführt hat), dazu `require("./x")` und beide Anführungszeichen-Stile.
    // `import type` zählt nicht — das wird zur Laufzeit gelöscht.
    const localImports = [
      ...config
        .replace(/^\s*import\s+type\s[^\n]*$/gm, "")
        .matchAll(/(?:from|import|require)\s*\(?\s*["']\.\/([^"']+)["']/g),
    ].map((m) => m[1]);
    expect(localImports.length).toBeGreaterThan(0);

    // Eine COPY-Zeile deckt ein Verzeichnis ab, wenn sie es selbst ODER einen
    // seiner Vorfahren kopiert (`COPY scripts ./scripts` deckt `scripts/lib`).
    const coversDir = (dir: string): boolean => {
      const parts = dir.split("/");
      for (let i = parts.length; i > 0; i--) {
        const candidate = parts.slice(0, i).join("/");
        const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`^COPY\\s+${escaped}\\s`, "m").test(dockerfile)) {
          return true;
        }
      }
      return false;
    };

    for (const imported of localImports) {
      // z.B. "scripts/lib/ephemeral-db-guard.ts" → Verzeichnis "scripts/lib"
      const dir = path.dirname(imported);
      expect(
        coversDir(dir),
        `Dockerfile kopiert '${dir}' nicht — drizzle.config.ts importiert daraus, ` +
          `und der Coolify-Pre-Deploy (bash scripts/migrate.sh) bricht im Image ` +
          `sonst mit "Cannot find module" ab.`,
      ).toBe(true);
    }
  });

  // Der Texttest oben sieht nur EINE Ebene. `ephemeral-db-guard` importiert
  // seinerseits `ephemeral-db-sweep` — das liegt zufällig im selben Ordner.
  // Dieser Test pinnt genau diese Annahme fest, damit ein künftiger Import aus
  // einem anderen Verzeichnis nicht still durchrutscht.
  it("die Guard-Kette bleibt innerhalb der kopierten Verzeichnisse", () => {
    // Frueher lautete die Zusicherung "nur `./`-Importe". Das war eine
    // Naeherung fuer die eigentliche Frage — LIEGT DER IMPORT IM IMAGE? — und
    // wurde falsch, sobald `ephemeral-db-guard` seine Auswertung nach
    // `shared/` auslagerte (noetig, weil `server/**` nicht aus `scripts/**`
    // importieren darf). `shared/` wird kopiert; der Import ist also in
    // Ordnung, die alte Formulierung war es nicht.
    //
    // Jetzt wird gefragt, was gemeint war: jeder relative Import muss in ein
    // Verzeichnis zeigen, das die Runner-Stage mitbringt.
    const guardPfad = "scripts/lib/ephemeral-db-guard.ts";
    const guard = readFileSync(path.resolve(process.cwd(), guardPfad), "utf8");
    const kopiert = [...dockerfile.matchAll(/^COPY\s+(?!--from)(.+)$/gm)]
      .flatMap((m) => m[1].trim().split(/\s+/).slice(0, -1))
      .map((q) => path.posix.normalize(q));

    const relatives = [
      ...guard.matchAll(/(?:from|import|require)\s*\(?\s*["'](\.[^"']+)["']/g),
    ].map((m) => m[1]);

    for (const rel of relatives) {
      const ziel = path.posix.normalize(
        path.posix.join(path.posix.dirname(guardPfad), rel),
      );
      const abgedeckt = kopiert.some((q) => ziel === q || ziel.startsWith(`${q}/`));
      expect(
        abgedeckt,
        `ephemeral-db-guard.ts importiert '${rel}' -> '${ziel}', und kein ` +
          `COPY der Runner-Stage deckt das ab. Im Coolify-Pre-Deploy scheitert ` +
          `der Config-Load dann mit "Cannot find module".`,
      ).toBe(true);
    }
    // Sanity: die Aufloesung muss ueberhaupt etwas gefunden haben.
    expect(relatives.length).toBeGreaterThan(0);
  });

  it("kopiert migrate.sh selbst", () => {
    expect(dockerfile).toMatch(/COPY scripts(\/migrate\.sh)? /);
  });

  // Der eigentliche Wächter: nicht eine Liste von Dateinamen abhaken, sondern
  // den TATSÄCHLICHEN Import-Abschluss der Release-Skripte auflösen und gegen
  // die COPY-Zeilen halten. Ein neuer Import in einem der Skripte läuft sonst
  // still am Image vorbei und scheitert erst im Coolify-Pre-Deploy mit
  // "Cannot find module" — also im Deploy, nicht im Test.
  it("deckt den vollstaendigen Import-Abschluss der Release-Skripte ab", () => {
    const wurzel = process.cwd();
    const einstiege = [
      "scripts/release-identity.ts",
      "scripts/release-schema-gate.ts",
      "scripts/release-verify.ts",
    ];

    const gesehen = new Set<string>();
    const offen = [...einstiege];
    while (offen.length > 0) {
      const rel = offen.pop()!;
      if (gesehen.has(rel)) continue;
      gesehen.add(rel);

      let quelle: string;
      try {
        quelle = readFileSync(path.join(wurzel, rel), "utf8");
      } catch {
        continue; // .json/.mjs ohne lesbare Importe — als Datei trotzdem gezählt
      }
      for (const treffer of quelle.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const ziel = path.posix.normalize(
          path.posix.join(path.posix.dirname(rel), treffer[1]),
        );
        // Endung ergänzen, wenn der Import sie weglässt.
        const kandidaten = [ziel, `${ziel}.ts`, `${ziel}.mjs`, `${ziel}.json`];
        const echt = kandidaten.find((k) => existsSync(path.join(wurzel, k)));
        if (echt) offen.push(echt);
      }
    }

    // Welche COPY-Quellen bringt die Runner-Stage mit?
    const kopiert = [...dockerfile.matchAll(/^COPY\s+(?!--from)(.+)$/gm)]
      .flatMap((m) => m[1].trim().split(/\s+/).slice(0, -1))
      .map((q) => path.posix.normalize(q));

    const fehlend = [...gesehen].filter(
      (datei) => !kopiert.some((q) => datei === q || datei.startsWith(`${q}/`)),
    );

    expect(
      fehlend,
      `Diese Dateien braucht der Release-Step, liegen aber nicht im Image:\n  ${fehlend.join("\n  ")}`,
    ).toEqual([]);
    // Das Freigabe-Manifest wird zur LAUFZEIT gelesen, taucht also in keinem
    // Import auf — es braucht eine eigene Zusicherung, sonst faellt es beim
    // naechsten Dockerfile-Umbau lautlos raus.
    expect(dockerfile).toMatch(/COPY docs\/schema-change-manifest\.json/);
    // Sanity: der Abschluss muss die gemessenen server-Dateien enthalten,
    // sonst hat die Aufloesung nichts gefunden und der Test ist eine Attrappe.
    expect(gesehen).toContain("server/lib/db.ts");
    expect(gesehen).toContain("server/scripts/lib/prod-write-gate.ts");
  });
});
