/**
 * P1 6hXqFcc2hRQfC9qp — der DAVASO-Pfad schrieb alle Posten-Beträge ×100.
 *
 * ── Der Vorfall ──────────────────────────────────────────────────────────
 * Am 21.09.2026 wurden zwei IKK-Avise über den DAVASO-Pfad importiert — dem
 * ersten Mal, dass dieser Pfad in Prod lief. Jeder einzelne Posten stand exakt
 * hundertfach zu hoch; die Differenz zur Rechnungssumme war centgenau die
 * „Überzahlung", die das UI anzeigte (28.149,66 € bzw. 56.960,64 €).
 *
 * **Keine Regression.** Der Fehler war von Anfang an da und ist nie
 * aufgefallen, weil den Pfad nie jemand benutzt hat.
 *
 * ── Die Ursache, und warum sie genau eine Familie trifft ─────────────────
 * `parseEuroCents` nahm die deutsche Konvention global an und strich JEDEN
 * Punkt als Tausendertrenner. DAVASO schreibt `70.00`, das wurde zu `7000`
 * und mal 100 zu 700.000 Cent.
 *
 * Dass es nur DAVASO trifft, ist keine Laune, sondern eine Kopplung: DAVASO
 * ist KOMMA-getrennt, also muss die Dezimaltrennung ein Punkt sein — eine
 * komma-getrennte CSV kann keine unquotierten Dezimalkommas tragen. Die
 * Kassen-Familie ist semikolon-getrennt und benutzt deshalb Kommas.
 *
 * ── Die Fixtures ─────────────────────────────────────────────────────────
 * ANONYMISIERT: echte Feldnamen, echte Formate, **erfundene Beträge, Namen
 * und Nummern**. Avis-Dateien tragen Versichertennamen und -nummern; sie
 * gehören nicht ins Repo. Geprüft wird die Struktur, nicht der Bestand.
 */
import { describe, it, expect } from "vitest";
import { parseAvisCsv, parseBetragCents } from "../../server/services/avis-parser";

/**
 * DAVASO: Komma-getrennt, Punkt als Dezimaltrennung.
 *
 * Aufbau wie im vorhandenen Regressions-Fixture `IKK_DAVASO`: **Zeile 1 ist
 * die Summenzeile** — sie hat KEINE `ZEM_BelegNr` und trägt in
 * `KTR_BTR_Zahlg` den gezahlten Gesamtbetrag. Die Postenzeilen darunter
 * tragen ihre Belegnummer und ihre Forderung, `KTR_BTR_Zahlg` bleibt dort leer.
 *
 * Meine erste Fassung füllte die Spalte in JEDER Zeile — aus Alriks Beobachtung
 * „Gesamtbetrag = Posten 1" abgeleitet, ohne den authentischen Fixture im Repo
 * anzusehen, der es anders zeigt. Beträge und Namen sind erfunden, die
 * Struktur ist es nicht.
 */
const DAVASO = [
  "LfdNr,AVISNr,KTR_IK,KTR_Name,ZEM_IK,ZEM_IBAN,ZEM_BelegNr,ZEM_VorgangsNr,ZEM_RecNr,ZEM_RecDatum,ZEM_BTR_Forderg,KTR_BTR_Zahlg,KTR_BTR_Skonto,KTR_BTR_DTA_Kuerzg,Datum_ZahlungAusfuehrg",
  "1,TST01278,100000000,Testkasse,200000000,DE00000000000000000000,,V-0,,,284.34,284.34,0.00,0.00,15.09.2026",
  "2,TST01278,100000000,Testkasse,200000000,DE00000000000000000000,B-1,V-1,RE-2026-9001,01.08.2026,70.00,,0.00,,",
  "3,TST01278,100000000,Testkasse,200000000,DE00000000000000000000,B-2,V-2,RE-2026-9002,01.08.2026,123.49,,0.00,,",
  "4,TST01278,100000000,Testkasse,200000000,DE00000000000000000000,B-3,V-3,RE-2026-9003,01.08.2026,76.29,,0.00,,",
  "5,TST01278,100000000,Testkasse,200000000,DE00000000000000000000,B-4,V-4,RE-2026-9004,01.08.2026,14.56,,0.00,,",
].join("\n");

/** Kassen-CSV: Semikolon-getrennt, Komma als Dezimaltrennung, eine `3;`-Summenzeile. */
const KASSEN = [
  "1;200000000;Testempfaenger;",
  "2;RE-2026-9101 Beispiel;RE-2026-9101;01.09.2026;150,00;+;EUR;",
  "2;RE-2026-9102 Beispiel;RE-2026-9102;01.09.2026;1.234,90;+;EUR;",
  "3;BELEG-1;15.09.2026;1.384,90;DE00000000000000000000;",
].join("\n");

