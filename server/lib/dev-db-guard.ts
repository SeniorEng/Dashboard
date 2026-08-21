import { devZielGeprueft } from "./prod-write-lock";
import { dbNameOf } from "@shared/ephemeral-db-target";
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
 *   4. DATABASE_URL == PROD_DATABASE_URL (Host UND Datenbank).
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
    // Host UND Datenbankname. Nur-Host liess den Fall „gleicher Host, andere
    // Datenbank" durch — und genau das war der Vorfall: Host stimmte, die
    // Datenbank nicht.
    const prodDb = (dbNameOf(prodUrl) || "").toLowerCase();
    const devDb = (dbNameOf(url) || "").toLowerCase();
    if (prodHost && devHost === prodHost && (!prodDb || !devDb || prodDb === devDb)) {
      throw new Error(
        `ABBRUCH: DATABASE_URL == PROD_DATABASE_URL ('${devHost}/${devDb || "?"}'). Verweigert.`,
      );
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
 * Gemessen laufen damit `helium` (die Replit-Wegwerf-Default-DB, das
 * Near-Miss-Ziel des Vorfalls), die Neon-Prod-Form
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

  // Prod-Reject: das Ziel darf NIE die Produktionsdatenbank sein, auch nicht
  // mit passend gesetztem DEV_WRITE_CONFIRM_TARGET. Prod-Identitaet kommt aus
  // PROD_DATABASE_URL (Host) und dem Namen der OFFENEN Verbindung — dieselbe
  // Quelle wie im Prod-Gate, nur negativ verwendet.
  const prodUrl = (process.env.PROD_DATABASE_URL || "").trim();
  if (prodUrl) {
    const prodHost = (dbHostOf(prodUrl) || "").toLowerCase();
    const prodDb = (dbNameOf(prodUrl) || "").toLowerCase();
    // Fail-closed wie auf der Prod-Seite: eine gesetzte, aber unauswertbare
    // PROD_DATABASE_URL darf nicht dazu fuehren, dass der Reject stumm bleibt
    // UND das Log ihn als aktiv meldet. Genau diese Fehlerklasse soll der
    // Drift-Waechter sichtbar machen — er darf sie nicht selbst erzeugen.
    if (!prodHost || !prodDb) {
      throw new Error(
        `ABBRUCH: PROD_DATABASE_URL ist gesetzt, aber nicht auswertbar ` +
          `(Host: "${prodHost || "?"}", Datenbank: "${prodDb || "?"}"). ` +
          `Ohne sie laesst sich der Prod-Reject nicht durchfuehren. Fail-closed.`,
      );
    }
    if (prodHost === host.toLowerCase() && prodDb === datenbank.toLowerCase()) {
      throw new Error(
        `ABBRUCH: "${tatsaechlich}" IST die Produktionsdatenbank (PROD_DATABASE_URL).\n` +
          `Ein schreibender Dev-Lauf geht dorthin nie — auch nicht mit passendem ` +
          `${DEV_WRITE_CONFIRM_ENV}.`,
      );
    }
    // Drift-Waechter: die Zusage haengt daran, dass PROD_DATABASE_URL das
    // WIRKLICHE Prod-Ziel nennt. Faellt sie weg, faellt der Reject lautlos mit —
    // deshalb steht im Log, worauf verglichen wurde.
    console.log(`[dev-write] Prod-Reject aktiv, verglichen gegen ${prodHost}/${prodDb}`);
  } else {
    // Bewusster Rest-Rand (Stolperdraht, nicht Sandbox): ohne
    // PROD_DATABASE_URL laesst sich Prod nicht identifizieren. Der
    // VERSEHENTLICHE Fall ist trotzdem gefangen — dafuer muesste jemand das
    // Ziel exakt richtig benennen. Der absichtliche bleibt offen.
    console.log(
      `[dev-write] Hinweis: PROD_DATABASE_URL nicht gesetzt — kein Prod-Reject moeglich.`,
    );
  }

  devZielGeprueft(tatsaechlich);
  return tatsaechlich;
}
