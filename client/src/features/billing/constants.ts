export const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export const STATUS_LABELS: Record<string, string> = {
  entwurf: "Entwurf",
  versendet: "Versendet",
  bezahlt: "Bezahlt",
  storniert: "Storniert",
};

export const STATUS_COLORS: Record<string, string> = {
  entwurf: "bg-amber-50 text-amber-700 border-amber-200",
  versendet: "bg-blue-50 text-blue-700 border-blue-200",
  bezahlt: "bg-green-50 text-green-700 border-green-200",
  storniert: "bg-red-50 text-red-700 border-red-200",
};

// Task #585: "nachberechnung" wurde abgeschafft — historische Zeilen werden
// einheitlich als "Rechnung" angezeigt.
export const TYPE_LABELS: Record<string, string> = {
  rechnung: "Rechnung",
  stornorechnung: "Stornorechnung",
  nachberechnung: "Rechnung",
};

export const TYPE_COLORS: Record<string, string> = {
  rechnung: "bg-teal-50 text-teal-700 border-teal-200",
  stornorechnung: "bg-red-50 text-red-700 border-red-200",
  nachberechnung: "bg-teal-50 text-teal-700 border-teal-200",
};

// Task #546: PDF-Persistierung läuft im Hintergrund (siehe Task #544). Ist nach
// PDF_PENDING_THRESHOLD_MS noch kein `pdfPath` gesetzt, gehen wir von einem
// Fehler aus und zeigen einen roten Hinweis-Badge.
export const PDF_PENDING_THRESHOLD_MS = 5 * 60 * 1000;
