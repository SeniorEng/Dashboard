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
 *   | Umfang II   | bis „bezahlt"            | nur noch nicht Abgerechnetes   |
 *
 * NICHT in der Liste, obwohl es naheliegt: „geplante Termine". Beide Ansichten
 * enthalten sie — die Kaskade in der Stufe „noch geplant", die Liste im
 * PLAN-Anteil. Eine erste Fassung dieser Tabelle nannte das als Unterschied;
 * das war falsch, und ausgerechnet in der Datei, die es gibt, damit niemand
 * mehr die falschen zwei Zahlen vergleicht.
 *
 * Alrik hat entschieden: **sichtbar machen statt angleichen** (Weg 3). Beide
 * Ansichten bleiben, wie sie sind — was dazukommt, ist die Auskunft, was jede
 * von beiden zählt.
 *
 * ── Warum es jetzt VIER Sichten sind (S-1, Alrik 18.09.2026) ─────────────
 * Weg A lässt die zwei Kachel-Blöcke dem Monats-Cutoff folgen: danach zählt
 * ein noch nicht dokumentierter Termin dort kein Geld mehr. Die beiden
 * Arbeitslisten (Termine-Tab, Rechnungen-Tab) folgen ihm NICHT — sie zeigen
 * ihn weiter.
 *
 * **Das ist Absicht, kein Rückstand.** Alriks Begründung, warum die Listen
 * nicht mitziehen dürfen: der Auto-Abschluss läuft nur am Cutoff-Tag und nur
 * für Mitarbeiter:innen mit Aktivität — wer ausschließlich geplante Termine
 * hat, wird nie abgeschlossen und darf weiter dokumentieren. Würden die Listen
 * dem Kalender folgen, verschwände ausgerechnet dessen Arbeit aus der Ansicht,
 * in der sie noch zu erledigen ist.
 *
 * Die Regel dahinter, die über diesen Fall hinausgeht:
 * **eine Arbeitsliste darf nichts verstecken, eine Geld-Sicht darf nichts
 * versprechen.** Verschiedene Zwecke, verschiedene Zählweise — und genau
 * dafür gibt es Weg 3. Deshalb sagt ab jetzt jede der vier Sichten BEIDES:
 * was sie zählt, und was nach dem Monatsabschluss damit geschieht.
 *
 * ── Warum die Sätze HIER stehen und nicht je in ihrer Komponente ─────────
 * Weil sie eine FAMILIE sind. Ihr ganzer Zweck ist der Moment, in dem jemand
 * zwei Zahlen vergleicht — und was an vier Orten gepflegt wird, driftet
 * auseinander. Dann hätten wir dasselbe Problem eine Ebene höher: vier
 * Erklärungen, die sich widersprechen. Dieselbe Begründung wie bei den
 * Stufen-Beschriftungen (`PIPELINE_STAGE_LABELS`): ein Begriff, eine Quelle.
 *
 * ── Fachlich, nicht technisch ────────────────────────────────────────────
 * Kein `unit_type = 'hours'`, kein `grossAmountCents`, kein „kalendarisch vs.
 * zustandsbasiert". Wer das liest, arbeitet mit Rechnungen, nicht mit dem
 * Schema.
 */

/** Die vier Ansichten, die dieselben Termine unterschiedlich zählen. */
export type ZaehlweiseSicht =
  | "umsatzKaskade"
  | "kostenTabelle"
  | "termineListe"
  | "rechnungenListe";

/**
 * Wozu die Ansicht da ist — und damit, wie sie den Monatsabschluss behandelt.
 *
 * `geld` = beantwortet „was bekomme ich?"; sie darf nichts versprechen, was
 * nicht mehr kommt, und folgt deshalb dem Cutoff.
 * `arbeitsliste` = beantwortet „was ist noch zu tun?"; sie darf nichts
 * verstecken, was noch zu tun ist, und folgt ihm deshalb nicht.
 */
export type SichtArt = "geld" | "arbeitsliste";

export interface ZaehlweiseHinweis {
  art: SichtArt;
  /** Was diese Ansicht zählt — Einheit und Basis. Ein Satz. */
  zaehlt: string;
  /** Was nach dem Monatsabschluss mit noch nicht Dokumentiertem geschieht. */
  nachAbschluss: string;
}

/**
 * Der Cutoff-Satz hängt an der ART der Sicht, nicht an der einzelnen Ansicht.
 *
 * Bewusst so: die zwei Geld-Sichten MÜSSEN hier dasselbe sagen, sonst sagt
 * eine Karte zwei Dinge über dasselbe Geld — der Fehler, den Weg A behoben
 * hat. Vier einzeln gepflegte Sätze könnten genau dorthin zurückdriften.
 *
 * Beide binden an die Sache — **ob dokumentiert ist** —, nicht an eine
 * Stufen-Beschriftung. Dieselbe Lehre wie beim ZW-6-Fix: „ab ‚gestellt'" lag
 * eine Stufe daneben und der Test sah es nicht, weil er Wörter prüfte statt
 * der Aussage. Ein Satz ohne Stufennamen kann nicht auf die falsche zeigen
 * und überlebt jede Umbenennung.
 */
