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
  // Erst JETZT, nach allen Pruefungen: der bestandene Dev-DB-Nachweis gilt der
  // Laufzeit-Schreibsperre als geprueftes Ziel.
  devZielGeprueft(`dev/${devHost}`);
}
