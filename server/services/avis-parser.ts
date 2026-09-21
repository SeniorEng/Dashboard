import {
  type AvisColumnMap,
  type AvisFormat,
  AvisParseUncertainError,
  buildSuggestedColumnMap,
  classifyKassenCsvFormat,
  detectAmountFieldIndex,
} from "../../shared/domain/qonto/avis-format";
import { extractInvoiceNumber, extractReInvoiceNumber } from "../../shared/domain/qonto/avis-match";

export { AvisParseUncertainError };
export type { AvisColumnMap };

interface ParsedAvisHeader {
  format: AvisFormat;
  avisNummer: string | null;
  belegNummer: string | null;
  gesamtBetragCents: number;
  zahlungsDatum: string | null;
  kostentraegerIk: string | null;
  kostentraegerName: string | null;
  zahlungsempfaengerIk: string | null;
  zahlungsempfaengerIban: string | null;
  skontoCents: number;
  kuerzungCents: number;
}

interface ParsedAvisItem {
  belegNr: string | null;
  vorgangsNr: string | null;
  rechnungsNummer: string | null;
  rechnungsDatum: string | null;
  verwendungszweck: string | null;
  betragCents: number;
  skontoCents: number;
  buchungsDatum: string | null;
}

/**
 * Die zwei unabhaengigen Zahlen der Datei — und ihre Differenz.
 *
 * ── Warum das der wichtigste Teil dieses Umbaus ist ─────────────────────
 * Beide Fehler vom 21.09.2026 (Faktor 100, Gesamtbetrag = Posten 1) waren
 * AUS DER DATEI SELBST erkennbar: die Postensumme haette nie zur
 * ausgewiesenen Summe gepasst. Ein Import, der zwei Zahlen bekommt und nur
 * eine liest, ist die eigentliche Luecke — der Faktor 100 war nur ihr
 * sichtbarstes Symptom.
 *
 * Gilt fuer BEIDE Familien: jede der 53 Kassen-Dateien traegt genau eine
 * `3;`-Summenzeile (gemessen), DAVASO traegt je Posten einen Zahlbetrag.
 */
interface AvisPruefsumme {
  /** Σ der Posten-Forderungen. */
  ausPostenCents: number;
  /** Die zweite, unabhaengig in der Datei stehende Zahl. `null` = keine gefunden. */
  ausgewiesenCents: number | null;
  /** Woher die zweite Zahl stammt — gehoert in die Vorschau, damit sie pruefbar ist. */
  quelle: string;
  /**
   * `ausPosten − Skonto − Kuerzung − ausgewiesen`. 0 heisst: die Datei ist in
   * sich stimmig. `null` = keine zweite Zahl, also nichts zu vergleichen —
   * und das ist ausdruecklich KEIN bestandener Vergleich.
   */
  abweichungCents: number | null;
}

interface ParsedAvis {
  header: ParsedAvisHeader;
  items: ParsedAvisItem[];
  pruefsumme: AvisPruefsumme;
}

/**
 * Die Differenz, gegen die der Import gatet.
 *
 * Skonto und Kuerzung sind legitime Gruende, warum die Postensumme NICHT dem
 * gezahlten Betrag entspricht — sie werden deshalb abgezogen, nicht ignoriert.
 * Was danach bleibt, ist unerklaert.
 */
function bildePruefsumme(
  items: ParsedAvisItem[],
  header: ParsedAvisHeader,
  ausgewiesenCents: number | null,
  quelle: string,
): AvisPruefsumme {
  const ausPostenCents = items.reduce((n, i) => n + i.betragCents, 0);
  const skonto = header.skontoCents + items.reduce((n, i) => n + i.skontoCents, 0);
  const abweichungCents = ausgewiesenCents === null
    ? null
    : ausPostenCents - skonto - header.kuerzungCents - ausgewiesenCents;
  return { ausPostenCents, ausgewiesenCents, quelle, abweichungCents };
}

export interface ParseAvisOptions {
  fileName?: string | null;
  /** Manuelles Spalten-Mapping als Fallback, wenn die strukturelle Betrags-
   * erkennung mehrdeutig ist (Feld-Indizes einer `2;`-Zeile). */
  columnMap?: AvisColumnMap | null;
}

