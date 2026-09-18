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
 *   | Umfang I    | eine Stufe               | alle Termine des Kunden        |
 *   | Kilometer   | frühe Stufen ohne        | enthalten                      |
 *   | Basis       | netto                    | brutto                         |
 *
 * NICHT in der Liste, obwohl es naheliegt: „geplante Termine". Beide Ansichten
 * enthalten sie — die Kaskade in der Stufe „noch geplant", die Liste im
 * PLAN-Anteil. Eine erste Fassung dieser Tabelle nannte das als Unterschied;
 * das war falsch, und ausgerechnet in der Datei, die es gibt, damit niemand
 * mehr die falschen zwei Zahlen vergleicht.
 *   | Umfang II   | bis „bezahlt"            | nur noch nicht Abgerechnetes   |
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
 * Zählweise der Umsatz-Kachel — NUR der Kaskade.
 *
 * Die Kosten-Tabelle darunter ist eine eigene Karte und braucht, wenn
 * überhaupt, einen eigenen Satz: ihre HW/AB-Zeilen sind IMMER je Termin (auch
 * für längst abgerechnete), und sie hat zwei eigene km-Zeilen mit eigenem
 * Erlös. „je Termin ohne km" wäre dort falsch. Eine erste Fassung beanspruchte
 * sie im Klammerzusatz mit.
 *
 * BEWUSST NICHT „je Termin, netto, ohne km", obwohl das der naheliegende Satz
 * wäre: „ohne km" gilt nur für die frühen Stufen. Sobald abgerechnet ist,
 * trägt die Stufe den vollen Rechnungs-Netto INKLUSIVE km-Positionen (der
 * km-Sprung an der Hybrid-Kante, offen als eigenes Ticket). Ein Hinweis, der
 * für die Hälfte der Zeilen nicht stimmt, ist schlimmer als keiner — genau
 * dieselbe Falle wie die frühere Kopfzeile „(Leistungen)", die „ohne km"
 * meinte und es nur für drei von sechs Stufen war.
 *
 * Der Satz nennt die Grenze deshalb mit. UND ER NENNT SIE OHNE STUFEN-NAMEN:
 * eine erste Fassung schrieb „ab ‚gestellt‘" und lag damit eine Stufe daneben.
 * Die Hybrid-Kante ist `isInvoiced`, und `activeInvoiceCondition` schließt
 * Entwurfs-Rechnungen AUSDRÜCKLICH ein — der Termin verlässt die Termin-Stufen
 * also schon bei „Rechnung im Entwurf", nicht erst bei „gestellt". Ein Kunde
 * mit fertigem Entwurf hätte seinen Betrag inklusive km in einer Stufe
 * gesehen, für die der Hinweis „je Termin ohne km" behauptet.
 *
 * „ab der Rechnung" bindet an die Sache statt an eine Beschriftung und bleibt
 * damit auch nach einer Umbenennung wahr.
 */
export const ZAEHLWEISE_UMSATZ_KACHEL =
  "je Termin ohne km, ab der Rechnung je Rechnung mit km — immer netto";

/**
 * Zählweise der Karte „Noch zu erstellen" (Rechnungen-Tab).
 *
 * „je Kunde" und „brutto" stimmen ohne Einschränkung: die Gruppierung ist
 * kundenweise (`classifyBillingMaturity`), der Betrag kommt aus dem vollen
 * Rechnungs-Entwurf (`grossAmountCents`, also mit km und mit USt).
 *
 * „mit geplanten Terminen" stand hier zuerst und ist RAUS — es gilt nur für
 * die Gruppe „Dokumentation ausstehend". Für „Bereit zum Abrechnen" und
 * „Leistungsnachweis fehlt" ist der Plan-Anteil per Konstruktion 0, weil beide
 * Gruppen keine offenen Termine haben. Der Satz steht aber über allen drei
 * Gruppen. Vakuum-wahr ist nicht dasselbe wie wahr.
 *
 * Stattdessen steht dort jetzt der Unterschied, der tatsächlich am meisten
 * ausmacht und vorher fehlte: **die Liste zählt nur, was noch nicht
 * abgerechnet ist** — die Kachel zählt bis „bezahlt". Das erklärt eine
 * Differenz in der Größenordnung ganzer Rechnungen, nicht in der von km.
 */
export const ZAEHLWEISE_RECHNUNGSLISTE =
  "je Kunde, brutto, mit km — nur noch nicht Abgerechnetes";
