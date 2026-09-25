/**
 * § 4 Nr. 16 g UStG — die Rechnungstexte zur USt, aus EINER Quelle
 * (Ticket 6hcgffPJWm57p72p; Texte festgelegt von Alrik am 25.09.2026).
 *
 * PDF (`server/lib/pdf-generator.ts`) und E-Rechnung (`server/lib/zugferd.ts`,
 * BT-120 Befreiungsgrund) lesen dieselben Funktionen. ERSETZT die zwei fest
 * eingetragenen Formulierungen „Umsatzsteuerbefreit gem. § 4 Nr. 16 UStG" im
 * PDF-Summenblock und im ZUGFeRD-`exemptionReason`, die an der Zahlerart der
 * Rechnung hingen — für Bestandsrechnungen (Positionen ohne gespeicherten
 * Satz) bleiben sie unverändert, damit versiegelte Dokumente byte-gleich
 * neu dargestellt werden.
 */

/** Pflichthinweis bei steuerfreien Leistungen (§ 14 Abs. 4 Satz 1 Nr. 8 UStG). */
export const USTFREI_HINWEIS = "Umsatzsteuerfreie Leistungen gemäß § 4 Nr. 16 UStG.";

/** BT-120 — Befreiungsgrund in der E-Rechnung; derselbe Text wie im PDF. */
export const ZUGFERD_BEFREIUNGSGRUND = USTFREI_HINWEIS;

/** „1–3, 5" aus aufsteigenden Positionsnummern. */
function bereiche(nummern: number[]): string {
  const teile: string[] = [];
  let i = 0;
  while (i < nummern.length) {
    let j = i;
    while (j + 1 < nummern.length && nummern[j + 1] === nummern[j] + 1) j++;
    teile.push(j > i ? `${nummern[i]}–${nummern[j]}` : `${nummern[i]}`);
    i = j + 1;
  }
  return teile.join(", ");
}

/**
 * Hinweistext unter der Summe. Die Positionen in der DARGESTELLTEN
 * Reihenfolge (Nummer = Index + 1).
 *   · keine steuerfreie Position   → `null`
 *   · alle steuerfrei              → „Umsatzsteuerfreie Leistungen gemäß § 4 Nr. 16 UStG."
 *   · gemischt                     → „Pos. 1–3 sind umsatzsteuerfrei nach § 4 Nr. 16 UStG."
 */
export function ustfreiHinweis(positionen: ReadonlyArray<{ vatRateBp: number }>): string | null {
  const frei = positionen.map((p, i) => (p.vatRateBp === 0 ? i + 1 : 0)).filter((n) => n > 0);
  if (frei.length === 0) return null;
  if (frei.length === positionen.length) return USTFREI_HINWEIS;
  const einzahl = frei.length === 1;
  return `Pos. ${bereiche(frei)} ${einzahl ? "ist" : "sind"} umsatzsteuerfrei nach § 4 Nr. 16 UStG.`;
}

export interface PflegegradZeitraum {
  pflegegrad: number;
  /** Erster Leistungstag mit diesem Grad (YYYY-MM-DD). */
  von: string;
  /** Letzter Leistungstag mit diesem Grad (YYYY-MM-DD). */
  bis: string;
}

/**
 * Zeiträume gleichen Pflegegrads über die Leistungstage der Rechnung,
 * chronologisch. Tage ohne nachgewiesenen Grad trennen Zeiträume, erscheinen
 * aber nicht selbst. Grundlage sind die GESPEICHERTEN Positionen
 * (`pflegegradAmLeistungstag`), damit die Darstellung unverändert bleibt.
 */
export function pflegegradZeitraeume(
  positionen: ReadonlyArray<{ appointmentDate: string; pflegegradAmLeistungstag: number | null }>,
): PflegegradZeitraum[] {
  const tage = new Map<string, number | null>();
  for (const p of positionen) tage.set(p.appointmentDate, p.pflegegradAmLeistungstag);
  const sortiert = [...tage.entries()].sort(([a], [b]) => a.localeCompare(b));
  const out: PflegegradZeitraum[] = [];
  let offen: PflegegradZeitraum | null = null;
  for (const [tag, pg] of sortiert) {
    if (offen && pg === offen.pflegegrad) { offen.bis = tag; continue; }
    if (offen) out.push(offen);
    offen = pg == null ? null : { pflegegrad: pg, von: tag, bis: tag };
  }
  if (offen) out.push(offen);
  return out;
}

function tagMonat(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}.${m}.`;
}

/**
 * „Leistungsempfänger: Name (Pflegegrad N)" — gilt ein Grad an ALLEN
 * Leistungstagen. Sonst je Grad mit Zeitraum (Format Alrik, 25.09.2026):
 * „Leistungsempfänger: Name, Pflegegrad 2 (bis 14.10.), Pflegegrad 3 (ab 15.10.)".
 * Ohne nachgewiesenen Grad nur der Name. Die Daten sind der erste bzw. letzte
 * LEISTUNGSTAG im jeweiligen Grad; ein Grad, der mitten im Monat endet, zeigt
 * sein „bis", auch wenn danach kein Grad mehr folgt.
 */
export function leistungsempfaengerText(
  name: string,
  positionen: ReadonlyArray<{ appointmentDate: string; pflegegradAmLeistungstag: number | null }>,
): string {
  const zeitraeume = pflegegradZeitraeume(positionen);
  if (zeitraeume.length === 0) return `Leistungsempfänger: ${name}`;
  const tage = [...new Set(positionen.map((p) => p.appointmentDate))].sort();
  const erster = tage[0];
  const letzter = tage[tage.length - 1];
  if (zeitraeume.length === 1 && zeitraeume[0].von === erster && zeitraeume[0].bis === letzter) {
    return `Leistungsempfänger: ${name} (Pflegegrad ${zeitraeume[0].pflegegrad})`;
  }
  const teile = zeitraeume.map((z) => {
    const offenVorn = z.von === erster;
    const offenHinten = z.bis === letzter;
    const zeit = offenVorn ? `bis ${tagMonat(z.bis)}`
      : offenHinten ? `ab ${tagMonat(z.von)}`
      : `${tagMonat(z.von)}–${tagMonat(z.bis)}`;
    return `Pflegegrad ${z.pflegegrad} (${zeit})`;
  });
  return `Leistungsempfänger: ${name}, ${teile.join(", ")}`;
}