/**
 * Welches Zeichen trennt die Nachkommastellen?
 *
 * Das ist KEINE Geschmacksfrage und auch nicht pro Wert zu raten: es haengt am
 * Dateiformat, und dort an einer Kopplung, der man nicht entkommt.
 *
 *   DAVASO   Header `LfdNr,…`  → KOMMA-getrennt → Dezimaltrennung ist der PUNKT
 *   Kassen   Zeilen `1;2;3;`   → SEMIKOLON     → Dezimaltrennung ist das KOMMA
 *
 * Eine komma-getrennte CSV kann keine unquotierten deutschen Dezimalkommas
 * tragen — jedes Feld zerfiele. Das Trennzeichen legt die Konvention fest.
 *
 * Gemessen am 21.09.2026 ueber 85 Dateien: DAVASO 492 Betraege mit Punkt und
 * 0 mit Komma, Kassen-CSV 0 mit Punkt und 474 mit Komma. Sauber getrennt,
 * keine Mischung.
 */
export type Dezimalkonvention = "punkt" | "komma";

/**
 * Betrag in Cent — mit AUSDRUECKLICHER Konvention.
 *
 * ERSETZT `parseEuroCents`, das die deutsche Konvention global annahm: es
 * strich JEDEN Punkt als Tausendertrenner. Gegen eine DAVASO-Datei las es
 * `70.00` als 7000 Euro und speicherte 700.000 Cent — **Faktor genau 100**,
 * immer, weil zwei Nachkommastellen hochrutschen.
 *
 * Belegt an zwei Prod-Avisen (ICL01278/ICL01290, 21.09.2026): jeder einzelne
 * Posten exakt x100, und die Differenz zur Rechnungssumme centgenau die
 * angezeigte „Ueberzahlung" (28.149,66 € bzw. 56.960,64 €).
 *
 * **Die Konvention wird uebergeben, nicht erraten.** Eine Heuristik pro Wert
 * kann `1.234` nicht entscheiden — deutsche Tausender oder 1,234 mit Punkt? —
 * und genau diese Mehrdeutigkeit hat den Fehler ermoeglicht.
 */
