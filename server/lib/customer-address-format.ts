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

/**
 * Task #1041 — EINZIGE Quelle für die LN-Adress-Korrektur. Der
 * Leistungsnachweis-„Leistungsempfänger/in" (= versorgter Patient,
 * `pdf-generator.ts`) rendert `pdfData.customerAddress`. `buildPdfData` bindet
 * `customerAddress` an `invoice.recipientAddress` — das ist für gesetzliche
 * Kassen OHNE Kostenerstattung die PFLEGEKASSEN-Anschrift und damit der falsche
 * „Patient-Wohnort". Beide Render-Pfade — der Persist-/Cache-/Bundle-Pfad
 * (`invoice-pdf-orchestrator.buildInvoicePdfData`) UND der On-Demand-Versand-Pfad
 * (`invoice-delivery.applyCustomerPdfRecipient`) — MÜSSEN dieselbe Korrektur
 * anwenden, sonst driften gecachtes und frisch gerendertes PDF wieder
 * auseinander (Bug-Klasse der Tasks #1032/#1034/#1036).
 *
 * WICHTIG: `customerAddress` fliesst NUR in den Leistungsnachweis, NICHT in das
 * Rechnungs-PDF/ZUGFeRD-XML — die byte-genaue GoBD-Integritätsprüfung der
 * Rechnung bleibt davon unberührt.
 *
 * Statt die Stammadresse an beiden Stellen unabhängig auf `pdfData` zu schreiben,
 * geht beides durch diese Funktion. Eine Verhaltensänderung MUSS hier passieren
 * und wirkt damit automatisch auf beide Pfade gleichzeitig.
 */
export function applyLeistungsnachweisCustomerAddress(
  pdfData: { customerAddress?: string | null },
  c: {
    strasse?: string | null;
    nr?: string | null;
    plz?: string | null;
    stadt?: string | null;
  },
): void {
  const lnMasterAddress = formatCustomerMasterAddress(c);
  if (lnMasterAddress) {
    pdfData.customerAddress = lnMasterAddress;
  }
}
