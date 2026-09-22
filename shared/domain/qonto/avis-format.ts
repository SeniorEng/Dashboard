/**
 * Task #1687 — Reine strukturelle Erkennungs-Helfer für den `1;`-Kassen-CSV-Import
 * (AOK-Plus, Barmer & Co.). Ersetzt die bisherige feste Feld-Index-Annahme
 * (`parts[4]` = Betrag) durch eine strukturelle Erkennung, damit verschobene
 * Layouts (z.B. AOK mit Betrag an Feld 5) korrekt geparst werden statt still als
 * Barmer fehlinterpretiert.
 */

import { extractInvoiceNumber } from "./avis-match";

/** Erkanntes Format eines Zahlungsavis. `davaso` = IKK/DAVASO (Header `LfdNr,…`),
 * die übrigen stammen aus der `1;`-Familie; `kassen-csv` = generischer Fallback
 * ohne eindeutiges Kassen-Signal; `unbekannt` = strukturell nicht auflösbar. */
export type AvisFormat = "davaso" | "barmer" | "aok" | "kassen-csv" | "unbekannt";

/** Manuelles Spalten-Mapping (Fallback, wenn die strukturelle Erkennung scheitert).
 * Feld-Indizes innerhalb einer `2;`-Positionszeile. */
export interface AvisColumnMap {
  betrag: number;
  referenz: number | null;
  datum: number | null;
}

/** Genau-ein-Betragsfeld ließ sich nicht ermitteln → manuelles Mapping nötig. */
export class AvisParseUncertainError extends Error {
  readonly preview: string[][];
  readonly suggestedColumnMap: AvisColumnMap | null;
  constructor(message: string, preview: string[][], suggestedColumnMap: AvisColumnMap | null) {
    super(message);
    this.name = "AvisParseUncertainError";
    this.preview = preview;
    this.suggestedColumnMap = suggestedColumnMap;
  }
}

/**
 * Die Datei ist so aufgebaut, dass der Parser sie nicht verantworten kann.
 *
 * ── Warum das eine EIGENE Klasse braucht ────────────────────────────────
 * Die Struktur-Riegel (Pflichtspalten, unlesbarer Zahlbetrag, Belegzeile ohne
 * Kopfzeile, Belegzeile im falschen Block, doppelte Belegnummer) warfen einen
 * nackten `Error`. `asyncHandler` faengt den ab und ersetzt ihn durch seine
 * Standardmeldung — aus „ZEM_BelegNr fehlt" wurde ein HTTP 500 mit
 * „Zahlungsavis konnte nicht gespeichert werden".
 *
 * **Damit war der Riegel im Code laut und an der Oberflaeche stumm.** Eine
 * korrekt abgelehnte Datei sah aus wie ein kaputtes System — und das ist
 * praktisch dasselbe Versagen, das dieser ganze Vorgang abraeumt: eine
 * Pruefung, deren Ergebnis niemand ablesen kann, ist keine.
 *
 * Wer sie faengt, antwortet mit 400 und dem GRUND, nicht mit 500 und einer
 * Verlegenheitsformel.
 */
export class AvisDateiaufbauError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvisDateiaufbauError";
  }
}

/**
 * Deutsch formatierter Geldbetrag: 49,13 · 1.234,56 · -70,00 · 252,3.
 *
 * EINE ODER ZWEI Nachkommastellen. Das Muster verlangte zwei — gemessen am
 * Korpus (`tests/fixtures/avis-korpus`, 82 Echt-Dateien) gibt es Zeilen mit
 * einer: `…;252,3;…` und `…;76,7;+;…`. Sie ergaben KEINEN Kandidaten, also
 * `detectAmountFieldIndex → -1`, also `AvisParseUncertainError` — **zwei der
 * 82 Dateien waren gar nicht importierbar.**
 *
 * Die Erweiterung ist einseitig, und das ist gemessen, nicht angenommen: über
 * alle 480 `2;`/`3;`-Zeilen des Korpus gewinnen genau DREI einen Kandidaten,
 * alle drei hatten vorher NULL. **Keine einzige Zeile geht von eindeutig zu
 * mehrdeutig** — es kann also nichts brechen, was heute liest.
 *
 * `parseBetragCents` konnte `252,3` schon immer korrekt lesen (25230 ct,
 * ausgefuehrt). Die Luecke sass allein in der ERKENNUNG.
 *
 * ── Und die Tausendergruppe ist OPTIONAL ──────────────────────────────
 * `\d{1,3}(\.\d{3})*` verlangt bei vier Stellen eine Gruppierung: `5798,66`
 * fiel durch, `5.798,66` nicht. Solange der Gesamtbetrag ueber `parts[3]`
 * gelesen wurde, spielte das keine Rolle — `parseBetragCents` prueft die Form
 * nicht. Seit die ERKENNUNG strukturell ist, waere daraus „kein Betrag
 * gefunden" geworden.
 *
 * Der Korpus enthaelt die ungruppierte Form NICHT (0 von 480 Zeilen aendern
 * sich durch diese Erweiterung, ausgefuehrt) — gefunden hat sie ein
 * konstruiertes Fixture. Echte Dateien und erdachte Faelle fangen
 * verschiedene Dinge; der Korpus ERSETZT die Fixtures nicht, er ergaenzt sie.
 */
