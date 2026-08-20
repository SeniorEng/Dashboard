import { devZielGeprueft } from "./prod-write-lock";
/**
 * Dev-DB-CLI-Prod-Schutz-Guards (DB-frei)
 *
 * Ersetzungs-Regel: Dieses Modul ERSETZT die zuvor inline in
 * `server/scripts/sweep-dev-test-data.ts` definierte Guard-Logik
 * (`PROD_HOST_PATTERN`, `dbHostOf`, `assertDevDatabase`). Es fügt KEINE neue
 * Lösch-/Sweep-Logik hinzu, sondern löst nur die reine, DB-freie Schutz-Schicht
 * heraus, damit ein Schutz-Check sie OHNE Import des DB-Moduls (`../lib/db`)
 * abdecken kann. Der Wrapper `sweep-dev-test-data.ts` importiert und
 * re-exportiert die Symbole von hier (Single-Source-of-Truth bleibt erhalten).
 *
 * Warum DB-frei: Der bisherige Guard-Test
 * `tests/test-data-cleanup-sweep-guard.test.ts` importiert über das Sweep-Skript
 * transitiv `server/lib/db` und liegt deshalb im DB-/Server-gegateten
 * `integration`-Vitest-Project. In Forks ohne `TEST_USER_*`-Secrets wird dieses
 * Gate übersprungen — eine Regression der ZERSTÖRERISCHEN Sweep-Prod-Guards
 * bliebe unbemerkt. Durch das DB-freie Modul kann ein reiner Unit-Test
 * (`tests/architecture/sweep-dev-guard.test.ts`) die vier Abbruch-Bedingungen
 * als IMMER laufendes CI-Gate (`static-analysis`-Job) absichern.
 *
 * Die Schutz-Logik ist zeichengleich zu den Shell-Guards in
 * `scripts/lib/assert-dev-db.sh` (gesourcet von `scripts/backup-dev-db.sh` und
 * `scripts/reseed-dev-db.sh`). Da ein TS-Modul keine Shell-Funktion sourcen
 * kann (und umgekehrt), lässt sich die Logik nicht physisch teilen; das
 * Auseinanderdriften beider Welten wird stattdessen durch den
 * Cross-Language-Paritäts-Test
 * `tests/architecture/dev-db-guard-parity.test.ts` abgesichert, der EINE
 * Fixtures-Tabelle durch BEIDE Implementierungen reicht. Wer hier die Host-/
 * Prod-Erkennung ändert, muss sie auch in `scripts/lib/assert-dev-db.sh`
 * nachziehen, sonst bricht der Paritäts-Test.
 */

// Prod-Pattern auf dem Hostnamen — zeichengleich zu den Shell-Guards in
// scripts/reseed-dev-db.sh und scripts/backup-dev-db.sh.
export const PROD_HOST_PATTERN = /(^|[.-])prod([.-]|$)|production/;

/**
 * Extrahiert den (lowercased) Hostnamen aus einer Connection-URL. Fällt bei
 * nicht-parsebarer URL auf eine schema-gebundene Regex zurück (gespiegelt aus
 * der Shell-Lib) und liefert einen leeren String, wenn kein Host ermittelbar
 * ist (→ fail-closed im Aufrufer).
 */
export function dbHostOf(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Fallback: parse-bar nur mit GÜLTIGEM Schema (`scheme://`), exakt
    // gespiegelt aus der sed-Regex in scripts/lib/assert-dev-db.sh. Wichtig für
    // die Cross-Language-Parität: ein malformter Scheme-Prefix (z.B.
    // `postgres ://user@host` mit Leerzeichen) darf KEINEN Host liefern, sondern
    // muss — wie die Shell — leer zurückkommen (→ fail-closed im Aufrufer).
    // Eine reine `@host`-Regex würde hier fälschlich den Host extrahieren und
    // die Guards passieren lassen, während die Shell abbricht.
    const m = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)/);
    host = (m ? m[1] : "").toLowerCase();
  }
  return host;
}

/**
 * Verweigert den Lauf, sobald der Verdacht besteht, dass NICHT gegen eine
 * Dev-DB gearbeitet wird. Vier Abbruch-Bedingungen:
 *   1. NODE_ENV=production.
 *   2. DB-Host sieht nach Produktion aus (Regex).
 *   3. Fail-closed: Host nicht aus DATABASE_URL extrahierbar.
 *   4. DATABASE_URL-Host == PROD_DATABASE_URL-Host.
 */
