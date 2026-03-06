import type { InsertQontoTransaction } from "@shared/schema";

const STATUS_MAP: Record<string, string> = {
  "Abgerechnet": "completed",
  "In Bearbeitung": "pending",
  "Abgelehnt": "declined",
  "Storniert": "reversed",
};

function parseGermanDecimal(value: string): number {
  if (!value || !value.trim()) return 0;
  const cleaned = value.trim().replace(/\./g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function parseGermanDate(value: string): Date | null {
  if (!value || !value.trim()) return null;
  const match = value.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  return new Date(Date.UTC(
    parseInt(year), parseInt(month) - 1, parseInt(day),
    parseInt(hour), parseInt(minute), 0
  ));
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

export interface QontoCsvImportResult {
  transactions: InsertQontoTransaction[];
  skippedRows: number;
}

const COLUMN_ALIASES: Record<string, string[]> = {
  transactionId: ["Transaktions-ID", "Vorgang-ID", "Transaction ID"],
  status: ["Status"],
  emittedAt: ["Datum des Vorgangs (UTC)", "Datum des Vorgangs"],
  gesamtBetrag: ["Gesamtbetrag (inkl. MwSt.)", "Gesamtbetrag"],
  soll: ["Soll", "Debit"],
  haben: ["Haben", "Credit"],
  currency: ["Währung", "Currency"],
  counterpartyName: ["Name der Gegenpartei", "Counterparty name"],
  reference: ["Referenz", "Verwendungszweck/Referenz", "Reference"],
  category: ["Cashflow-Kategorie", "Analysekategorie", "Category"],
  paymentType: ["Zahlungsart", "Payment type"],
};

function findColumn(colIdx: Record<string, number>, aliases: string[]): number | undefined {
  for (const alias of aliases) {
    if (colIdx[alias] !== undefined) return colIdx[alias];
  }
  return undefined;
}

export function parseQontoCsv(csvContent: string): QontoCsvImportResult {
  const lines = csvContent.replace(/^\uFEFF/, "").trim().split("\n");
  if (lines.length < 2) throw new Error("CSV enthält keine Daten");

  const headerLine = lines[0];
  const columns = splitCsvLine(headerLine, ";").map(c => c.trim());

  const colIdx: Record<string, number> = {};
  columns.forEach((col, i) => { colIdx[col] = i; });

  const txIdCol = findColumn(colIdx, COLUMN_ALIASES.transactionId);
  if (txIdCol === undefined) {
    throw new Error(`Pflichtfeld "Transaktions-ID" nicht in CSV-Header gefunden. Ist dies eine Qonto-Exportdatei?`);
  }

  const colMap = {
    transactionId: txIdCol,
    status: findColumn(colIdx, COLUMN_ALIASES.status),
    emittedAt: findColumn(colIdx, COLUMN_ALIASES.emittedAt),
    gesamtBetrag: findColumn(colIdx, COLUMN_ALIASES.gesamtBetrag),
    soll: findColumn(colIdx, COLUMN_ALIASES.soll),
    haben: findColumn(colIdx, COLUMN_ALIASES.haben),
    currency: findColumn(colIdx, COLUMN_ALIASES.currency),
    counterpartyName: findColumn(colIdx, COLUMN_ALIASES.counterpartyName),
    reference: findColumn(colIdx, COLUMN_ALIASES.reference),
    category: findColumn(colIdx, COLUMN_ALIASES.category),
    paymentType: findColumn(colIdx, COLUMN_ALIASES.paymentType),
  };

  const getField = (row: string[], idx: number | undefined): string => {
    if (idx === undefined || idx >= row.length) return "";
    return row[idx]?.trim() || "";
  };

  const transactions: InsertQontoTransaction[] = [];
  let skippedRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const row = splitCsvLine(line, ";");
    const transactionId = getField(row, colMap.transactionId);
    if (!transactionId) {
      skippedRows++;
      continue;
    }

    const statusRaw = getField(row, colMap.status);
    const status = STATUS_MAP[statusRaw] || "completed";

    const emittedAtRaw = getField(row, colMap.emittedAt);
    const emittedAt = parseGermanDate(emittedAtRaw);
    if (!emittedAt) {
      skippedRows++;
      continue;
    }

    const habenValue = getField(row, colMap.haben);
    const sollValue = getField(row, colMap.soll);
    const side = (habenValue && parseGermanDecimal(habenValue) > 0) ? "credit" : "debit";

    const gesamtBetrag = parseGermanDecimal(getField(row, colMap.gesamtBetrag));
    const amountCents = Math.round(Math.abs(gesamtBetrag) * 100);

    if (amountCents === 0 && status === "pending") {
      skippedRows++;
      continue;
    }

    const counterpartyName = getField(row, colMap.counterpartyName) || null;
    const reference = getField(row, colMap.reference) || null;
    const category = getField(row, colMap.category);
    const paymentType = getField(row, colMap.paymentType);
    const label = category || paymentType || null;

    const rawData: Record<string, string> = {};
    columns.forEach((col, idx) => {
      if (idx < row.length && row[idx]?.trim()) {
        rawData[col] = row[idx].trim();
      }
    });

    transactions.push({
      qontoTransactionId: transactionId,
      amountCents,
      currency: getField(row, colMap.currency) || "EUR",
      side,
      counterpartyName,
      reference,
      label,
      emittedAt,
      status,
      rawData,
    });
  }

  if (transactions.length === 0) {
    throw new Error("Keine gültigen Transaktionen in der CSV-Datei gefunden");
  }

  return { transactions, skippedRows };
}