describe("Avis-Beträge — Dezimalkonvention (P1 6hXqFcc2hRQfC9qp)", () => {
  it("AP-1 – DAVASO: der Punkt ist die Dezimaltrennung, nicht ein Tausenderpunkt", () => {
    const { items } = parseAvisCsv(DAVASO);
    // Die vier Werte aus dem Prod-Vorfall, hier als Struktur nachgebaut.
    expect(items.map((i) => i.betragCents)).toEqual([7000, 12349, 7629, 1456]);
  });

  it("AP-2 – die Gegenprobe zum Vorfall: KEIN Wert ist um Faktor 100 daneben", () => {
    // Der Test, der den Fehler beim Namen nennt. Wäre die alte Fassung zurück,
    // stünden hier 700000 / 1234900 / 762900 / 145600 — und genau diese Zahlen
    // standen am 21.09. in Prod.
    const { items } = parseAvisCsv(DAVASO);
    const falsch = [700000, 1234900, 762900, 145600];
    for (const [i, item] of items.entries()) {
      expect(item.betragCents, `Posten ${i + 1} ist um Faktor 100 zu gross`).not.toBe(falsch[i]);
    }
  });

  it("AP-3 – Kassen-CSV: das Komma trennt, der Punkt gruppiert", () => {
    const { items } = parseAvisCsv(KASSEN);
    expect(items.map((i) => i.betragCents)).toEqual([15000, 123490]);
  });

  it("AP-4 – die Konvention wird übergeben, nicht geraten", () => {
    // `1.234` ist ohne Konvention nicht entscheidbar — deutsche Tausender oder
    // 1,234 mit Punkt? Genau diese Mehrdeutigkeit hat den Fehler ermöglicht,
    // deshalb gibt es keine Heuristik pro Wert.
    expect(parseBetragCents("1.234", "komma")).toBe(123400);
    expect(parseBetragCents("1.234", "punkt")).toBe(123);
    expect(parseBetragCents("1,234.56", "punkt")).toBe(123456);
    expect(parseBetragCents("1.234,56", "komma")).toBe(123456);
  });
});

describe("Avis-Prüfsumme — die zweite Zahl der Datei", () => {
  it("AP-5 – DAVASO: der Gesamtbetrag kommt aus den POSTEN, nicht aus Zeile 1", () => {
    // Vorher stand hier `KTR_BTR_Zahlg` der ersten gefüllten Zeile — und die
    // Spalte ist in JEDER Zeile gefüllt, also war es Posten 1. Gemessen an
    // Avis 24/25: gespeichert 700.000 bzw. 1.168.400, beides Posten 1.
    const { header, pruefsumme } = parseAvisCsv(DAVASO);
    expect(header.gesamtBetragCents).toBe(7000 + 12349 + 7629 + 1456);
    expect(header.gesamtBetragCents, "der Gesamtbetrag ist wieder Posten 1").not.toBe(7000);
    expect(pruefsumme.ausgewiesenCents, "die Summenzeile wurde nicht gefunden").toBe(28434);
    expect(pruefsumme.abweichungCents, "Postensumme und Summenzeile gehen nicht auf").toBe(0);
  });

  it("AP-6 – Kassen-CSV: die `3;`-Zeile ist die zweite Zahl, und sie geht auf", () => {
    const { pruefsumme } = parseAvisCsv(KASSEN);
    expect(pruefsumme.ausPostenCents).toBe(138490);
    expect(pruefsumme.ausgewiesenCents).toBe(138490);
    expect(pruefsumme.abweichungCents).toBe(0);
    expect(pruefsumme.quelle).toMatch(/3;/);
  });

  it("AP-7 – ein Feldversatz fällt gegen die Summenzeile auf", () => {
    // Der Fall, den der Betrags-Detektor per Konstruktion NICHT fangen kann:
    // bei 7, 8, 9 und 13 Feldern in `2;`-Zeilen ist ein Versatz keine
    // Randmöglichkeit. Hier liest ein Posten den falschen Betrag — die
    // Summenzeile widerspricht sofort.
    const versetzt = KASSEN.replace("2;RE-2026-9101 Beispiel;RE-2026-9101;01.09.2026;150,00;+;EUR;",
                                    "2;RE-2026-9101 Beispiel;RE-2026-9101;01.09.2026;151,00;+;EUR;");
    const { pruefsumme } = parseAvisCsv(versetzt);
    expect(pruefsumme.abweichungCents, "die Abweichung bleibt unbemerkt").toBe(100);
  });

  it("AP-8 – „keine zweite Zahl“ ist NICHT „geprüft und in Ordnung“", () => {
    // Dieselbe Regel wie beim Publish-Preflight, der seinen eigenen Ausfall
    // als „nichts gefunden" ausgab: eine fehlende Messung ist kein Ergebnis.
    const ohneSummenzeile = KASSEN.split("\n").filter((l) => !l.startsWith("3;")).join("\n");
    const { pruefsumme } = parseAvisCsv(ohneSummenzeile);
    expect(pruefsumme.ausgewiesenCents).toBeNull();
    expect(pruefsumme.abweichungCents, "fehlende Summe als 0 ausgegeben").toBeNull();
  });
});

