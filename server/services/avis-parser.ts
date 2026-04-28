interface ParsedAvisHeader {
  format: "davaso" | "barmer";
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

function parseEuroCents(value: string): number {
  const cleaned = value.trim().replace(/\s/g, "").replace(/€/g, "").replace(/\./g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

function extractInvoiceNumber(text: string): string | null {
  const reMatch = text.match(/RE-\d{4}-\d+/);
  if (reMatch) return reMatch[0];

  const numMatch = text.match(/\b(\d{6,})\b/);
  if (numMatch) return numMatch[1];

  return null;
}

function detectDelimiter(headerLine: string): string {
  const semicolons = (headerLine.match(/;/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;
  return semicolons > commas ? ";" : ",";
}

function detectFormat(csvContent: string): "davaso" | "barmer" | null {
  const firstLine = csvContent.replace(/^\uFEFF/, "").trim().split("\n")[0].trim();
  if (firstLine.startsWith("LfdNr,") || firstLine.startsWith("LfdNr;")) {
    return "davaso";
  }
  if (/^\s*1;/.test(firstLine) || /^\uFEFF?\s*1;/.test(firstLine)) {
    return "barmer";
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

  let headerData: ParsedAvisHeader = {
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

    const datumRaw = getField(summaryRow, "Datum_ZahlungAusfuehrg");
    if (datumRaw) {
      const parts = datumRaw.split(".");
      if (parts.length === 3) {
        headerData.zahlungsDatum = `${parts[2]}-${parts[1]}-${parts[0]}`;
      } else {
        headerData.zahlungsDatum = datumRaw;
      }
    }
  }

  for (const row of dataRows) {
    const belegNr = getField(row, "ZEM_BelegNr");
    if (!belegNr) continue;

    const rechnungsNummer = getField(row, "ZEM_RecNr") || null;

    const recDatumRaw = getField(row, "ZEM_RecDatum");
    let rechnungsDatum: string | null = null;
    if (recDatumRaw) {
      const parts = recDatumRaw.split(".");
      if (parts.length === 3) {
        rechnungsDatum = `${parts[2]}-${parts[1]}-${parts[0]}`;
      } else {
        rechnungsDatum = recDatumRaw;
      }
    }

    items.push({
      belegNr,
      vorgangsNr: getField(row, "ZEM_VorgangsNr") || null,
      rechnungsNummer,
      rechnungsDatum,
      verwendungszweck: null,
      betragCents: parseEuroCents(getField(row, "ZEM_BTR_Forderg")),
      skontoCents: parseEuroCents(getField(row, "KTR_BTR_Skonto")),
      buchungsDatum: null,
    });
  }

  if (items.length === 0 && summaryRow) {
    const rechnungsNummer = getField(summaryRow, "ZEM_RecNr") || null;
    items.push({
      belegNr: null,
      vorgangsNr: getField(summaryRow, "ZEM_VorgangsNr") || null,
      rechnungsNummer,
      rechnungsDatum: headerData.zahlungsDatum,
      verwendungszweck: null,
      betragCents: headerData.gesamtBetragCents,
      skontoCents: headerData.skontoCents,
      buchungsDatum: null,
    });
  }

  return { header: headerData, items };
}

function parseBarmer(csvContent: string): ParsedAvis {
  const lines = csvContent.trim().split("\n").map(l => l.replace(/^\uFEFF/, "").trim()).filter(l => l);

  let headerData: ParsedAvisHeader = {
    format: "barmer",
    avisNummer: null,
    belegNummer: null,
    gesamtBetragCents: 0,
    zahlungsDatum: null,
    kostentraegerIk: null,
    kostentraegerName: "BARMER",
    zahlungsempfaengerIk: null,
    zahlungsempfaengerIban: null,
    skontoCents: 0,
    kuerzungCents: 0,
  };

  const items: ParsedAvisItem[] = [];

  for (const line of lines) {
    const parts = line.split(";").map(p => p.trim());
    const lineType = parts[0];

    if (lineType === "1") {
      headerData.zahlungsempfaengerIk = parts[1] || null;
    } else if (lineType === "2") {
      const verwendungszweck = parts[1] || null;
      const refField = parts[2] || "";
      const buchungsDatum = parts[3] || null;
      const betragStr = parts[4] || "0";
      const betragCents = parseEuroCents(betragStr);

      let rechnungsNummer = extractInvoiceNumber(refField);
      if (!rechnungsNummer && verwendungszweck) {
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
        buchungsDatum,
      });
    } else if (lineType === "3") {
      headerData.belegNummer = parts[1] || null;
      const datumRaw = parts[2] || null;
      if (datumRaw) {
        const dotParts = datumRaw.split(".");
        if (dotParts.length === 3) {
          headerData.zahlungsDatum = `${dotParts[2]}-${dotParts[1]}-${dotParts[0]}`;
        } else {
          headerData.zahlungsDatum = datumRaw;
        }
      }
      headerData.gesamtBetragCents = parseEuroCents(parts[3] || "0");
      headerData.zahlungsempfaengerIban = parts[4] || null;
    }
  }

  return { header: headerData, items };
}

export function parseAvisCsv(csvContent: string): ParsedAvis {
  const format = detectFormat(csvContent);
  if (!format) {
    throw new Error("CSV-Format nicht erkannt. Unterstützt: DAVASO (mit Header 'LfdNr,...') und Barmer (Zeilentypen 1/2/3 mit Semikolon).");
  }
  if (format === "davaso") return parseDavaso(csvContent);
  return parseBarmer(csvContent);
}
