/**
 * Freigabe für schema-verändernde Anweisungen — **an den Schema-Stand
 * gebunden, nicht an eine Umgebungsvariable** (S6).
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * `PUBLISH_ACK_DROPS` als Deployment-Env. Im Operator-Preflight steht die
 * Variable pro Aufruf auf der Kommandozeile und ist danach weg. Auf dem
 * Deploy-Pfad müsste sie als Plattform-Env gesetzt werden — und bliebe dann
 * gesetzt: derselbe Schlüssel genehmigte still jeden künftigen Deploy. Eine
 * Freigabe, die nicht abläuft, ist keine Freigabe.
 *
 * Das Muster ist im Haus schon etabliert: `docs/pre-publish-backup-runbook.md`
 * §8.6 bindet den Escape-Hatch des Boot-Gates an einen `schemaHash` und
 * entwertet ihn automatisch, sobald sich das Schema ändert. Genau das hier,
 * für die Release-Freigaben.
 *
 * ── Warum die Bindung wirkt ─────────────────────────────────────────────
 * Der Hash läuft über den LIVE-Schemastand der Zieldatenbank. Sobald eine
 * freigegebene Änderung angewendet ist, ist der Stand ein anderer — der
 * Eintrag passt nicht mehr und kann nicht ein zweites Mal ziehen. Die Freigabe
 * ist damit von sich aus einmalig, ohne dass jemand aufräumen muss.
 *
 * Rein: Schnappschuss/Manifest rein, Urteil raus. Keine DB, kein Dateisystem.
 */
import { createHash } from "node:crypto";

/** Form von `fetchSchemaSnapshot` in `script/schema-replica-diff.mjs`. */
export type SchemaSnapshot = Record<string, string[]>;

export interface Freigabe {
  /** Schlüssel der Änderung, z.B. `column:invoices.legacy_betrag` */
  aenderung: string;
  /** Schema-Stand, für den die Freigabe gilt. */
  schemaHash: string;
  /** Nachweis des Backups nach docs/pre-publish-backup-runbook.md. */
  backupId: string;
  begruendung: string;
  zeitpunkt: string;
}

export interface Manifest {
  freigaben: Freigabe[];
}

/**
 * Deterministischer Hash über den Live-Schemastand: Tabellen und ihre Spalten,
 * beide sortiert. Reihenfolge aus der DB darf das Ergebnis nicht beeinflussen —
 * sonst entwertete sich jede Freigabe zufällig.
 */
export function berechneSchemaHash(snapshot: SchemaSnapshot): string {
  const kanonisch = Object.keys(snapshot)
    .sort()
    .map((tabelle) => `${tabelle}(${[...snapshot[tabelle]].sort().join(",")})`)
    .join(";");
  return createHash("sha256").update(kanonisch).digest("hex").slice(0, 32);
}

export type Ablehnungsgrund = "keine Freigabe" | "Freigabe entwertet";

export interface Ablehnung {
  aenderung: string;
  grund: Ablehnungsgrund;
  /** Bei `Freigabe entwertet`: der Stand, für den sie ausgestellt wurde. */
  ausgestelltFuer?: string;
}

export interface Freigabeurteil {
  abgelehnt: Ablehnung[];
  angenommen: Freigabe[];
}

/**
 * Prüft jede freigabepflichtige Änderung gegen das Manifest.
 *
 * Ein Eintrag zieht nur, wenn er **denselben** Schlüssel UND **denselben**
 * `schemaHash` trägt. Ein Eintrag mit passendem Schlüssel, aber altem Hash,
 * wird ausdrücklich als *entwertet* gemeldet und nicht etwa als „fehlt" —
 * das ist der Unterschied zwischen „noch nie freigegeben" und „schon
 * verbraucht", und der Betreiber muss ihn sehen.
 */
export function pruefeFreigaben(
  pflichtigeKeys: readonly string[],
  manifest: Manifest,
  schemaHash: string,
): Freigabeurteil {
  const abgelehnt: Ablehnung[] = [];
  const angenommen: Freigabe[] = [];

  for (const key of pflichtigeKeys) {
    const treffer = manifest.freigaben.filter((f) => f.aenderung === key);
    const gueltig = treffer.find((f) => f.schemaHash === schemaHash);
    if (gueltig) {
      angenommen.push(gueltig);
      continue;
    }
    if (treffer.length > 0) {
      abgelehnt.push({
        aenderung: key,
        grund: "Freigabe entwertet",
        ausgestelltFuer: treffer[0].schemaHash,
      });
      continue;
    }
    abgelehnt.push({ aenderung: key, grund: "keine Freigabe" });
  }

  return { abgelehnt, angenommen };
}

export function freigabeMeldung(
  urteil: Freigabeurteil,
  schemaHash: string,
): string {
  const entwertet = urteil.abgelehnt.filter((a) => a.grund === "Freigabe entwertet");
  return (
    `RELEASE ABGEBROCHEN — ${urteil.abgelehnt.length} schema-veraendernde\n` +
    `Anweisung(en) ohne gueltige Freigabe.\n\n` +
    urteil.abgelehnt
      .map(
        (a) =>
          `  ${a.aenderung}\n    ${a.grund}` +
          (a.ausgestelltFuer ? ` (ausgestellt fuer Schema ${a.ausgestelltFuer})` : ""),
      )
      .join("\n") +
    `\n\nAktueller Schema-Stand: ${schemaHash}\n\n` +
    (entwertet.length > 0
      ? `${entwertet.length} Freigabe(n) sind ENTWERTET: sie wurden fuer einen anderen\n` +
        `Schema-Stand ausgestellt. Das ist Absicht — eine Freigabe gilt genau\n` +
        `einmal, fuer genau den Stand, den jemand geprueft hat.\n\n`
      : "") +
    `Wenn die Aenderung gewollt ist: Backup nach\n` +
    `docs/pre-publish-backup-runbook.md ziehen und je Aenderung EINEN Eintrag\n` +
    `in docs/schema-change-manifest.json anlegen —\n\n` +
    urteil.abgelehnt
      .map(
        (a) =>
          `  { "aenderung": "${a.aenderung}", "schemaHash": "${schemaHash}",\n` +
          `    "backupId": "<dump-datei>", "begruendung": "<warum>", "zeitpunkt": "<ISO>" }`,
      )
      .join("\n") +
    `\n\nEin Sammel-OK gibt es bewusst nicht, und ein Dauer-Freifahrtschein\n` +
    `ueber eine Umgebungsvariable auch nicht: der Eintrag entwertet sich mit\n` +
    `der naechsten Schemaaenderung von selbst.`
  );
}
