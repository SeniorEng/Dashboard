/**
 * Task #1030 — SSoT für die Formatierung der Kunden-Stammadresse, wie sie auf
 * dem Leistungsnachweis ("Leistungsempfänger/in") und als Rechnungsempfänger
 * für Selbstzahler/Kostenerstattung erscheint.
 *
 * Bewusst identisch zur Inline-Formatierung in
 * `invoice-pdf-orchestrator.buildInvoicePdfData` (Kostenerstattungs-Override),
 * damit Render-Pfad und Daten-Korrektur denselben String erzeugen.
 */
export function formatCustomerMasterAddress(c: {
  strasse?: string | null;
  nr?: string | null;
  plz?: string | null;
  stadt?: string | null;
}): string | null {
  const line1 = [c.strasse, c.nr].filter(Boolean).join(" ");
  const line2 = c.plz || c.stadt ? `${c.plz || ""} ${c.stadt || ""}`.trim() : "";
  const addr = [line1, line2].filter(Boolean).join("\n");
  return addr.trim() ? addr : null;
}