/**
 * Schritt 4 und 5 der Erstinbetriebnahme. Beides war beim Nachsehen bereits im
 * Code behandelt — was fehlte, ist der Nachweis. Die Tests sind deshalb kein
 * Beleg für eine Änderung, sondern dafür, dass die Zusage bestehen bleibt:
 * ohne sie ist „verträgt BOM" eine Beobachtung von heute, kein Versprechen.
 */
describe("Avis-Dateien aus der Praxis — Verpackung und Fremddateien", () => {
  const BOM = "\uFEFF";

  it("AP-9 – BOM und CRLF ändern am Ergebnis nichts (Kassen-Familie)", () => {
    // Die Windows-Verpackung, in der die Kassen ihre Dateien schicken. Ein
    // unbehandeltes BOM macht aus `1;` ein `\uFEFF1;` — die Formaterkennung
    // fiele durch, und die Datei wäre „Format nicht erkannt" statt eingelesen.
    const roh = parseAvisCsv(KASSEN);
    const verpackt = parseAvisCsv(BOM + KASSEN.replace(/\n/g, "\r\n"));
    expect(verpackt.header.format).toBe("kassen-csv");
    expect(verpackt.items.map((i) => i.betragCents)).toEqual(roh.items.map((i) => i.betragCents));
    expect(verpackt.pruefsumme.abweichungCents).toBe(0);
    expect(verpackt.header.zahlungsempfaengerIban, "das CR hängt am letzten Feld")
      .toBe(roh.header.zahlungsempfaengerIban);
  });

  it("AP-10 – BOM und CRLF ändern am Ergebnis nichts (DAVASO)", () => {
    const roh = parseAvisCsv(DAVASO);
    const verpackt = parseAvisCsv(BOM + DAVASO.replace(/\n/g, "\r\n"));
    expect(verpackt.header.format).toBe("davaso");
    expect(verpackt.items.map((i) => i.betragCents)).toEqual(roh.items.map((i) => i.betragCents));
    expect(verpackt.pruefsumme.abweichungCents).toBe(0);
  });

  it("AP-11 – DAVASO wird über SPALTENNAMEN gelesen, nicht über Positionen", () => {
    // Die beiden echten DAVASO-Muster im Repo haben verschiedene Spaltenfolgen
    // (das Regressions-Sample führt zusätzlich `AvisPos` an zweiter Stelle).
    // Eine feste Index-Lesung würde bei einer davon still das Nachbarfeld
    // greifen — beim Betrag hieße das: ein Datum als Geldbetrag.
    const mitZusatzspalte = DAVASO.split("\n").map((z, i) =>
      i === 0 ? z.replace("LfdNr,", "LfdNr,AvisPos,") : z.replace(/^(\d+),/, "$1,1,"),
    ).join("\n");
    const r = parseAvisCsv(mitZusatzspalte);
    expect(r.items.map((i) => i.betragCents)).toEqual([7000, 12349, 7629, 1456]);
    expect(r.header.kostentraegerName).toBe("Testkasse");
    expect(r.pruefsumme.abweichungCents).toBe(0);
  });

  it("AP-12 – eine fremde Datei wird laut abgelehnt, nicht leer eingelesen", () => {
    // Der gefährliche Ausgang wäre nicht der Fehler, sondern ein Avis mit null
    // Posten und 0,00 € — formal angelegt, inhaltlich nichts, und niemandem
    // fällt auf, dass die Datei nie ankam.
    expect(() => parseAvisCsv("Datum;Betrag;Text\n01.09.2026;150,00;Irgendwas"))
      .toThrow(/Format nicht erkannt/);
    expect(() => parseAvisCsv("")).toThrow();
  });
});
