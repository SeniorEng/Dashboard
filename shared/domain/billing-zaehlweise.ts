/**
 * Ticket 6hWgVqw2C8442hcG — was zählt eigentlich welche Ansicht?
 *
 * ── Warum es diese Datei gibt ────────────────────────────────────────────
 * Am 17.09.2026 standen in der Abrechnung vier verschiedene Beträge für zwei
 * Fälle: die Umsatz-Kachel zeigte 57,00 € und 57,00 €, die Karte „Noch zu
 * erstellen" 57,95 € und 89,86 €. **Keine der Zahlen war falsch.** Sie
 * beantworten verschiedene Fragen — in vier Dimensionen gleichzeitig:
 *
 *   |             | Umsatz-Kachel            | Noch zu erstellen              |
 *   |-------------|--------------------------|--------------------------------|
 *   | Einheit     | je Termin bzw. Rechnung  | je Kunde                       |
 *   | Umfang      | eine Stufe               | alle Termine des Kunden        |
 *   | Kilometer   | frühe Stufen ohne        | enthalten                      |
 *   | Basis       | netto                    | brutto                         |
 *   | Zeitraum    | dokumentiert (Ist)       | Ist UND geplant                |
 *
 * Alrik hat entschieden: **sichtbar machen statt angleichen** (Weg 3). Beide
 * Ansichten bleiben, wie sie sind — was dazukommt, ist die Auskunft, was jede
 * von beiden zählt.
 *
 * ── Warum die zwei Sätze HIER stehen und nicht je in ihrer Komponente ────
 * Weil sie ein PAAR sind. Ihr ganzer Zweck ist der Moment, in dem jemand zwei
 * Zahlen vergleicht — und ein Paar, das an zwei Orten gepflegt wird, driftet
 * auseinander. Dann hätten wir dasselbe Problem eine Ebene höher: zwei
 * Erklärungen, die sich widersprechen. Dieselbe Begründung wie bei den
 * Stufen-Beschriftungen (`PIPELINE_STAGE_LABELS`): ein Begriff, eine Quelle.
 *
 * ── Fachlich, nicht technisch ────────────────────────────────────────────
 * Kein `unit_type = 'hours'`, kein `grossAmountCents`. Wer das liest, arbeitet
 * mit Rechnungen, nicht mit dem Schema.
 */

/**
 * Zählweise der Umsatz-Kachel (Kaskade + Kosten-Tabelle).
 *
 * BEWUSST NICHT „je Termin, netto, ohne km", obwohl das der naheliegende Satz
 * wäre: „ohne km" gilt nur für die frühen Stufen. Sobald abgerechnet ist,
 * trägt die Stufe den vollen Rechnungs-Netto INKLUSIVE km-Positionen (der
 * km-Sprung an der Hybrid-Kante, offen als eigenes Ticket). Ein Hinweis, der
 * für die Hälfte der Zeilen nicht stimmt, ist schlimmer als keiner — genau
 * dieselbe Falle wie die frühere Kopfzeile „(Leistungen)", die „ohne km"
 * meinte und es nur für drei von sechs Stufen war.
 *
 * Der Satz nennt die Grenze deshalb mit: wo die Einheit wechselt, wechselt
 * auch, ob km drinstecken.
 */
export const ZAEHLWEISE_UMSATZ_KACHEL =
  "je Termin ohne km, ab „gestellt“ je Rechnung mit km — immer netto";

/**
 * Zählweise der Karte „Noch zu erstellen" (Rechnungen-Tab).
 *
 * Hier stimmen alle drei Zusätze ohne Einschränkung: die Gruppierung ist
 * kundenweise (`classifyBillingMaturity`), der Betrag kommt aus dem vollen
 * Rechnungs-Entwurf (`grossAmountCents`, also mit km und mit USt) und enthält
 * neben dem Ist auch die noch geplanten Termine des Monats.
 */
export const ZAEHLWEISE_RECHNUNGSLISTE =
  "je Kunde, brutto, mit km und geplanten Terminen";