export function parseBetragCents(value: string, konvention: Dezimalkonvention): number {
  const roh = value.trim().replace(/\s/g, "").replace(/€/g, "");
  if (!roh) return 0;
  const cleaned = konvention === "komma"
    // deutsch: Punkte sind Tausendertrenner, das Komma trennt die Nachkommastellen
    ? roh.replace(/\./g, "").replace(",", ".")
    // englisch: Kommas sind Tausendertrenner, der Punkt trennt die Nachkommastellen
    : roh.replace(/,/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

function detectDelimiter(headerLine: string): string {
  const semicolons = (headerLine.match(/;/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;
  return semicolons > commas ? ";" : ",";
}

/** Rohformat: `davaso` (Header `LfdNr,…`) vs. `1;`-Kassen-Familie vs. unbekannt. */
function detectRawFormat(csvContent: string): "davaso" | "kassen" | null {
  const firstLine = csvContent.replace(/^\uFEFF/, "").trim().split("\n")[0].trim();
  if (firstLine.startsWith("LfdNr,") || firstLine.startsWith("LfdNr;")) {
    return "davaso";
  }
  if (/^\uFEFF?\s*1;/.test(firstLine)) {
    return "kassen";
  }
  return null;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === delimiter && !inQuotes) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return raw;
}

function parseDavaso(csvContent: string): ParsedAvis {
  const lines = csvContent.replace(/^\uFEFF/, "").trim().split("\n");
  if (lines.length < 2) throw new Error("CSV enthält keine Daten");

  const headerLine = lines[0];
  const delimiter = detectDelimiter(headerLine);
  const columns = headerLine.split(delimiter).map(c => c.trim());

  const colIdx: Record<string, number> = {};
  columns.forEach((col, i) => { colIdx[col] = i; });

  const getField = (row: string[], col: string): string => {
    const idx = colIdx[col];
    if (idx === undefined || idx >= row.length) return "";
    return row[idx]?.trim() || "";
  };

  const dataRows = lines.slice(1).filter(l => l.trim()).map(l => splitCsvLine(l, delimiter));

  const headerData: ParsedAvisHeader = {
    format: "davaso",
    avisNummer: null,
    belegNummer: null,
    gesamtBetragCents: 0,
    zahlungsDatum: null,
    kostentraegerIk: null,
    kostentraegerName: null,
    zahlungsempfaengerIk: null,
    zahlungsempfaengerIban: null,
    skontoCents: 0,
    kuerzungCents: 0,
  };

  const items: ParsedAvisItem[] = [];

  /**
   * Die Summenzeile erkennt man an dem, was sie NICHT hat: eine Belegnummer.
   *
   * ── Warum nicht „erste Zeile mit gefuelltem KTR_BTR_Zahlg" ──────────────
   * Das stand hier vorher und traegt nur, solange die Spalte auf den
   * Postenzeilen leer ist. Am 21.09.2026 kamen zwei Prod-Dateien, bei denen
   * `gesamt_betrag_cents` exakt dem ERSTEN POSTEN entsprach — dort war die
   * Spalte offenbar je Zeile gefuellt, und „die erste" war Posten 1.
   *
   * `ZEM_BelegNr` ist das strukturelle Merkmal: die Summenzeile hat keine
   * (siehe den Regressions-Fixture `IKK_DAVASO`), jede Postenzeile hat eine —
   * dieselbe Bedingung, nach der unten die Posten gesammelt werden. Findet
   * sich keine solche Zeile, gibt es keine zweite Zahl, und der Riegel im
   * Import lehnt ab. Das ist der gewollte Ausgang: lieber eine Ablehnung als
   * eine Summe aus der falschen Zeile.
   */
  const summaryRow = dataRows.find(r => !getField(r, "ZEM_BelegNr") && getField(r, "KTR_BTR_Zahlg"));

  /**
   * Die Kopfzeile ist NICHT dasselbe wie die Summenzeile — zwei Fragen, die
   * ich zuerst vermischt hatte.
   *
   * „Woher kommen AVISNr, IK, IBAN, Zahlungsdatum?" beantwortet in DAVASO
   * JEDE Zeile gleich: die Felder wiederholen sich zeilenweise. „Woher kommt
   * die ausgewiesene Summe?" beantwortet nur die Summenzeile — und die gibt es
   * nicht in jeder Datei.
   *
   * Wer beides an `summaryRow` haengt, verliert bei einer Datei ohne
   * Summenzeile auch noch den Kopf: Avis-Nummer, Kostentraeger und
   * Zahlungsdatum waeren still `null`. Deshalb faellt der Kopf auf die erste
   * Datenzeile zurueck, die Summe nicht.
   */
  const kopfZeile = summaryRow ?? dataRows[0];

  if (kopfZeile) {
    headerData.avisNummer = getField(kopfZeile, "AVISNr") || null;
    headerData.kostentraegerIk = getField(kopfZeile, "KTR_IK") || null;
    headerData.kostentraegerName = getField(kopfZeile, "KTR_Name") || null;
    headerData.zahlungsempfaengerIk = getField(kopfZeile, "ZEM_IK") || null;
    headerData.zahlungsempfaengerIban = getField(kopfZeile, "ZEM_IBAN") || null;
    headerData.zahlungsDatum = toIsoDate(getField(kopfZeile, "Datum_ZahlungAusfuehrg") || null);
  }

  // Skonto und Kuerzung sind datei-weite Abzuege und stehen deshalb NUR auf der
  // Summenzeile. Von einer Postenzeile gelesen waeren es die des ersten Postens
  // — ein Abzug, der faelschlich fuer die ganze Datei gilt.
  if (summaryRow) {
    headerData.skontoCents = parseBetragCents(getField(summaryRow, "KTR_BTR_Skonto"), "punkt");
    headerData.kuerzungCents = parseBetragCents(getField(summaryRow, "KTR_BTR_DTA_Kuerzg"), "punkt");
  }

  for (const row of dataRows) {
    const belegNr = getField(row, "ZEM_BelegNr");
    if (!belegNr) continue;

    items.push({
      belegNr,
      vorgangsNr: getField(row, "ZEM_VorgangsNr") || null,
      rechnungsNummer: getField(row, "ZEM_RecNr") || null,
      rechnungsDatum: toIsoDate(getField(row, "ZEM_RecDatum") || null),
      verwendungszweck: null,
      betragCents: parseBetragCents(getField(row, "ZEM_BTR_Forderg"), "punkt"),
      skontoCents: parseBetragCents(getField(row, "KTR_BTR_Skonto"), "punkt"),
      buchungsDatum: null,
    });
  }

  if (items.length === 0 && summaryRow) {
    items.push({
      belegNr: null,
      vorgangsNr: getField(summaryRow, "ZEM_VorgangsNr") || null,
      rechnungsNummer: getField(summaryRow, "ZEM_RecNr") || null,
      rechnungsDatum: headerData.zahlungsDatum,
      verwendungszweck: null,
      betragCents: headerData.gesamtBetragCents,
      skontoCents: headerData.skontoCents,
      buchungsDatum: null,
    });
  }

  // Der Gesamtbetrag kommt aus den POSTEN, nicht aus einem Feld.
  //
  // Vorher stand hier `KTR_BTR_Zahlg` aus der ersten Zeile, in der die Spalte
  // gefuellt ist — in den echten Dateien ist sie in JEDER Zeile gefuellt, also
  // war die „Summenzeile" schlicht Posten 1. Gemessen an Avis 24/25 vom
  // 21.09.2026: gespeichert waren 700.000 bzw. 1.168.400 — jeweils exakt der
  // Betrag des ersten Postens.
  //
  // Das war kein Rechenfehler, sondern eine falsche Annahme ueber den
  // Dateiaufbau. Eine Summe leitet man nicht aus einer Zeile ab.
  headerData.gesamtBetragCents = items.reduce((n, i) => n + i.betragCents, 0);

  /**
   * Die zweite, unabhaengige Zahl — und es gibt ZWEI belegte DAVASO-Praegungen,
   * die sie an verschiedenen Stellen fuehren:
   *
   *  (a) mit Summenzeile: `IKK_Classic_Avis_ICL01159` (woertliche Kopie im
   *      Regressionstest) — Zeile 1 ohne `ZEM_BelegNr` traegt 692.12 in
   *      `KTR_BTR_Zahlg`, die Postenzeilen lassen die Spalte LEER.
   *
   *  (b) ohne Summenzeile: die beiden Dateien von Avis 24/25 — dort stand in
   *      der ersten gefundenen `KTR_BTR_Zahlg` der Betrag von Posten 1
   *      (700.000 Cent bei vier Posten von zusammen 284,34 EUR). Das geht nur,
   *      wenn die Spalte je Postenzeile gefuellt ist.
   *
   * Das ist EINE fachliche Frage („was weist die Datei als gezahlt aus?"),
   * beantwortet aus der Spalte, die sie traegt — kein Zweitbegriff. Die
   * Reihenfolge ist nicht beliebig: die Summenzeile gewinnt, weil sie die
   * Aussage der Datei ist; die Postensumme ist die Rekonstruktion daraus.
   *
   * Findet sich keine von beiden, bleibt es `null` — und der Import lehnt ab.
   * „Nicht vergleichbar" ist kein bestandener Vergleich.
   *
   * `quelle` sagt, WELCHER Weg gegriffen hat. Die Vorschau zeigt das an: ein
   * gruenes Ergebnis ohne sichtbaren Vergleich gilt nicht als bestanden.
   */
  const summeZahlbetraege = dataRows
    .filter(r => getField(r, "ZEM_BelegNr"))
    .reduce((n, r) => n + parseBetragCents(getField(r, "KTR_BTR_Zahlg"), "punkt"), 0);

  const ausgewiesen = summaryRow
    ? parseBetragCents(getField(summaryRow, "KTR_BTR_Zahlg"), "punkt")
    : (summeZahlbetraege > 0 ? summeZahlbetraege : null);

  const quelle = summaryRow
    ? "Summenzeile (Zeile ohne ZEM_BelegNr), Spalte KTR_BTR_Zahlg"
    : "Summe der Spalte KTR_BTR_Zahlg ueber alle Postenzeilen";

  return {
    header: headerData,
    items,
    pruefsumme: bildePruefsumme(items, headerData, ausgewiesen, quelle),
  };
}

/**
 * Parser der `1;`-Kassen-Familie (AOK-Plus, Barmer & Co.). Zeilentypen:
 *  - `1;<Zahlungsempfänger-IK>;<Name/Anschrift>;`
 *  - `2;<Referenz/Verwendungszweck>;…;<Betrag>;<+/->;EUR;` → Betrag STRUKTURELL erkannt
 *  - `3;<Belegnummer>;<Zahlungsdatum>;<Gesamtbetrag>;<Empfänger-IBAN>;`
 *
 * Der Betrag wird nicht mehr an einem festen Feld-Index angenommen, sondern über
 * `detectAmountFieldIndex` ermittelt. Ist er mehrdeutig und liegt kein manuelles
 * `columnMap` vor, wird `AvisParseUncertainError` geworfen (⇒ Mapping-Dialog).
 */
function parseKassenCsv(csvContent: string, options?: ParseAvisOptions): ParsedAvis {
  const lines = csvContent.trim().split("\n").map(l => l.replace(/^\uFEFF/, "").trim()).filter(l => l);

  const headerData: ParsedAvisHeader = {
    format: "kassen-csv",
    avisNummer: null,
    belegNummer: null,
    gesamtBetragCents: 0,
    zahlungsDatum: null,
    kostentraegerIk: null,
    kostentraegerName: null,
    zahlungsempfaengerIk: null,
    zahlungsempfaengerIban: null,
    skontoCents: 0,
    kuerzungCents: 0,
  };

  const items: ParsedAvisItem[] = [];
  const columnMap = options?.columnMap ?? null;
  // „keine Summenzeile gefunden" und „Summenzeile sagt 0" sind zwei
  // verschiedene Dinge — nur das erste heisst „nichts zu vergleichen".
  let gesamtbetragGefunden = false;

  for (const line of lines) {
    const parts = line.split(";").map(p => p.trim());
    const lineType = parts[0];

    if (lineType === "1") {
      headerData.zahlungsempfaengerIk = parts[1] || null;
    } else if (lineType === "2") {
      let betragIdx: number;
      if (columnMap) {
        betragIdx = columnMap.betrag;
      } else {
        betragIdx = detectAmountFieldIndex(parts);
        if (betragIdx < 0) {
          const preview = lines
            .filter(l => l.startsWith("2;"))
            .slice(0, 5)
            .map(l => l.split(";").map(p => p.trim()));
          throw new AvisParseUncertainError(
            "Betrags-Feld konnte nicht eindeutig erkannt werden. Bitte Spalten manuell zuordnen.",
            preview,
            buildSuggestedColumnMap(parts),
          );
        }
      }

      const betragCents = parseBetragCents(parts[betragIdx] ?? "0", "komma");

      const verwendungszweck = parts[1] || null;
      const refFieldIdx = columnMap?.referenz ?? 2;
      const datumIdx = columnMap?.datum ?? 3;

      // Die kanonische RE-Rechnungsnummer hat Vorrang und darf in JEDEM Feld der
      // Zeile stehen — manche Kassen legen sie neben das Buchungsdatum statt in
      // die Referenzspalte. Erst danach die feldbasierte Heuristik; deren
      // Ziffern-Fallback würde sonst die lange Kassen-Belegnummer greifen und die
      // echte Rechnungsnummer verdecken (⇒ Matching fiele still auf den Betrag
      // zurück und scheiterte bei Teilzahlungen/mehrdeutigen Beträgen).
      let rechnungsNummer = extractReInvoiceNumber(line);
      if (!rechnungsNummer) {
        rechnungsNummer = extractInvoiceNumber(parts[refFieldIdx] ?? "");
      }
      if (!rechnungsNummer) {
        rechnungsNummer = extractInvoiceNumber(verwendungszweck);
      }

      items.push({
        belegNr: null,
        vorgangsNr: null,
        rechnungsNummer,
        rechnungsDatum: null,
        verwendungszweck,
        betragCents,
        skontoCents: 0,
        buchungsDatum: parts[datumIdx] || null,
      });
    } else if (lineType === "3") {
      headerData.belegNummer = parts[1] || null;
      headerData.zahlungsDatum = toIsoDate(parts[2] || null);
      headerData.gesamtBetragCents = parseBetragCents(parts[3] || "0", "komma");
      gesamtbetragGefunden = true;
      headerData.zahlungsempfaengerIban = parts[4] || null;
    }
  }

  headerData.format = classifyKassenCsvFormat({
    fileName: options?.fileName,
    kostentraegerName: headerData.kostentraegerName,
  });

  // Jede der 53 gemessenen Kassen-Dateien traegt genau eine `3;`-Zeile. Ihr
  // Gesamtbetrag ist die zweite, unabhaengige Zahl — und sie faengt hier, was
  // der Betrags-Detektor per Konstruktion nicht kann: einen FELDVERSATZ. Bei
  // 7, 8, 9 und 13 Feldern in `2;`-Zeilen ist der keine Randmoeglichkeit.
  const ausgewiesen = gesamtbetragGefunden ? headerData.gesamtBetragCents : null;

  return {
    header: headerData,
    items,
    pruefsumme: bildePruefsumme(items, headerData, ausgewiesen, "Summenzeile 3;"),
  };
}

export function parseAvisCsv(csvContent: string, options?: ParseAvisOptions): ParsedAvis {
  const format = detectRawFormat(csvContent);
  if (!format) {
    throw new Error("CSV-Format nicht erkannt. Unterstützt: DAVASO (Header 'LfdNr,...') und Kassen-CSV (Zeilentypen 1/2/3 mit Semikolon).");
  }
  if (format === "davaso") return parseDavaso(csvContent);
  return parseKassenCsv(csvContent, options);
}
