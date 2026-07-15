export const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export const STATUS_LABELS: Record<string, string> = {
  entwurf: "Entwurf",
  versendet: "Versendet",
  avis_erhalten: "Avis erhalten",
  bezahlt: "Bezahlt",
  storniert: "Storniert",
};

export const STATUS_COLORS: Record<string, string> = {
  entwurf: "bg-amber-50 text-amber-700 border-amber-200",
  versendet: "bg-blue-50 text-blue-700 border-blue-200",
  avis_erhalten: "bg-purple-50 text-purple-700 border-purple-200",
  bezahlt: "bg-green-50 text-green-700 border-green-200",
  storniert: "bg-red-50 text-red-700 border-red-200",
};

// Abrechnungstyp eines Kunden lesbar machen (Selbstzahler / Pflegekasse).
export const BILLING_TYPE_LABELS: Record<string, string> = {
  selbstzahler: "Selbstzahler",
  pflegekasse_gesetzlich: "Pflegekasse (gesetzlich)",
  pflegekasse_privat: "Pflegekasse (privat)",
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

// Task #1412: Aging-Ampel-Badge für die „Avis ausstehend"- und „Zahlung
// ausstehend"-Gruppen. `green`/`none` erhalten KEIN Badge (alles im Plan); nur
// die mahnenden Stufen werden sichtbar hervorgehoben. Quelle der Einstufung ist
// `resolveAgingBucket` (shared) — hier nur die Darstellung.
export const AGING_BADGE: Record<"yellow" | "orange" | "red", { label: string; className: string }> = {
  yellow: { label: "Nachhaken", className: "bg-amber-50 text-amber-700 border-amber-200" },
  orange: { label: "Überfällig", className: "bg-orange-50 text-orange-700 border-orange-200" },
  red: { label: "Stark überfällig", className: "bg-red-50 text-red-700 border-red-200" },
};
