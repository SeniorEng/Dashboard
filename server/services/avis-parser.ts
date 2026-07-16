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

interface ParsedAvis {
  header: ParsedAvisHeader;
  items: ParsedAvisItem[];
}

export interface ParseAvisOptions {
  fileName?: string | null;
  /** Manuelles Spalten-Mapping als Fallback, wenn die strukturelle Betrags-
   * erkennung mehrdeutig ist (Feld-Indizes einer `2;`-Zeile). */
  columnMap?: AvisColumnMap | null;
}

function parseEuroCents(value: string): number {
  const cleaned = value.trim().replace(/\s/g, "").replace(/€/g, "").replace(/\./g, "").replace(",", ".");
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

  const summaryRow = dataRows.find(r => {
    const zahlg = getField(r, "KTR_BTR_Zahlg");
    return zahlg && zahlg !== "";
  });

  if (summaryRow) {
    headerData.avisNummer = getField(summaryRow, "AVISNr") || null;
    headerData.gesamtBetragCents = parseEuroCents(getField(summaryRow, "KTR_BTR_Zahlg"));
    headerData.kostentraegerIk = getField(summaryRow, "KTR_IK") || null;
    headerData.kostentraegerName = getField(summaryRow, "KTR_Name") || null;
    headerData.zahlungsempfaengerIk = getField(summaryRow, "ZEM_IK") || null;
    headerData.zahlungsempfaengerIban = getField(summaryRow, "ZEM_IBAN") || null;
    headerData.skontoCents = parseEuroCents(getField(summaryRow, "KTR_BTR_Skonto"));
    headerData.kuerzungCents = parseEuroCents(getField(summaryRow, "KTR_BTR_DTA_Kuerzg"));
    headerData.zahlungsDatum = toIsoDate(getField(summaryRow, "Datum_ZahlungAusfuehrg") || null);
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
      betragCents: parseEuroCents(getField(row, "ZEM_BTR_Forderg")),
      skontoCents: parseEuroCents(getField(row, "KTR_BTR_Skonto")),
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

  return { header: headerData, items };
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

      const betragCents = parseEuroCents(parts[betragIdx] ?? "0");

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
      headerData.gesamtBetragCents = parseEuroCents(parts[3] || "0");
      headerData.zahlungsempfaengerIban = parts[4] || null;
    }
  }

  headerData.format = classifyKassenCsvFormat({
    fileName: options?.fileName,
    kostentraegerName: headerData.kostentraegerName,
  });

  return { header: headerData, items };
}

export function parseAvisCsv(csvContent: string, options?: ParseAvisOptions): ParsedAvis {
  const format = detectRawFormat(csvContent);
  if (!format) {
    throw new Error("CSV-Format nicht erkannt. Unterstützt: DAVASO (Header 'LfdNr,...') und Kassen-CSV (Zeilentypen 1/2/3 mit Semikolon).");
  }
  if (format === "davaso") return parseDavaso(csvContent);
  return parseKassenCsv(csvContent, options);
}
