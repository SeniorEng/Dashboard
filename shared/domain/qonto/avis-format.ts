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

// Deutsch formatierter Geldbetrag: 49,13 · 1.234,56 · -70,00 (Komma zwingend).
const GERMAN_AMOUNT_RE = /^-?\d{1,3}(\.\d{3})*,\d{2}$/;
// dd.mm.yyyy (auch dd.mm.yy) — als Datum ausgeschlossen.
const DE_DATE_RE = /^\d{1,2}\.\d{1,2}\.\d{2,4}$/;
const SIGN_TOKENS = new Set(["+", "-"]);

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
