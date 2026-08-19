/**
 * Nachbedingung des Schema-Pushs: **hat der Push wirklich angewendet, was er
 * anwenden wollte?**
 *
 * ── Warum das gebraucht wird ────────────────────────────────────────────
 * `drizzle-kit push` beendet sich bei einem Fehler der DDL mit **exit 0**.
 * Gemessen (0.31.10, Rolle ohne `CREATE` auf `public`):
 *
 *     error: permission denied for schema public
 *     EXITCODE=0        angelegte Tabellen: 0
 *
 * `set -euo pipefail` kann das per Konstruktion nicht sehen. Der Release-Step
 * lief danach weiter, Schritt 2 meldete „Tabelle `invoices` existiert nicht —
 * nichts zu prüfen", und `migrate.sh` sagte „Serving darf starten": neuer Code
 * auf unmigriertem Schema. Das ist die Ausfallklasse vom 18.08.2026, nur über
 * das Schema statt über die Daten.
 *
 * Deshalb wird der Erfolg an einer **Nachbedingung** gemessen, nicht am
 * Rückgabewert: nach dem Push erneut trocken laufen und prüfen, was noch
 * aussteht.
 *
 * ── Warum nicht einfach „0 Anweisungen" ─────────────────────────────────
 * Gemessen: ein Push gegen ein DECKUNGSGLEICHES Schema lässt dauerhaft ~17
 * Anweisungen anstehen — drizzle legt Fremdschlüssel neu an, weil Postgres die
 * generierten Namen auf 63 Zeichen kürzt, und sieht seine eigenen `SET DEFAULT`
 * nicht als angewendet. „0 Anweisungen" wäre nie erreichbar; die Prüfung wäre
 * nach dem ersten Fehlalarm abgeschaltet.
 *
 * ── Zwei Lagen, beide sperrend ──────────────────────────────────────────
 *  1. **Klassifikation** — jede noch anstehende Anweisung wird eingeordnet.
 *     `strukturell` heißt: der Push hat sie nicht angewendet, obwohl sie das
 *     Schema verändert. `unbekannt` heißt: diese Form kenne ich nicht — und
 *     wird wie `strukturell` behandelt. **Fail-closed ist der ganze Punkt.**
 *  2. **Fingerprint** — die benignen Churn-Anweisungen sind in
 *     `benign-push-churn.json` festgenagelt. Was nicht darin steht, sperrt
 *     ebenfalls, auch wenn es kosmetisch aussieht.
 *
 * Rein: Anweisungen rein, Urteil raus. Keine DB, kein drizzle-Import.
 */

export type Klasse = "kosmetisch" | "strukturell" | "unbekannt";

/**
 * Formen, die das Schema verändern. Sie stehen VOR den kosmetischen Regeln,
 * weil `ADD CONSTRAINT … UNIQUE`/`CHECK` sonst von der Fremdschlüssel-Regel
 * eingesammelt würden.
 *
 * `SET NOT NULL`, `UNIQUE`, `CHECK` und verengende Typänderungen stehen hier
 * ausdrücklich: sie brechen den ALTEN Code, der im Teil-Fehlschlag-Fenster noch
 * bedient, genauso wie ein Spalten-Drop.
 */
const STRUKTURELL: RegExp[] = [
  /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b/i,
  /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i,
  /\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/i,
  /\bALTER\s+COLUMN\b[\s\S]*\bDROP\s+NOT\s+NULL\b/i,
  /\bALTER\s+COLUMN\b[\s\S]*\bSET\s+DATA\s+TYPE\b/i,
  /\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i,
  /\bADD\s+CONSTRAINT\b[\s\S]*\bUNIQUE\b/i,
  /\bADD\s+CONSTRAINT\b[\s\S]*\bCHECK\b/i,
  /\bADD\s+(?:COLUMN\s+)?PRIMARY\s+KEY\b/i,
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bCREATE\s+TYPE\b/i,
  /\bALTER\s+TYPE\b/i,
  /\bDROP\s+TYPE\b/i,
  /\bCREATE\s+SCHEMA\b/i,
  /\bTRUNCATE\b/i,
  /\bCREATE\s+(?:MATERIALIZED\s+)?VIEW\b/i,
  /\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/i,
];

/**
 * Der bekannte, harmlose Bodensatz jedes Pushs. Bewusst eng: nur
 * Fremdschlüssel-Churn und Default-Angleichung.
 */
const KOSMETISCH: RegExp[] = [
  /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+CONSTRAINT\b/i,
  /\bADD\s+CONSTRAINT\b[\s\S]*\bFOREIGN\s+KEY\b/i,
  /\bALTER\s+COLUMN\b[\s\S]*\b(?:SET|DROP)\s+DEFAULT\b/i,
];

export function klassifiziereAnweisung(sql: string): Klasse {
  for (const muster of STRUKTURELL) {
    if (muster.test(sql)) return "strukturell";
  }
  for (const muster of KOSMETISCH) {
    if (muster.test(sql)) return "kosmetisch";
  }
  return "unbekannt";
}

/** Whitespace-Rauschen darf einen Fingerprint-Treffer nicht verhindern. */
export function normalisiere(sql: string): string {
  // Reihenfolge zählt: erst Whitespace verdichten, dann das abschließende
  // Semikolon MIT umgebendem Leerraum entfernen. Ein `.replace(/;$/, "")` nach
  // dem Trimmen lässt bei `… 0 ;` ein Leerzeichen stehen und verfehlt den
  // Fingerprint-Treffer — genau das hat der Whitespace-Test gefangen.
  return sql.replace(/\s+/g, " ").replace(/\s*;\s*$/, "").trim();
}

export interface Blockade {
  sql: string;
  grund: "strukturell" | "unbekannte Form" | "nicht im Fingerprint";
}

export interface Nachbedingung {
  blockaden: Blockade[];
  /** Anweisungen, die beide Lagen passiert haben. */
  geduldet: string[];
}

/**
 * Beurteilt, was nach dem Push noch aussteht.
 *
 * Eine Anweisung wird nur geduldet, wenn sie **beide** Lagen passiert:
 * kosmetisch klassifiziert UND im Fingerprint enthalten. Alles andere sperrt.
 */
export function bewerteNachbedingung(
  anstehend: readonly string[],
  fingerprint: readonly string[],
): Nachbedingung {
  const bekannt = new Set(fingerprint.map(normalisiere));
  const blockaden: Blockade[] = [];
  const geduldet: string[] = [];

  for (const sql of anstehend) {
    const klasse = klassifiziereAnweisung(sql);
    if (klasse === "strukturell") {
      blockaden.push({ sql, grund: "strukturell" });
      continue;
    }
    if (klasse === "unbekannt") {
      blockaden.push({ sql, grund: "unbekannte Form" });
      continue;
    }
    if (!bekannt.has(normalisiere(sql))) {
      blockaden.push({ sql, grund: "nicht im Fingerprint" });
      continue;
    }
    geduldet.push(sql);
  }

  return { blockaden, geduldet };
}