const NACH_ABSCHLUSS: Record<SichtArt, string> = {
  geld: "nach dem Monatsabschluss zählt nur noch, was dokumentiert ist",
  arbeitsliste: "noch nicht Dokumentiertes bleibt auch nach dem Abschluss stehen",
};

/**
 * ERSETZT die beiden losen Konstanten `ZAEHLWEISE_UMSATZ_KACHEL` und
 * `ZAEHLWEISE_RECHNUNGSLISTE`.
 *
 * Warum eine Aufzählung statt vier Konstanten: so ist „jede Sicht hat einen
 * Hinweis" eine Typ-Aussage. Eine fünfte Ansicht, die dazukommt, fällt beim
 * Ergänzen des Typs auf — statt still ohne Beschriftung zu bleiben.
 */
export const ZAEHLWEISE: Record<ZaehlweiseSicht, ZaehlweiseHinweis> = {
  /**
   * Umsatz-Kachel, obere Kaskade — NUR sie, nicht die Kosten-Tabelle darunter.
   *
   * BEWUSST NICHT „je Termin, netto, ohne km", obwohl das der naheliegende
   * Satz wäre: „ohne km" gilt nur für die frühen Stufen. Sobald abgerechnet
   * ist, trägt die Stufe den vollen Rechnungs-Netto INKLUSIVE km-Positionen
   * (der km-Sprung an der Hybrid-Kante, offen als `6hWrwFh4j6wV47Xp`). Ein
   * Hinweis, der für die Hälfte der Zeilen nicht stimmt, ist schlimmer als
   * keiner — dieselbe Falle wie die frühere Kopfzeile „(Leistungen)".
   *
   * „ab der Rechnung" statt „ab ‚gestellt'": die Hybrid-Kante ist
   * `isInvoiced`, und `activeInvoiceCondition` schließt Entwurfs-Rechnungen
   * AUSDRÜCKLICH ein — der Termin verlässt die Termin-Stufen also schon beim
   * Entwurf, nicht erst beim Versand.
   */
  umsatzKaskade: {
    art: "geld",
    zaehlt: "je Termin ohne km, ab der Rechnung je Rechnung mit km — immer netto",
    nachAbschluss: NACH_ABSCHLUSS.geld,
  },

  /**
   * Umsatz-Kachel, untere Kosten-Tabelle.
   *
   * Sie braucht einen EIGENEN Satz: ihre HW/AB-Zeilen sind immer je Termin
   * (auch für längst abgerechnete), und sie hat zwei eigene km-Zeilen mit
   * eigenem Erlös. „je Termin ohne km" wäre hier falsch.
   *
   * Der Satz nennt die zwei Spaltenpaare, weil genau deren Unterschied die
   * Frage ist, die jemand beim Lesen hat. Die Kostenseite bleibt draußen: dass
   * der Lohn ohne Nebenkosten gerechnet ist, steht am Deckungsbeitrag, und
   * zweimal dasselbe zu sagen macht beide Stellen unschärfer.
   */
  kostenTabelle: {
    art: "geld",
    zaehlt: "Ist = dokumentiert, Potenzial = plus geplant — Umsatz netto",
    nachAbschluss: NACH_ABSCHLUSS.geld,
  },

  /**
   * Termine-Tab (Arbeitsliste).
   *
   * „kein Geld" ist der wichtigste Teil des Satzes: dieser Tab zählt Termine,
   * keine Beträge — wer ihn mit der Kachel vergleicht, vergleicht Anzahl mit
   * Euro. Der Reader liest ausdrücklich keine Geldspalten.
   */
  termineListe: {
    art: "arbeitsliste",
    zaehlt: "je Termin, nach Mitarbeiter:in — Anzahl, kein Geld",
    nachAbschluss: NACH_ABSCHLUSS.arbeitsliste,
  },

  /**
   * Karte „Noch zu erstellen" im Rechnungen-Tab.
   *
   * „je Kunde" und „brutto" stimmen ohne Einschränkung: die Gruppierung ist
   * kundenweise (`classifyBillingMaturity`), der Betrag kommt aus dem vollen
   * Rechnungs-Entwurf (also mit km und mit USt).
   *
   * „mit geplanten Terminen" stand hier zuerst und ist RAUS — es gilt nur für
   * die Gruppe „Dokumentation ausstehend"; für die beiden anderen ist der
   * Plan-Anteil per Konstruktion 0. Der Satz steht aber über allen drei
   * Gruppen, und vakuum-wahr ist nicht dasselbe wie wahr. Stattdessen steht
   * dort der Unterschied, der am meisten ausmacht: die Liste zählt nur, was
   * noch nicht abgerechnet ist — die Kachel zählt bis „bezahlt".
   */
  rechnungenListe: {
    art: "arbeitsliste",
    zaehlt: "je Kunde, brutto, mit km — nur noch nicht Abgerechnetes",
    nachAbschluss: NACH_ABSCHLUSS.arbeitsliste,
  },
};