export function assertDevDatabase(): void {

  if (process.env.NODE_ENV === "production") {
    throw new Error("ABBRUCH: NODE_ENV=production. db:sweep-dev läuft nur gegen die Dev-DB.");
  }
  const url = process.env.DATABASE_URL || "";
  if (!url) {
    throw new Error("ABBRUCH: DATABASE_URL ist nicht gesetzt.");
  }
  const devHost = dbHostOf(url);
  // Fail-closed: ohne ermittelbaren Host können die Prod-Guards nicht greifen.
  if (!devHost) {
    throw new Error("ABBRUCH: DB-Host konnte aus DATABASE_URL nicht extrahiert werden (fail-closed).");
  }
  if (PROD_HOST_PATTERN.test(devHost)) {
    throw new Error(`ABBRUCH: DB-Host '${devHost}' sieht nach Produktion aus. Verweigert.`);
  }
  const prodUrl = process.env.PROD_DATABASE_URL || "";
  if (prodUrl) {
    const prodHost = dbHostOf(prodUrl);
    if (prodHost && devHost === prodHost) {
      throw new Error(`ABBRUCH: DATABASE_URL-Host == PROD_DATABASE_URL-Host ('${devHost}'). Verweigert.`);
    }
  }
  console.log(`Sicherheits-Checks ok. Dev-DB-Host: ${devHost}`);
}

/** Env, in der das Dev-Ziel ausdruecklich benannt wird: `<host>/<datenbank>`. */
export const DEV_WRITE_CONFIRM_ENV = "DEV_WRITE_CONFIRM_TARGET";

/**
 * **Positive** Ziel-Pruefung fuer schreibende Dev-Laeufe — so streng wie das
 * Prod-Gate, nur ohne Audit-Attribution (Dev-Daten sind nicht GoBD-relevant,
 * die Ziel-Verwechslung ist es sehr wohl).
 *
 * ── Warum `assertDevDatabase()` allein nicht genuegt ────────────────────
 * Sie ist ein NEGATIVES Praedikat: „der Host sieht nicht nach Produktion aus".
 * Gemessen laufen damit `helium` (der echte Prod-Host), die Neon-Prod-Form
 * `ep-….aws.neon.tech` und `localhost` glatt durch — „nicht Prod" ist eben
 * auch fuer eine unbekannte oder fehlkonfigurierte Datenbank wahr. Genau
 * dieses NULL-Loch hat schon einmal zugeschlagen.
 *
 * Diese Funktion dreht das um: das Ziel muss ausdruecklich BENANNT werden, und
 * der Datenbankname kommt aus der OFFENEN Verbindung (`current_database()`),
 * nicht aus der URL — dieselbe Quelle, an der der Fehl-Dry-Run vom 18.08.2026
 * vorbeilief.
 *
 * ── Warum Env pro Lauf und keine gepinnte Allowlist ────────────────────
 * Die Dev-DB ist eine Prod-KOPIE; ihr Name ist nirgends im Repo dokumentiert.
 * Eine Allowlist muesste geraten werden, und ein falsch gepinnter Name waere
 * schlechter als eine ausdrueckliche Deklaration. Die Variable ist stabil und
 * gehoert einmal ins Dev-Shell-Profil — danach ist die Friktion null.
 */
export async function assertDevWriteTargetOrThrow(): Promise<string> {
  // Erst der billige Screen (NODE_ENV, Prod-Muster, PROD_DATABASE_URL-Gleichheit).
  assertDevDatabase();

  const erwartet = (process.env[DEV_WRITE_CONFIRM_ENV] || "").trim();
  if (!erwartet) {
    throw new Error(
      `ABBRUCH: schreibender Dev-Lauf erfordert ${DEV_WRITE_CONFIRM_ENV}="<host>/<datenbank>".\n` +
        `Der Datenbankname wird an der OFFENEN Verbindung geprueft, nicht aus der URL gelesen —\n` +
        `"nicht nach Prod aussehend" ist KEIN Nachweis (helium, localhost und die Neon-Prod-Form\n` +
        `bestehen ihn alle).`,
    );
  }

  // DYNAMISCH importiert: `prod-write-gate` zieht `server/lib/db` mit, und das
  // wirft beim Modul-Load, wenn keine DATABASE_URL gesetzt ist. Statisch
  // importiert waere dieses Modul damit ohne DB nicht mehr ladbar gewesen — der
  // Paritaets-Test laeuft aber bewusst ohne. An DIESER Stelle ist die URL per
  // Definition da, der Screen oben hat sie schon geprueft.
  const { currentDatabaseName } = await import("../scripts/lib/prod-write-gate");
  const host = dbHostOf(process.env.DATABASE_URL || "");
  const datenbank = await currentDatabaseName();
  const tatsaechlich = `${host}/${datenbank}`;
  if (erwartet !== tatsaechlich) {
    throw new Error(
      `ABBRUCH: ${DEV_WRITE_CONFIRM_ENV}="${erwartet}", die offene Verbindung zeigt aber auf ` +
        `"${tatsaechlich}". Verweigert.`,
    );
  }

  devZielGeprueft(tatsaechlich);
  return tatsaechlich;
}
