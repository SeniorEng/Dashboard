/**
 * **Sehen alle Punkte des Release-Steps dieselbe Datenbank und dasselbe
 * Migrationswerkzeug?**
 *
 * ── Warum das nötig ist ─────────────────────────────────────────────────
 * Ein Gate, das eine andere Verbindung prüft als der Push benutzt, ist wertlos.
 * Das ist keine Theorie: der Fehl-Dry-Run lief gegen `heliumdb` statt `neondb`,
 * weil `helium` in Dev wie Prod derselbe interne Hostname ist — der Host allein
 * identifiziert nichts.
 *
 * Der Release-Step hat zwei verschiedene Verbindungswege, und das ist kein
 * Versehen, sondern Konstruktion:
 *
 *   0d / 1b / 2  →  `server/lib/db`     (wertet `DB_DRIVER` aus)
 *   Schritt 1    →  `drizzle.config.ts` (`dbCredentials.url`, direkt-TCP)
 *
 * Mit `DB_DRIVER=neon` und gesetztem `NEON_LOCAL_WS_PROXY` ist der erste Weg
 * eine **Fixed-Target-Brücke**: der Proxy ignoriert den Datenbanknamen aus der
 * URL und leitet auf sein eigenes Ziel. Dann prüft der Riegel DB A, während der
 * Push DB B verändert — ohne eine einzige Fehlermeldung.
 *
 * ── Und die Werkzeug-Version ────────────────────────────────────────────
 * 0d und 1b beurteilen den Trockenlauf über `drizzle-kit/api` aus den
 * INSTALLIERTEN `node_modules`. Schritt 1 wendet über
 * `npx --yes drizzle-kit@<Version aus package-lock.json>` an. Laufen die
 * auseinander, beurteilt der Riegel eine andere Anweisungsliste als die, die
 * ausgeführt wird.
 *
 * Rein: Identitäten rein, Abweichungen raus. Keine DB, kein Dateisystem.
 */

export interface Identitaet {
  /** Welcher Punkt im Release-Step das erhoben hat, z.B. "0a" oder "1b". */
  punkt: string;
  /** Weg über `server/lib/db` — der Weg von 0d, 1b und 2. */
  appHost: string;
  appDatenbank: string;
  /** Weg über `dbCredentials.url` — der Weg von Schritt 1. */
  direktHost: string;
  direktDatenbank: string;
  /** `drizzle-kit/api` aus node_modules — beurteilt in 0d/1b. */
  drizzleKitApi: string;
  /** `npx drizzle-kit@<lockfile>` — wendet in Schritt 1 an. */
  drizzleKitCli: string;
}

export interface Abweichung {
  feld: string;
  links: string;
  rechts: string;
  bedeutung: string;
}

/**
 * Vergleicht die zwei Verbindungswege und die zwei Werkzeug-Versionen INNERHALB
 * einer Erhebung. Das ist die heliumdb-Prüfung: beide Wege müssen auf dieselbe
 * Datenbank zeigen.
 */
export function pruefeInnereIdentitaet(id: Identitaet): Abweichung[] {
  const abweichungen: Abweichung[] = [];

  if (id.appHost !== id.direktHost) {
    abweichungen.push({
      feld: "Host",
      links: id.appHost,
      rechts: id.direktHost,
      bedeutung:
        "Der Riegel (server/lib/db) und der Push (drizzle.config.ts) verbinden zu verschiedenen Hosts.",
    });
  }
  if (id.appDatenbank !== id.direktDatenbank) {
    abweichungen.push({
      feld: "Datenbank",
      links: id.appDatenbank,
      rechts: id.direktDatenbank,
      bedeutung:
        "Gleicher Host, ANDERE Datenbank — genau die heliumdb-/neondb-Verwechslung. " +
        "Haeufigste Ursache: NEON_LOCAL_WS_PROXY ist gesetzt und ignoriert den DB-Namen aus der URL.",
    });
  }
  if (id.drizzleKitApi !== id.drizzleKitCli) {
    abweichungen.push({
      feld: "drizzle-kit-Version",
      links: id.drizzleKitApi,
      rechts: id.drizzleKitCli,
      bedeutung:
        "Der Trockenlauf (drizzle-kit/api aus node_modules) beurteilt eine andere " +
        "Anweisungsliste als die, die Schritt 1 (npx drizzle-kit@<lockfile>) anwendet.",
    });
  }
  return abweichungen;
}

/**
 * Vergleicht zwei Erhebungen aus verschiedenen Punkten desselben Laufs. Ändert
 * sich zwischen 0a und 1b irgendetwas, ist die Kette gerissen.
 */
export function vergleicheIdentitaeten(frueh: Identitaet, spaet: Identitaet): Abweichung[] {
  const felder: [keyof Identitaet, string][] = [
    ["appHost", "Host (App-Weg)"],
    ["appDatenbank", "Datenbank (App-Weg)"],
    ["direktHost", "Host (Direkt-Weg)"],
    ["direktDatenbank", "Datenbank (Direkt-Weg)"],
    ["drizzleKitApi", "drizzle-kit (api)"],
    ["drizzleKitCli", "drizzle-kit (cli)"],
  ];
  const abweichungen: Abweichung[] = [];
  for (const [feld, name] of felder) {
    if (frueh[feld] !== spaet[feld]) {
      abweichungen.push({
        feld: name,
        links: String(frueh[feld]),
        rechts: String(spaet[feld]),
        bedeutung: `Zwischen Punkt ${frueh.punkt} und Punkt ${spaet.punkt} veraendert.`,
      });
    }
  }
  return abweichungen;
}

export function abweichungsMeldung(
  abweichungen: readonly Abweichung[],
  ueberschrift: string,
): string {
  return (
    `RELEASE ABGEBROCHEN — ${ueberschrift}\n\n` +
    abweichungen
      .map((a) => `  ${a.feld}: "${a.links}"  vs  "${a.rechts}"\n    ${a.bedeutung}`)
      .join("\n\n") +
    `\n\nEin Gate, das eine andere Verbindung prueft als der Push benutzt, ist\n` +
    `wertlos. Der Deploy bricht deshalb hier ab; die laufende Version bleibt\n` +
    `unberuehrt.`
  );
}
