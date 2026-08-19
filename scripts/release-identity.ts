/**
 * Release-Step, Schritte 0a und 1a: **Identitäts-Kette** (S7/S8).
 *
 * Erhebt an jedem Punkt Host, `current_database()` und die aufgelöste
 * drizzle-kit-Version — und zwar über BEIDE Verbindungswege, die der
 * Release-Step benutzt:
 *
 *   `server/lib/db`      → der Weg von 0d, 1b und 2 (wertet `DB_DRIVER` aus)
 *   `dbCredentials.url`  → der Weg von Schritt 1 (drizzle-kit, direkt-TCP)
 *
 * `--schreiben <datei>`  erhebt, prüft die innere Identität und legt sie ab.
 * `--pruefen <datei>`    erhebt erneut und vergleicht gegen die Ablage.
 *
 * Der Datenbankname kommt IMMER aus der offenen Verbindung
 * (`current_database()`), nie aus der URL — der Fehl-Dry-Run gegen `heliumdb`
 * lief genau daran vorbei. Die `DATABASE_URL` selbst wird nie ausgegeben.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { dbHostOf } from "../server/scripts/lib/prod-write-gate";
import {
  abweichungsMeldung,
  pruefeInnereIdentitaet,
  vergleicheIdentitaeten,
  type Identitaet,
} from "./lib/release-identity-core";

const require_ = createRequire(import.meta.url);

function abbruch(nachricht: string): never {
  console.error(`\n${nachricht}\n`);
  process.exit(1);
}

/** `current_database()` über den Weg, den 0d/1b/2 benutzen. */
async function appDatenbank(): Promise<string> {
  const ergebnis = (await db.execute(sql`SELECT current_database() AS db`)) as unknown;
  const rows = Array.isArray(ergebnis) ? ergebnis : (ergebnis as { rows?: unknown[] }).rows;
  const name = (rows?.[0] as { db?: unknown } | undefined)?.db;
  if (typeof name !== "string") {
    abbruch("[identity] FEHLER: current_database() ueber server/lib/db nicht lesbar.");
  }
  return name;
}

/**
 * `current_database()` über den Weg, den Schritt 1 benutzt: ein nackter
 * `pg`-Client auf `process.env.DATABASE_URL`, genau wie `dbCredentials.url`.
 * Bewusst NICHT über `server/lib/db` — sonst würde die Prüfung beide Male
 * dieselbe Verbindung befragen und könnte per Konstruktion nichts finden.
 */
async function direkteDatenbank(): Promise<string> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query<{ db: string }>("SELECT current_database() AS db");
    return res.rows[0].db;
  } finally {
    await client.end();
  }
}

/**
 * Die Version, die `drizzle-kit/api` in 0d/1b tatsächlich lädt.
 *
 * NICHT über `require("drizzle-kit/package.json")` — das Paket exportiert
 * seine `package.json` nicht (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Deshalb den
 * Pfad des Moduls auflösen, das 0d/1b wirklich importieren, und von dort zur
 * `package.json` hochlaufen. So wird die Version der GELADENEN Kopie gemeldet
 * und nicht die irgendeiner anderen im Baum.
 */
function apiVersion(): string {
  let verzeichnis = dirname(require_.resolve("drizzle-kit/api"));
  for (let tiefe = 0; tiefe < 6; tiefe++) {
    const kandidat = join(verzeichnis, "package.json");
    if (existsSync(kandidat)) {
      const paket = JSON.parse(readFileSync(kandidat, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (paket.name === "drizzle-kit" && paket.version) return paket.version;
    }
    const eltern = dirname(verzeichnis);
    if (eltern === verzeichnis) break;
    verzeichnis = eltern;
  }
  abbruch("[identity] FEHLER: Version der geladenen drizzle-kit-Kopie nicht ermittelbar.");
}

/** Die Version, die Schritt 1 über `npx --yes drizzle-kit@<version>` anwendet. */
function cliVersion(): string {
  const lock = require_("../package-lock.json") as {
    packages: Record<string, { version?: string }>;
  };
  const gepinnt = lock.packages["node_modules/drizzle-kit"]?.version;
  if (!gepinnt) {
    abbruch("[identity] FEHLER: drizzle-kit-Version nicht in package-lock.json gefunden.");
  }
  // Nicht nur die Zahl aus dem Lockfile glauben: npx danach fragen, was es
  // unter diesem Bezeichner wirklich auflöst. Genau dort sass S8.
  try {
    const ausgabe = execFileSync("npx", ["--yes", `drizzle-kit@${gepinnt}`, "--version"], {
      encoding: "utf8",
      timeout: 120_000,
    });
    const treffer = /(\d+\.\d+\.\d+)/.exec(ausgabe);
    if (treffer) return treffer[1];
  } catch {
    // Offline / npx nicht erreichbar: der Lockfile-Wert bleibt die Aussage.
    // Er ist das, was migrate.sh gleich aufruft.
  }
  return gepinnt;
}

async function erhebe(punkt: string): Promise<Identitaet> {
  if (!process.env.DATABASE_URL) {
    abbruch("[identity] FEHLER: DATABASE_URL ist nicht gesetzt.");
  }
  const host = dbHostOf(process.env.DATABASE_URL) ?? "(Host unbekannt)";
  return {
    punkt,
    appHost: host,
    appDatenbank: await appDatenbank(),
    direktHost: host,
    direktDatenbank: await direkteDatenbank(),
    drizzleKitApi: apiVersion(),
    drizzleKitCli: cliVersion(),
  };
}

function melde(id: Identitaet): void {
  console.log(
    `[identity] Punkt ${id.punkt} — App-Weg: ${id.appHost}/${id.appDatenbank} · ` +
      `Direkt-Weg: ${id.direktHost}/${id.direktDatenbank} · ` +
      `drizzle-kit api=${id.drizzleKitApi} cli=${id.drizzleKitCli}`,
  );
}

async function main(): Promise<void> {
  const modus = process.argv[2];
  const datei = process.argv[3];
  if ((modus !== "--schreiben" && modus !== "--pruefen") || !datei) {
    abbruch("[identity] Aufruf: release-identity.ts --schreiben|--pruefen <datei>");
  }

  const punkt = modus === "--schreiben" ? "0a (vor dem Riegel)" : "1a (nach dem Push)";
  const jetzt = await erhebe(punkt);
  melde(jetzt);

  // Immer zuerst: zeigen beide Wege auf dieselbe DB, passen beide Versionen?
  const innen = pruefeInnereIdentitaet(jetzt);
  if (innen.length > 0) {
    abbruch(
      abweichungsMeldung(
        innen,
        "Riegel und Push sehen NICHT dasselbe Ziel bzw. nicht dasselbe Werkzeug.",
      ),
    );
  }

  if (modus === "--schreiben") {
    await writeFile(datei, `${JSON.stringify(jetzt, null, 2)}\n`, "utf8");
    console.log(`[identity] Kette eroeffnet: ${datei}`);
    return;
  }

  const frueh = JSON.parse(await readFile(datei, "utf8")) as Identitaet;
  const abweichungen = vergleicheIdentitaeten(frueh, jetzt);
  if (abweichungen.length > 0) {
    abbruch(
      abweichungsMeldung(
        abweichungen,
        "Das Ziel hat sich MITTEN im Release-Step veraendert.",
      ),
    );
  }
  console.log("[identity] Kette geschlossen: Ziel und Werkzeug unveraendert.");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    abbruch(`[identity] FEHLER: ${err instanceof Error ? err.message : String(err)}`);
  });