const GERMAN_AMOUNT_RE = /^-?(\d{1,3}(\.\d{3})*|\d+),\d{1,2}$/;
/**
 * dd.mm.yyyy (auch dd.mm.yy) — als Datum ausgeschlossen.
 *
 * Das ist die SSoT fuer „ist dieses Feld ein Datum?". Der Kassen-Parser hatte
 * dafuer kurzzeitig ein eigenes, STRENGERES Muster (zweistelliger Tag,
 * vierstelliges Jahr) — ein Zweitbegriff derselben fachlichen Frage. Gemessen
 * am Korpus weicht keine der 985 Datumsangaben vom strengen Muster ab, die
 * beiden Fassungen waren also verhaltensgleich; der Zweitbegriff kostete
 * trotzdem die Zusage „eine SSoT pro fachlicher Frage".
 */
export const DE_DATE_RE = /^\d{1,2}\.\d{1,2}\.\d{2,4}$/;
const SIGN_TOKENS = new Set(["+", "-"]);

/**
 * Ist `yyyy-mm-dd` ein EXISTIERENDER Tag? SSoT fuer „darf darauf gebucht
 * werden".
 *
 * Form allein reicht nicht: `2026-13-32` passiert jedes Muster, und
 * `parseLocalDate` rollt es still zum 31.01.2027 durch — kein `Invalid Date`,
 * kein Laut, ein falsches `paid_at`.
 *
 * Die Funktion steht hier und nicht im Parser, weil sie ZWEI Aufrufer hat:
 * `toIsoDate` beim Import und `mark-paid` beim Buchen. Der Riegel dort prueft
 * einen Wert, der schon in der Datenbank steht — was `toIsoDate` heute
 * abweist, sagt nichts ueber das, was vor ihr geschrieben wurde. Zwei
 * Fassungen derselben Frage waeren genau der Zweitbegriff, an dem dieser
 * Vorgang mehrfach haengengeblieben ist.
 */
export function isValidIsoDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [j, m, t] = v.split("-").map(Number);
  const d = new Date(Date.UTC(j, m - 1, t));
  return d.getUTCFullYear() === j && d.getUTCMonth() === m - 1 && d.getUTCDate() === t;
}

/** Ist das Feld ein deutsch-formatierter Geldbetrag (und kein Datum)? */
export function isGermanAmountField(field: string): boolean {
  const v = field.trim();
  if (!GERMAN_AMOUNT_RE.test(v)) return false;
  if (DE_DATE_RE.test(v)) return false; // defensiv; ein Datum hat kein Komma
  return true;
}

/**
 * Ermittelt strukturell den Feld-Index des Betrags einer `2;`-Positionszeile:
 * genau EIN deutsch-formatiertes Dezimalfeld. Gibt es mehrere, wird das Feld
 * unmittelbar links von einem Vorzeichen (`+`/`-`) oder `EUR` bevorzugt.
 * Bleibt es mehrdeutig (0 oder ≥2 Kandidaten) → `-1` (Aufrufer entscheidet über
 * `AvisParseUncertainError`).
 */
export function detectAmountFieldIndex(parts: string[]): number {
  const candidates: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (isGermanAmountField(parts[i])) candidates.push(i);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const nextToSign = candidates.filter(i => {
      const next = (parts[i + 1] ?? "").trim().toUpperCase();
      return SIGN_TOKENS.has(next) || next === "EUR";
    });
    if (nextToSign.length === 1) return nextToSign[0];
  }
  return -1;
}

/**
 * Klassifiziert ein `1;`-Kassen-CSV rein kosmetisch nach primär Kostenträger-Name
 * (falls im Inhalt vorhanden), sekundär Dateiname. Ohne Signal → generisches
 * `kassen-csv` (die betragskorrekte Verarbeitung hängt NICHT vom Label ab).
 */
export function classifyKassenCsvFormat(input: {
  fileName?: string | null;
  kostentraegerName?: string | null;
}): AvisFormat {
  const haystack = `${input.kostentraegerName ?? ""} ${input.fileName ?? ""}`.toLowerCase();
  if (/aok/.test(haystack)) return "aok";
  if (/barmer/.test(haystack)) return "barmer";
  return "kassen-csv";
}

/**
 * Baut aus einer Beispiel-`2;`-Zeile einen Mapping-Vorschlag für den manuellen
 * Fallback: bester Betrags-Kandidat (links von Vorzeichen/EUR), erstes Feld mit
 * einer erkennbaren Rechnungsnummer, erstes dd.mm.yyyy-Datumsfeld.
 */
export function buildSuggestedColumnMap(parts: string[]): AvisColumnMap | null {
  let betrag = -1;
  const amountFields = parts.map((p, i) => (isGermanAmountField(p) ? i : -1)).filter(i => i >= 0);
  if (amountFields.length === 1) {
    betrag = amountFields[0];
  } else if (amountFields.length > 1) {
    const nextToSign = amountFields.find(i => {
      const next = (parts[i + 1] ?? "").trim().toUpperCase();
      return SIGN_TOKENS.has(next) || next === "EUR";
    });
    betrag = nextToSign ?? amountFields[0];
  }
  if (betrag < 0) return null;

  let referenz: number | null = null;
  for (let i = 0; i < parts.length; i++) {
    if (i === betrag) continue;
    if (extractInvoiceNumber(parts[i])) { referenz = i; break; }
  }
  let datum: number | null = null;
  for (let i = 0; i < parts.length; i++) {
    if (DE_DATE_RE.test(parts[i].trim())) { datum = i; break; }
  }
  return { betrag, referenz, datum };
}
