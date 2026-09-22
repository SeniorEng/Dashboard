/**
 * P1 6hXqFcc2hRQfC9qp — der DAVASO-Pfad, zweimal falsch gelesen.
 *
 * ── Fehler 1: der Faktor 100 ────────────────────────────────────────────
 * Am 21.09.2026 wurden zwei IKK-Avise über den DAVASO-Pfad importiert — das
 * erste Mal, dass dieser Pfad in Prod lief. Jeder Posten stand exakt
 * hundertfach zu hoch; die Differenz zur Rechnungssumme war centgenau die
 * „Überzahlung", die das UI anzeigte (28.149,66 € bzw. 56.960,64 €).
 *
 * Ursache: `parseEuroCents` nahm die deutsche Konvention global an und strich
 * JEDEN Punkt als Tausendertrenner. DAVASO schreibt `70.00` → `7000` → mal 100
 * → 700.000 Cent. Dass es nur DAVASO trifft, ist eine Kopplung: DAVASO ist
 * komma-getrennt, kann also keine unquotierten Dezimalkommas tragen; die
 * Kassen-Familie ist semikolon-getrennt und benutzt Kommas.
 *
 * ── Fehler 2: die falsche Spalte, in der falschen Zeile ─────────────────
 * DAVASO ist in BLÖCKEN aufgebaut — eine Rechnung je Block:
 *
 *   Kopfzeile     keine `ZEM_BelegNr`, trägt `ZEM_RecNr`, **`KTR_BTR_Zahlg`**,
 *                 Skonto, Kürzung, Zahldatum
 *   Belegzeilen   `ZEM_BelegNr` gefüllt, tragen ihren Anteil der FORDERUNG
 *                 und dieselbe `ZEM_RecNr` wie ihre Kopfzeile
 *
 * Der Parser sammelte die Posten aus den Belegzeilen und nahm deren
 * **Forderung**. Ein Avis sagt aber, was GEZAHLT wurde.
 *
 * An 29 Dateien gemessen: `ZEM_RecNr` auf 66/66 Kopfzeilen und 114/114
 * Belegzeilen, je Block genau eine Nummer, 0 Abweichungen; `ZEM_BelegNr`
 * exakt komplementär (Kopf 0, Beleg 114). Blockgrößen: N=1 **54×**, N=2 2×,
 * N=3 1×, N=5 3×, N=6 4×, N=7 2×.
 *
 * **54 von 66 sind 1:1 — genau dort fällt der Spaltenfehler nicht auf.**
 *
 * ── Die Fixtures ───────────────────────────────────────────────────────
 * ANONYMISIERT: echte Feldnamen, echte Struktur, **erfundene Namen und
 * Nummern**. Wo Beträge aus einer Messung stammen, steht es dran — Avis-Dateien
 * tragen Versichertennamen und -nummern und gehören nicht ins Repo.
 */
import { describe, it, expect } from "vitest";
import { parseAvisCsv, parseBetragCents } from "../../server/services/avis-parser";

const SPALTEN = [
  "LfdNr", "AVISNr", "KTR_IK", "KTR_Name", "ZEM_IK", "ZEM_IBAN", "ZEM_BelegNr",
  "ZEM_VorgangsNr", "ZEM_RecNr", "ZEM_RecDatum", "ZEM_BTR_Forderg", "KTR_BTR_Zahlg",
  "KTR_BTR_Skonto", "KTR_BTR_DTA_Kuerzg", "Datum_ZahlungAusfuehrg",
];

let lfd = 0;
/** Kopfzeile eines Blocks: keine Belegnummer, trägt den ZAHLbetrag. */
function kopf(
  recNr: string, forderung: string, zahlung: string,
  extra: Partial<{ skonto: string; kuerzung: string; vorgang: string }> = {},
) {
  lfd += 1;
  return [`${lfd}`, "TST01278", "100000000", "Testkasse", "200000000", "DE00000000000000000000",
    "", extra.vorgang ?? "V-1", recNr, "01.08.2026", forderung, zahlung,
    extra.skonto ?? "0.00", extra.kuerzung ?? "0.00", "15.09.2026"].join(",");
}
/** Belegzeile: Belegnummer gefüllt, nur die Forderung, dieselbe `ZEM_RecNr`. */
function beleg(recNr: string, belegNr: string, forderung: string) {
  lfd += 1;
  return [`${lfd}`, "TST01278", "100000000", "Testkasse", "200000000", "DE00000000000000000000",
    belegNr, "V-1", recNr, "01.08.2026", forderung, "", "0.00", "", ""].join(",");
}
function datei(...zeilen: string[]) {
  lfd = 0;
  return [SPALTEN.join(","), ...zeilen].join("\n");
}

/**
 * Vier Blöcke à N=1 — die Form von 54 der 66 gemessenen Blöcke, und die der
 * beiden Prod-Dateien vom 21.09. Die Beträge sind die vier aus dem Vorfall.
 */
const DAVASO_1ZU1 = datei(
  kopf("RE-2026-9001", "70.00", "70.00"), beleg("RE-2026-9001", "B-1", "70.00"),
  kopf("RE-2026-9002", "123.49", "123.49"), beleg("RE-2026-9002", "B-2", "123.49"),
  kopf("RE-2026-9003", "76.29", "76.29"), beleg("RE-2026-9003", "B-3", "76.29"),
  kopf("RE-2026-9004", "14.56", "14.56"), beleg("RE-2026-9004", "B-4", "14.56"),
);

/** Ein Block mit fünf Belegen — die Form des Repo-Fixtures `ICL01159` (N=5, 3× gemessen). */
const DAVASO_BLOCK_N5 = datei(
  kopf("RE-2026-9100", "692.12", "692.12"),
  beleg("RE-2026-9100", "1", "127.32"),
  beleg("RE-2026-9100", "2", "230.61"),
  beleg("RE-2026-9100", "3", "68.73"),
  beleg("RE-2026-9100", "4", "87.46"),
  beleg("RE-2026-9100", "5", "178.00"),
);

/** Kassen-CSV: Semikolon-getrennt, Komma als Dezimaltrennung, eine `3;`-Summenzeile. */
const KASSEN = [
  "1;200000000;Testempfaenger;",
  "2;RE-2026-9101 Beispiel;RE-2026-9101;01.09.2026;150,00;+;EUR;",
  "2;RE-2026-9102 Beispiel;RE-2026-9102;01.09.2026;1.234,90;+;EUR;",
  "3;BELEG-1;15.09.2026;1.384,90;DE00000000000000000000;",
].join("\n");

describe("Avis-Beträge — Dezimalkonvention", () => {
  it("AP-1 – DAVASO: der Punkt ist die Dezimaltrennung, nicht ein Tausenderpunkt", () => {
    const { items } = parseAvisCsv(DAVASO_1ZU1);
    expect(items.map(i => i.betragCents)).toEqual([7000, 12349, 7629, 1456]);
  });

  it("AP-2 – die Gegenprobe zum Vorfall: KEIN Wert ist um Faktor 100 daneben", () => {
    // Wäre die alte Fassung zurück, stünden hier 700000 / 1234900 / 762900 /
    // 145600 — genau diese Zahlen standen am 21.09. in Prod.
    const { items } = parseAvisCsv(DAVASO_1ZU1);
    const falsch = [700000, 1234900, 762900, 145600];
    for (const [i, item] of items.entries()) {
      expect(item.betragCents, `Posten ${i + 1} ist um Faktor 100 zu gross`).not.toBe(falsch[i]);
    }
  });

  it("AP-3 – Kassen-CSV: das Komma trennt, der Punkt gruppiert", () => {
    const { items } = parseAvisCsv(KASSEN);
    expect(items.map(i => i.betragCents)).toEqual([15000, 123490]);
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

describe("DAVASO — ein Posten je BLOCK, mit dem Zahlbetrag", () => {
  it("AP-5 – ein Block mit fünf Belegen ist EIN Posten, nicht fünf", () => {
    // Alle Belege eines Blocks tragen dieselbe `ZEM_RecNr` — sie gehören zu
    // EINER Rechnung. Der alte Parser machte daraus fünf Posten, und der
    // Regressionstest hat das als „5 Positionen" eingefroren.
    const { items, header } = parseAvisCsv(DAVASO_BLOCK_N5);
    expect(items).toHaveLength(1);
    expect(items[0].rechnungsNummer).toBe("RE-2026-9100");
    expect(items[0].betragCents).toBe(69212);
    expect(items[0].belegNr, "die Belege des Blocks gehen verloren").toBe("1, 2, 3, 4, 5");
    expect(header.gesamtBetragCents).toBe(69212);
  });

  it("AP-6 – der Posten trägt den ZAHLbetrag, nicht die Forderung", () => {
    // ── Der gemessene Fall: Avis_ICL01267.csv, RE-2026-0213 ──
    // Gefordert 117,19 €, gezahlt 58,16 €, Skonto 0, Kürzung 0. Eine von 66
    // Kopfzeilen weicht ab — und sie liegt im aktuellen Rückstand.
    //
    // Der alte Aufbau hätte 117,19 € gebucht, der Rechnungsabgleich hätte
    // `bestaetigt` gemeldet, und die Unterzahlung von 59,03 € wäre unsichtbar
    // geblieben. Bei 65 von 66 Zeilen sind beide Zahlen gleich — deshalb ist
    // es nie aufgefallen.
    const unterzahlung = datei(
      kopf("RE-2026-0213", "117.19", "58.16"),
      beleg("RE-2026-0213", "B-1", "117.19"),
    );
    const { items, header } = parseAvisCsv(unterzahlung);
    expect(items).toHaveLength(1);
    expect(items[0].betragCents, "die Forderung statt der Zahlung gelesen").toBe(5816);
    expect(items[0].betragCents).not.toBe(11719);
    expect(header.gesamtBetragCents, "der Gesamtbetrag ist nicht der Bankbetrag").toBe(5816);
  });

  it("AP-7 – der Gesamtbetrag ist die Summe der Zahlbeträge (= der Bankbetrag)", () => {
    // Genau diese Größe braucht die Triple-Equality des Bulk-Matchers.
    // Gemessen an Avis 24/25: gespeichert waren 700.000 bzw. 1.168.400 —
    // jeweils der erste Block, ×100.
    const { header } = parseAvisCsv(DAVASO_1ZU1);
    expect(header.gesamtBetragCents).toBe(7000 + 12349 + 7629 + 1456);
    expect(header.gesamtBetragCents, "der Gesamtbetrag ist wieder Block 1").not.toBe(7000);
  });

  it("AP-8 – Skonto und Kürzung kommen von der Kopfzeile des EIGENEN Blocks", () => {
    // Nicht von einer Belegzeile (dort stehen sie nicht) und nicht vom ersten
    // Block (dann gälte dessen Abzug für alle).
    const mitAbzug = datei(
      kopf("RE-2026-9001", "100.00", "95.00", { skonto: "5.00" }),
      beleg("RE-2026-9001", "B-1", "100.00"),
      kopf("RE-2026-9002", "50.00", "50.00"),
      beleg("RE-2026-9002", "B-2", "50.00"),
    );
    const { items } = parseAvisCsv(mitAbzug);
    expect(items.map(i => i.skontoCents)).toEqual([500, 0]);
    expect(items.map(i => i.betragCents)).toEqual([9500, 5000]);
  });

  it("AP-9 – eine Belegzeile ohne Kopfzeile ist ein Abbruch, keine Randnotiz", () => {
    // Sie gehörte zu keiner Rechnung — still gelesen wäre es eine Forderung
    // ohne Zahlung im Avis. In 29 gemessenen Dateien kommt das nicht vor.
    const verwaist = datei(beleg("RE-2026-9001", "B-1", "70.00"));
    expect(() => parseAvisCsv(verwaist)).toThrow(/ohne vorangehende Kopfzeile/);
  });

  it("AP-10 – eine doppelte Belegnummer IM SELBEN BLOCK wird abgelehnt", () => {
    // Gate-2-Befund G: eine verdoppelte Zeile lief mit `abweichung = 0` durch.
    // Der datei-interne Vergleich kann das per Konstruktion nicht sehen —
    // beide Seiten verdoppeln sich mit.
    const doppelt = datei(
      kopf("RE-2026-9100", "140.00", "140.00"),
      beleg("RE-2026-9100", "B-1", "70.00"),
      beleg("RE-2026-9100", "B-1", "70.00"),
    );
    expect(() => parseAvisCsv(doppelt)).toThrow(/Belegnummer mehrfach/);
  });

  it("AP-27 – ein verdoppelter Block wird abgelehnt", () => {
    // ── Der Fall, den mein eigener Hotfix aufgegeben hatte ──
    // Die Verengung auf den Block klang schlüssig: „eine verdoppelte Zeile
    // steht per Definition im selben Block". Sie tut es NICHT — die
    // Blockgrenze ist „Zeile ohne ZEM_BelegNr", also eröffnet eine
    // verdoppelte KOPFZEILE einen neuen Block. Eine zweimal angehängte Datei
    // lief mit doppeltem Betrag durch (`posten=4 gesamt=20000` statt 10000).
    //
    // Ich hatte einen Fehlalarm gegen einen Fehlschluss getauscht, und die
    // Zusage daran war wieder eine ungemessene Annahme — dieselbe Klasse wie
    // der dateiweite Riegel, nur mit umgekehrtem Vorzeichen.
    //
    // Der Riegel fasst bewusst ENG: gleiche Rechnung, gleicher Zahlbetrag,
    // gleiche Belege. Das schärfere Paar (ZEM_RecNr, ZEM_BelegNr) trüge nur,
    // wenn ZEM_RecNr je Datei eindeutig ist — und das ist NICHT gemessen.
    const blockDoppelt = datei(
      kopf("RE-2026-9001", "70.00", "70.00"), beleg("RE-2026-9001", "1", "70.00"),
      kopf("RE-2026-9001", "70.00", "70.00"), beleg("RE-2026-9001", "1", "70.00"),
    );
    expect(() => parseAvisCsv(blockDoppelt)).toThrow(/Block mehrfach/);

    // Auch die zweimal angehängte Datei — der realistische Auslöser.
    const dateiDoppelt = datei(
      kopf("RE-2026-9001", "70.00", "70.00"), beleg("RE-2026-9001", "1", "70.00"),
      kopf("RE-2026-9002", "30.00", "30.00"), beleg("RE-2026-9002", "1", "30.00"),
      kopf("RE-2026-9001", "70.00", "70.00"), beleg("RE-2026-9001", "1", "70.00"),
      kopf("RE-2026-9002", "30.00", "30.00"), beleg("RE-2026-9002", "1", "30.00"),
    );
    expect(() => parseAvisCsv(dateiDoppelt)).toThrow(/Block mehrfach/);
  });

  it("AP-29 – eine kanonische Nummer in zwei Blöcken wird GEMELDET, nicht abgelehnt", () => {
    // ── Der dritte Ausgang, und warum er hier richtig ist ──
    // Gemessen über 29 Dateien: `ZEM_RecNr` wiederholt sich über Blöcke hinweg
    // in genau zwei Dateien — beide Male Altbestand (`2026-03-06`,
    // `2026-04-06/4`), also kein Schlüssel, sondern ein Zeitraum, und beide
    // Male mit verschiedenen Beträgen. Ein Riegel auf das Paar
    // (RecNr, BelegNr) hätte diese zwei INTAKTEN Dateien abgelehnt.
    //
    // Bei kanonischen Nummern kommt es in den gemessenen Dateien nicht vor.
    // Dort wäre ein Riegel scharf — aber er träfe auch den Fall, den 12
    // Dateien nicht ausschließen: zwei Tranchen auf dieselbe Rechnung. Die
    // sieht aus der Datei heraus genauso aus wie eine Teilverdopplung.
    //
    // Melden statt riegeln: selten genug, dass ein Mensch hinsieht, und
    // mehrdeutig genug, dass eine Maschine nicht entscheiden sollte.
    const zweiTranchen = datei(
      kopf("RE-2026-9001", "70.00", "70.00", { vorgang: "V-A" }), beleg("RE-2026-9001", "1", "70.00"),
      kopf("RE-2026-9001", "30.00", "30.00", { vorgang: "V-B" }), beleg("RE-2026-9001", "1", "30.00"),
    );
    const r = parseAvisCsv(zweiTranchen);
    expect(r.items, "die Datei wurde abgelehnt statt gemeldet").toHaveLength(2);
    expect(r.header.gesamtBetragCents).toBe(10000);
    expect(r.hinweise).toHaveLength(1);
    expect(r.hinweise[0]).toContain("RE-2026-9001");
    expect(r.hinweise[0]).toMatch(/Tranchen|Teilverdopplung/);
  });

  it("AP-30 – eine ALTBESTANDS-Nummer in zwei Blöcken ist kein Hinweis wert", () => {
    // `2026-03-06` ist ein Datum, kein Schlüssel. Dass es sich wiederholt, ist
    // erwartbar und bedeutungslos — gemessen in `Avis_ICL01201.csv`. Ein
    // Hinweis hier wäre Rauschen, und Rauschen macht Hinweise wertlos.
    const altbestand = datei(
      kopf("2026-03-06", "70.00", "70.00", { vorgang: "V-A" }), beleg("2026-03-06", "1", "70.00"),
      kopf("2026-03-06", "30.00", "30.00", { vorgang: "V-B" }), beleg("2026-03-06", "1", "30.00"),
    );
    const r = parseAvisCsv(altbestand);
    expect(r.items).toHaveLength(2);
    expect(r.hinweise, "Altbestands-Wiederholung als Auffälligkeit gemeldet").toEqual([]);
  });

  it("AP-31 – zwei echte Vorgänge mit gleicher Nummer und gleichem Betrag laufen durch", () => {
    // ── Die dritte Wiederholung desselben Musters, gefunden im Review ──
    // Ich hatte geschrieben: „dieselbe Rechnung zweimal mit demselben Betrag
    // im selben Avis hat unter keiner Lesart einen legitimen Fall." Die
    // Messung sagte aber nur, dass gleiche Beträge in DIESEN 29 Dateien nicht
    // vorkommen — daraus folgt nicht „nie".
    //
    // Und im Altbestand ist `ZEM_RecNr` ein ZEITRAUM, kein Schlüssel: zwei
    // Blöcke mit gleichem Zeitraum, gleichem Standardbetrag und je `BelegNr=1`
    // sind dann die intakte Monatsdatei mit zwei Vorgängen. Mein Riegel hat
    // sie abgelehnt.
    //
    // `ZEM_VorgangsNr` trennt die Fälle — gemessen über alle 66 Blöcke: nie
    // leer, blockweit konstant, 0 Mal dieselbe Nummer in zwei Blöcken.
    const zweiVorgaenge = datei(
      kopf("2026-03-06", "70.00", "70.00", { vorgang: "2505802877" }),
      beleg("2026-03-06", "1", "70.00"),
      kopf("2026-03-06", "70.00", "70.00", { vorgang: "2505809999" }),
      beleg("2026-03-06", "1", "70.00"),
    );
    const r = parseAvisCsv(zweiVorgaenge);
    expect(r.items, "zwei echte Vorgänge als Verdopplung abgelehnt").toHaveLength(2);
    expect(r.header.gesamtBetragCents).toBe(14000);
  });

  it("AP-32 – dieselbe VorgangsNr zweimal ist weiterhin eine Verdopplung", () => {
    // Die Gegenprobe zu AP-31: eine zweimal angehängte Datei wiederholt die
    // VorgangsNr mitsamt allem anderen. Ein zusätzliches Feld im
    // Identitäts-Schlüssel kann nur WENIGER ablehnen — es darf den Riegel
    // nicht stumpf machen.
    const verdoppelt = datei(
      kopf("2026-03-06", "70.00", "70.00", { vorgang: "2505802877" }),
      beleg("2026-03-06", "1", "70.00"),
      kopf("2026-03-06", "70.00", "70.00", { vorgang: "2505802877" }),
      beleg("2026-03-06", "1", "70.00"),
    );
    expect(() => parseAvisCsv(verdoppelt)).toThrow(/Block mehrfach/);
  });

  it("AP-33 – der Hinweis greift auf der KANONISIERTEN Nummer, nicht am Rohwert", () => {
    // Der Parser kanonisiert `ZEM_RecNr` über `extractReInvoiceNumber` (O→0,
    // eingeschobene Leerzeichen). Die erste Fassung prüfte mit einem eigenen
    // Regex gegen den ROHWERT — ein dritter Block für eine Frage, für die
    // `avis-match.ts` ausdrücklich eine SSoT führt.
    //
    // Ausgeführt im Review: bei `RE-2026-O212` verwarf der Test beide Blöcke
    // als „Altbestand" und verschluckte den Hinweis. Der Mechanismus, der
    // Altbestand schonen soll, schluckte eine echte kanonische Nummer.
    const mitBuchstabeO = datei(
      kopf("RE-2026-O212", "70.00", "70.00", { vorgang: "V-A" }),
      beleg("RE-2026-O212", "1", "70.00"),
      kopf("RE-2026-0212", "30.00", "30.00", { vorgang: "V-B" }),
      beleg("RE-2026-0212", "1", "30.00"),
    );
    const r = parseAvisCsv(mitBuchstabeO);
    expect(r.items.map(i => i.rechnungsNummer)).toEqual(["RE-2026-0212", "RE-2026-0212"]);
    expect(r.hinweise, "der Hinweis wurde am Rohwert vorbei verschluckt").toHaveLength(1);
    expect(r.hinweise[0]).toContain("RE-2026-0212");
  });

  it("AP-28 – eine Fehlermeldung zitiert KEINEN Zellinhalt", () => {
    // Die Meldung landet als 400 im Toast. Bei einem Feldversatz in der
    // komma-getrennten Datei steht an der Betragsposition irgendein anderer
    // Zellinhalt — und diese Dateien tragen Versichertennamen und -nummern.
    // Feldname und Länge genügen, um die Stelle zu finden.
    const versatz = datei(
      kopf("RE-2026-9001", "70.00", "Musterfrau Erika"),
      beleg("RE-2026-9001", "1", "70.00"),
    );
    try {
      parseAvisCsv(versatz);
      throw new Error("hätte abbrechen müssen");
    } catch (e) {
      const m = (e as Error).message;
      expect(m, "der Zellinhalt steht in der Meldung").not.toContain("Musterfrau");
      expect(m).toContain("KTR_BTR_Zahlg");
      // Die Länge lokalisiert in einer Datei mit 66 Blöcken nichts und ist
      // überdies die NACH `trim()`. `LfdNr` trifft die Zeile genau.
      expect(m, "ohne Ortsangabe ist die Stelle nicht zu finden").toMatch(/LfdNr \d+/);
    }
  });

  it("AP-26 – dieselbe Belegnummer in VERSCHIEDENEN Blöcken ist normal", () => {
    // ── Am 22.09.2026 in Prod aufgefallen ──
    // `Avis_ICL01278.csv` wurde abgelehnt. Nicht weil die Datei kaputt war —
    // sie ist die, deren Aufbau vollständig vermessen vorliegt —, sondern weil
    // der Dublettenriegel dateiweit prüfte.
    //
    // `ZEM_BelegNr` ist die Position INNERHALB einer Avis-Position, kein
    // Schlüssel der Datei: im Fixture `ICL01159` laufen die Nummern 1..5
    // innerhalb EINES Blocks. Eine Datei mit vier 1:1-Blöcken trägt damit
    // viermal die `1`.
    //
    // Der Gate-2-Review hatte genau das benannt („eine Annahme mehr, als
    // gemessen wurde"); ich hatte es als „fail-loud ist die richtige Seite"
    // abgetan. **Ein Riegel auf einer ungemessenen Annahme trifft den
    // Normalfall, nicht den Fehler** — er lehnte jede intakte Mehrblock-Datei
    // ab.
    const vierBloecke = datei(
      kopf("RE-2026-0517", "70.00", "70.00"),   beleg("RE-2026-0517", "1", "70.00"),
      kopf("RE-2026-0508", "123.49", "123.49"), beleg("RE-2026-0508", "1", "123.49"),
      kopf("RE-2026-0510", "76.29", "76.29"),   beleg("RE-2026-0510", "1", "76.29"),
      kopf("RE-2026-0532", "14.56", "14.56"),   beleg("RE-2026-0532", "1", "14.56"),
    );
    const { items, header, pruefsumme } = parseAvisCsv(vierBloecke);
    expect(items).toHaveLength(4);
    expect(header.gesamtBetragCents, "die Vorhersage für ICL01278").toBe(28434);
    expect(pruefsumme.abweichungCents).toBe(0);
    expect(items.map(i => i.betragCents)).toEqual([7000, 12349, 7629, 1456]);
  });
});

describe("Der datei-interne Konsistenzhinweis — was er kann und was nicht", () => {
  it("AP-11 – Forderung der Kopfzeile gegen die ihrer Belege", () => {
    // Verschiedene Zeilen, und sie müssen aufgehen: ein verlorener oder
    // verdoppelter Beleg fällt damit auf.
    const { pruefsumme } = parseAvisCsv(DAVASO_BLOCK_N5);
    expect(pruefsumme.ausPostenCents).toBe(69212);
    expect(pruefsumme.ausgewiesenCents).toBe(69212);
    expect(pruefsumme.abweichungCents).toBe(0);
    expect(pruefsumme.ausAnderenZeilen).toBe(true);
  });

  it("AP-12 – ein fehlender Beleg fällt auf", () => {
    const ohneEinen = DAVASO_BLOCK_N5.split("\n").filter(z => !z.includes(",178.00,")).join("\n");
    const { pruefsumme } = parseAvisCsv(ohneEinen);
    expect(pruefsumme.abweichungCents, "der fehlende Beleg bleibt unbemerkt").not.toBe(0);
  });

  it("AP-13 – eine Kürzung erzeugt KEINE Abweichung (echte Dateistruktur)", () => {
    // ── Der fünfte Fall desselben Musters, gefunden vom VORSCHAU-LAUF ──
    // Dieser Test stand hier mit einem erfundenen Fixture: Kopfzeile fordert
    // 117,19 und zahlt 58,16, Belegzeile trägt die VOLLE Forderung. So sieht
    // die echte Datei nicht aus.
    //
    // `Avis_ICL01267.csv`, die einzige Kürzung im ganzen Bestand, ist zwei
    // Zeilen lang — und die Belegzeile trägt den GEKÜRZTEN Betrag:
    //
    //   Kopfzeile    Forderg 117.19   Zahlg 58.16
    //   Belegzeile   Forderg  58.16
    //
    // Der Test bewachte damit eine Zusage, die die Daten nicht hergeben, und
    // der Vergleich „Kopf-Forderung gegen Beleg-Forderung" meldete im echten
    // Lauf 5903. Auf dem Kürzungs-Pfad war die Zahl damit nicht mehr von einem
    // Parse-Fehler zu unterscheiden.
    //
    // Gefunden hat das weder ich noch ein Review, sondern der Lauf gegen echte
    // Daten — vor dem Schreiben, nicht danach.
    const unterzahlung = datei(
      kopf("RE-2026-0213", "117.19", "58.16"),
      beleg("RE-2026-0213", "1", "58.16"),
    );
    const { pruefsumme, items } = parseAvisCsv(unterzahlung);
    expect(pruefsumme.abweichungCents, "die Kürzung wird als Unstimmigkeit gemeldet").toBe(0);
    // Der Betrag ist von alledem unberührt — er kommt aus `KTR_BTR_Zahlg`.
    expect(items[0].betragCents).toBe(5816);
  });

  it("AP-34 – die andere Lesart bleibt zulässig, ein verlorener Beleg nicht", () => {
    // Zwei Lesarten sind erlaubt, weil nur EINE gemessen ist: die Belegsumme
    // darf die Forderung ODER den Zahlbetrag der Kopfzeile treffen. Aus einem
    // einzigen Kürzungs-Fall eine Konvention zu machen, wäre der Fehler, der
    // an diesem Vorgang schon fünfmal passiert ist.
    //
    // Aufgegeben wird dadurch nichts: eine verlorene oder verdoppelte
    // Belegzeile verfehlt BEIDE Zahlen.
    const andereLesart = datei(
      kopf("RE-2026-0213", "117.19", "58.16"),
      beleg("RE-2026-0213", "1", "117.19"),
    );
    expect(parseAvisCsv(andereLesart).pruefsumme.abweichungCents,
      "die zweite Lesart wird als Unstimmigkeit gemeldet").toBe(0);

    const belegVerloren = datei(
      kopf("RE-2026-9100", "100.00", "100.00"),
      beleg("RE-2026-9100", "1", "70.00"),
    );
    expect(parseAvisCsv(belegVerloren).pruefsumme.abweichungCents,
      "der verlorene Beleg bleibt unbemerkt").toBe(3000);
  });

  it("AP-35 – wo nur EINE Lesart aufgeht, wird es gemeldet", () => {
    // ── Der Satz „gibt nichts auf" war falsch, gefunden im Review ──
    // Die zweite Lesart fügt einen ZWEITEN NULLPUNKT hinzu, und der liegt
    // genau dort, wo der plausibelste Dateifehler landet: die Kasse skontiert
    // oder kürzt GENAU die Positionen, die die Differenz ausmachen — fällt
    // eine davon weg, trifft die Belegsumme exakt den Zahlbetrag.
    //
    //   Kopf  Forderg 100.00  Zahlg 95.00  Skonto 5.00
    //   Beleg 1  95.00
    //   Beleg 2   5.00        ← geht verloren   → Abweichung 0 statt 500
    //
    // Der Satz war nur dort wahr, wo die Doppel-Lesart gar nichts tut
    // (Forderung = Zahlbetrag, 65 von 66), und falsch überall dort, wo sie
    // wirkt. AP-34 prüfte ihn mit einer Kopfzeile 100.00/100.00 — also in der
    // Region, in der er nicht fallen KANN.
    //
    // Eine Lesart zu streichen wäre wieder der Sprung von einer Datenmenge zur
    // Konvention. Also wird der Graubereich sichtbar gemacht statt geschlossen.
    const skontoBlockVollstaendig = datei(
      kopf("RE-2026-9100", "100.00", "95.00", { skonto: "5.00" }),
      beleg("RE-2026-9100", "1", "95.00"),
      beleg("RE-2026-9100", "2", "5.00"),
    );
    const ohneSkontoZeile = datei(
      kopf("RE-2026-9100", "100.00", "95.00", { skonto: "5.00" }),
      beleg("RE-2026-9100", "1", "95.00"),
    );

    // Beide melden 0 — die verlorene Zeile ist aus der Zahl NICHT ablesbar.
    expect(parseAvisCsv(ohneSkontoZeile).pruefsumme.abweichungCents).toBe(0);

    // Beide tragen einen Hinweis — und JEDER nennt die Ursache SEINES Zweigs.
    //
    // Die erste Fassung prüfte nur `/nur gegen (den Zahlbetrag|die Forderung)/`
    // und akzeptierte damit beide Zweige für beide Fixtures. In genau dieser
    // Lücke saß der Fehler, den der zweite Gate-2-Durchgang fand: der Text
    // nannte in BEIDEN Zweigen „eine fehlende Belegzeile" — im
    // Forderungs-Zweig die einzige Ursache, die es NICHT sein kann.
    const vollstaendig = parseAvisCsv(skontoBlockVollstaendig).hinweise;
    expect(vollstaendig, "der Graubereich bleibt still").toHaveLength(1);
    expect(vollstaendig[0], "Belegsumme trifft die Forderung").toMatch(/nur gegen die FORDERUNG/);
    expect(vollstaendig[0], "nennt die unmögliche Ursache").toMatch(/UEBERZAEHLIGE/);
    expect(vollstaendig[0]).not.toMatch(/FEHLENDE Belegzeile/);

    const unvollstaendig = parseAvisCsv(ohneSkontoZeile).hinweise;
    expect(unvollstaendig, "der Graubereich bleibt still").toHaveLength(1);
    expect(unvollstaendig[0], "Belegsumme trifft den Zahlbetrag").toMatch(/nur gegen den ZAHLBETRAG/);
    expect(unvollstaendig[0], "die zutreffende Ursache fehlt").toMatch(/FEHLENDE Belegzeile/);
  });

  it("AP-38 – gleichartige Blöcke ergeben EINEN Hinweis, nicht N", () => {
    // Die Bedingung ist kein Anomalie-Prädikat, sondern „dieser Block wurde
    // gekürzt oder skontiert und ist in sich stimmig" — der intakte
    // Geschäftsfall. Eine Kasse, die systematisch nur ihren Anteil zahlt,
    // erzeugt ihn auf JEDEM Block.
    //
    // Zwölf gleichlautende Hinweise wären genau das Rauschen, das einen
    // Hinweis-Kanal wertlos macht — und dann ist er schlimmer als keiner.
    const zeilen = Array.from({ length: 12 }, (_, i) => {
      const nr = `RE-2026-91${String(i).padStart(2, "0")}`;
      return [kopf(nr, "100.00", "95.00", { skonto: "5.00" }), beleg(nr, "1", "95.00")];
    }).flat();
    const r = parseAvisCsv(datei(...zeilen));

    expect(r.hinweise, "zwölf Blöcke ergeben zwölf Hinweise").toHaveLength(1);
    expect(r.hinweise[0]).toMatch(/^12 Block/);
    expect(r.hinweise[0], "die betroffenen Nummern fehlen").toContain("RE-2026-9100");
    expect(r.hinweise[0]).toContain("RE-2026-9111");
  });

  it("AP-36 – eine leere Kopf-Forderung wird gemeldet, nicht abgelehnt", () => {
    // `parseBetragCents` bildet "" auf 0 ab — unter der Zahlbetrags-Lesart
    // ginge eine leere Kopf-Forderung lautlos durch. Sichtbar muss sie sein.
    //
    // ABGELEHNT wird sie aber nicht, und das war kurzzeitig anders. Der
    // zweite Gate-2-Durchgang hat es kassiert: „leere Kopf-Forderung" und
    // „Block ohne Belegzeile" sind mit 0 von 66 GLEICH gut belegt, und die
    // eine bekam den Riegel, die andere die Begründung dagegen — im selben
    // Commit, zwanzig Zeilen auseinander.
    //
    // Dazu speist `ZEM_BTR_Forderg` ausschließlich diesen Hinweis; das Geld
    // kommt aus `KTR_BTR_Zahlg`. Eine Datei abzulehnen, deren Beträge
    // vollständig lesbar sind, ist die falsche Seite von fail-loud.
    const ohneForderung = datei(
      kopf("RE-2026-9100", "", "70.00"),
      beleg("RE-2026-9100", "1", "70.00"),
    );
    const r = parseAvisCsv(ohneForderung);
    expect(r.items[0].betragCents, "der Betrag ist unberührt").toBe(7000);
    expect(r.hinweise).toHaveLength(1);
    expect(r.hinweise[0]).toMatch(/ohne ZEM_BTR_Forderg/);
  });

  it("AP-37 – ein Block ohne Belegzeile wird gemeldet, nicht übergangen", () => {
    // Er fällt aus der Prüfung heraus (`filter(posten.length > 0)`) — gemessen
    // kommt er in 0 von 66 Blöcken vor. Eine ungemessene Form still zu
    // übergehen ist das Muster, das hier sechsmal danebenging; ein Riegel
    // darauf wäre wieder eine Annahme über die Messung hinaus.
    const ohneBeleg = datei(kopf("RE-2026-9100", "100.00", "100.00"));
    const r = parseAvisCsv(ohneBeleg);
    expect(r.hinweise).toHaveLength(1);
    expect(r.hinweise[0]).toMatch(/ohne Belegzeile/);
  });

  it("AP-14 – und er ist per Konstruktion blind gegen einen SKALENFEHLER", () => {
    // Der Beleg, warum der Riegel die Datei verlassen musste: beide Zahlen
    // kommen durch denselben `parseBetragCents`-Aufruf und skalieren mit.
    //
    // Dieser Test darf NICHT dadurch grün werden, dass jemand den
    // datei-internen Vergleich „repariert". Er hält fest, was diese Prüfung
    // NICHT kann, damit sie nie wieder als der Riegel ausgegeben wird
    // (siehe `server/services/avis-rechnungsabgleich.ts`).
    const skaliert = datei(
      kopf("RE-2026-9001", "7000.00", "7000.00"),
      beleg("RE-2026-9001", "B-1", "7000.00"),
    );
    const { pruefsumme, items } = parseAvisCsv(skaliert);
    expect(pruefsumme.abweichungCents, "der datei-interne Vergleich fängt Skalenfehler").toBe(0);
    expect(items[0].betragCents).toBe(700000);
  });
});

describe("Avis-Dateien aus der Praxis — Verpackung, Spalten, Fremddateien", () => {
  const BOM = "﻿";

  it("AP-15 – BOM und CRLF ändern am Ergebnis nichts (Kassen-Familie)", () => {
    // Die Windows-Verpackung, in der 22 BARMER-Dateien ankommen. Ein
    // unbehandeltes BOM macht aus `1;` ein `﻿1;` — die Formaterkennung
    // fiele durch, und die Datei wäre „Format nicht erkannt" statt eingelesen.
    const roh = parseAvisCsv(KASSEN);
    const verpackt = parseAvisCsv(BOM + KASSEN.replace(/\n/g, "\r\n"));
    expect(verpackt.header.format).toBe("kassen-csv");
    expect(verpackt.items.map(i => i.betragCents)).toEqual(roh.items.map(i => i.betragCents));
    expect(verpackt.header.zahlungsempfaengerIban, "das CR hängt am letzten Feld")
      .toBe(roh.header.zahlungsempfaengerIban);
  });

  it("AP-16 – BOM und CRLF ändern am Ergebnis nichts (DAVASO)", () => {
    const roh = parseAvisCsv(DAVASO_1ZU1);
    const verpackt = parseAvisCsv(BOM + DAVASO_1ZU1.replace(/\n/g, "\r\n"));
    expect(verpackt.header.format).toBe("davaso");
    expect(verpackt.items.map(i => i.betragCents)).toEqual(roh.items.map(i => i.betragCents));
    expect(verpackt.pruefsumme.abweichungCents).toBe(0);
  });

  it("AP-17 – DAVASO wird über SPALTENNAMEN gelesen, nicht über Positionen", () => {
    // Das Regressions-Sample im Repo führt zusätzlich `AvisPos` an zweiter
    // Stelle. Eine feste Index-Lesung würde dort still das Nachbarfeld
    // greifen — beim Betrag hieße das: ein Datum als Geldbetrag.
    const mitZusatzspalte = DAVASO_1ZU1.split("\n").map((z, i) =>
      i === 0 ? z.replace("LfdNr,", "LfdNr,AvisPos,") : z.replace(/^(\d+),/, "$1,1,"),
    ).join("\n");
    const r = parseAvisCsv(mitZusatzspalte);
    expect(r.items.map(i => i.betragCents)).toEqual([7000, 12349, 7629, 1456]);
    expect(r.header.kostentraegerName).toBe("Testkasse");
    expect(r.pruefsumme.abweichungCents).toBe(0);
  });

  it("AP-19 – die Rechnungsnummer wird kanonisiert wie im Kassen-Pfad", () => {
    // Der Kassen-Pfad normalisiert seit jeher (O→0, eingeschobene Leerzeichen
    // wie in `RE-2026- 0212`); DAVASO nahm `ZEM_RecNr` roh. Zwei Arten,
    // dieselbe Frage zu beantworten — und eine Nummer mit so einer Eigenheit
    // fände der Rechnungsabgleich nicht. Das Ergebnis wäre `ungeprueft`: kein
    // falscher Betrag, aber eine ausgelassene Prüfung, die wie ein Befund
    // aussieht.
    const mitLeerzeichen = datei(
      kopf("RE-2026- 0213", "117.19", "58.16"),
      beleg("RE-2026- 0213", "B-1", "117.19"),
    );
    expect(parseAvisCsv(mitLeerzeichen).items[0].rechnungsNummer).toBe("RE-2026-0213");
  });

  it("AP-20 – der Altbestand bleibt stehen, statt „repariert“ zu werden", () => {
    // 41 von 66 gemessenen Kopfzeilen nennen keine EngelDesk-Nummer, sondern
    // ein Muster wie `2026-01-123` oder ein Datum — der Bestand vor Juli 2026.
    // Das ist keine kaputte Rechnungsnummer, das ist die Realität von damals.
    //
    // Ein Parser, der daraus etwas macht, das wie eine Nummer aussieht,
    // ERFINDET Daten; einer, der sie verwirft, verschweigt sie. Sie bleibt roh
    // und landet sichtbar im `ungeprueft`-Ausgang des Rechnungsabgleichs.
    const altbestand = datei(
      kopf("2026-01-02", "692.12", "692.12"),
      beleg("2026-01-02", "1", "692.12"),
    );
    expect(parseAvisCsv(altbestand).items[0].rechnungsNummer).toBe("2026-01-02");
  });

  it("AP-18 – eine fremde Datei wird laut abgelehnt, nicht leer eingelesen", () => {
    // Der gefährliche Ausgang wäre nicht der Fehler, sondern ein Avis mit null
    // Posten und 0,00 € — formal angelegt, inhaltlich nichts, und niemandem
    // fällt auf, dass die Datei nie ankam.
    expect(() => parseAvisCsv("Datum;Betrag;Text\n01.09.2026;150,00;Irgendwas"))
      .toThrow(/Format nicht erkannt/);
    expect(() => parseAvisCsv("")).toThrow();
  });
});

/**
 * Gate 2, zweiter Durchgang (S1/S6). Die Frage war: bricht die Bauform bei
 * einer abweichenden Datei LAUT ab, oder liest sie still etwas Falsches?
 *
 * Die Antwort war „still" — und das ist der gefährlichere Ausgang. Ein
 * vollständig falsch gelesenes Avis wäre mit lauter Nullposten angelegt
 * worden, der datei-interne Hinweis hätte grün gemeldet (0 gegen 0), und der
 * Rechnungsabgleich hätte `unterzahlung` gesagt — die blockiert bewusst nicht.
 * „66 von 66 unterzahlt" wäre von echten Kürzungen nur durch Hinsehen zu
 * unterscheiden gewesen.
 */
describe("DAVASO — eine abweichende Datei bricht ab, statt still zu lügen", () => {
  it("AP-21 – eine fehlende Pflichtspalte ist ein Abbruch", () => {
    // `getField` liefert für eine unbekannte Spalte `""` — und `""` ist von
    // einem echten Leerwert nicht zu unterscheiden. Der Riegel steht deshalb
    // am Header, wo der Fehler entsteht.
    const umbenannt = DAVASO_1ZU1.replace("KTR_BTR_Zahlg", "KTR_BTR_Zahlung");
    expect(() => parseAvisCsv(umbenannt)).toThrow(/Pflichtspalten/);

    const ohneBeleg = DAVASO_1ZU1.replace("ZEM_BelegNr", "ZEM_Beleg_Nr");
    expect(() => parseAvisCsv(ohneBeleg)).toThrow(/Pflichtspalten/);
  });

  it("AP-22 – eine Kopfzeile ohne Zahlbetrag ist ein Abbruch, kein 0-ct-Posten", () => {
    const leer = datei(
      kopf("RE-2026-9001", "70.00", ""),
      beleg("RE-2026-9001", "B-1", "70.00"),
    );
    expect(() => parseAvisCsv(leer)).toThrow(/KTR_BTR_Zahlg/);
  });

  it("AP-23 – unlesbar bricht ab, `0.00` bleibt erlaubt", () => {
    // Die Unterscheidung, die `parseBetragCents` nicht treffen konnte: es
    // bildet `""` UND `NaN` auf 0 ab. Ein Avis über 0,00 € ist denkbar; ein
    // Avis, dessen Betrag niemand lesen konnte, ist es nicht.
    const muell = datei(
      kopf("RE-2026-9001", "70.00", "n.a."),
      beleg("RE-2026-9001", "B-1", "70.00"),
    );
    expect(() => parseAvisCsv(muell)).toThrow(/kein Betrag/);

    const null_euro = datei(
      kopf("RE-2026-9001", "0.00", "0.00"),
      beleg("RE-2026-9001", "B-1", "0.00"),
    );
    expect(parseAvisCsv(null_euro).items[0].betragCents).toBe(0);
  });

  it("AP-24 – eine Belegzeile im falschen Block bricht ab", () => {
    // Die gemessene Invariante (114 von 114: Belegzeile trägt dieselbe
    // `ZEM_RecNr` wie ihre Kopfzeile) lag gratis da und wurde nicht geprüft.
    // Sie ist der einzige Weg, einen falschen Block-Zuschlag zu bemerken —
    // betragsneutral, aber die Belegnummern stünden danach persistiert an der
    // falschen Rechnung.
    const falschZugeordnet = datei(
      kopf("RE-2026-9001", "70.00", "70.00"),
      beleg("RE-2026-9002", "B-1", "70.00"),      // gehört zu einem anderen Block
    );
    expect(() => parseAvisCsv(falschZugeordnet)).toThrow(/Block-Zuordnung/);
  });

  it("AP-25 – die Prüfsumme je Block hebt sich nicht mehr auf", () => {
    // Global summiert glichen sich zwei entgegengesetzte Fehler aus: ein Block
    // mit einem Beleg zu viel, einer mit einem zu wenig, Differenz 0. Der
    // Docblock versprach, ein verlorener Posten falle auf — global tat er das
    // nicht.
    const gegenlaeufig = datei(
      kopf("RE-2026-9001", "100.00", "100.00"),
      beleg("RE-2026-9001", "B-1", "110.00"),     // 10,00 € zu viel
      kopf("RE-2026-9002", "100.00", "100.00"),
      beleg("RE-2026-9002", "B-2", "90.00"),      // 10,00 € zu wenig
    );
    const { pruefsumme } = parseAvisCsv(gegenlaeufig);
    expect(pruefsumme.ausPostenCents, "global gleichen sich die Fehler aus").toBe(20000);
    expect(pruefsumme.ausgewiesenCents).toBe(20000);
    expect(pruefsumme.abweichungCents, "die Fehler gleichen sich wieder aus").toBe(2000);
  });
});

/**
 * Die Kopffelder der `3;`-Zeile — strukturell statt positionell.
 *
 * ── Der Prod-Fall (Avis 41, AOK, 22.09.2026) ────────────────────────────
 * Feste Indizes ergaben: `belegNummer = 130050598` (die Kostenträger-IK),
 * `zahlungsDatum = "82051000"` (kein Datum), `IBAN = "EUR"`.
 *
 * Die Folge saß zwei Ebenen weiter: `mark-paid` rechnet
 * `paidAt = parseLocalDate(zahlungsDatum)` → `Invalid Date` → der Treiber
 * lehnt ab → Rollback → **„Als bezahlt markieren" ist für diese Avise seit
 * Juli unbenutzbar**, 49 gebundene Rechnungen über 5.798,66 €.
 *
 * ── Warum nicht „Breite als Schlüssel" ──────────────────────────────────
 * Gemessen über alle 53 Kassen-Dateien gibt es DREI Belegungen, und bei
 * 33 von 53 Zeilen ist sie bei gleicher Feldzahl uneinheitlich. Die Breite
 * identifiziert das Layout nicht — das war der erste Vorschlag und ist durch
 * die Messung widerlegt.
 */
describe("Kassen-CSV — Kopffelder strukturell erkannt", () => {
  const kasse = (dreiZeile: string) => [
    "1;461438852;Senioren Engel;",
    "2;853010969199;01.06.2026;27.06.2026 RE-2026- 0212;262,00;+;EUR;",
    dreiZeile,
  ].join("\n");

  it("AP-39 – das Datum wird gefunden, egal an welcher Position es steht", () => {
    // Keine der 53 gemessenen `3;`-Zeilen trägt zwei Datums-Felder — das
    // macht „das Feld, das wie ein Datum aussieht" eindeutig.
    const breite6 = kasse("3;769501965926;07.01.2026;340,17;DE92100101237314306198;");
    const breite13 = kasse("3;130050598;82051000;5798,66;EUR;TEXT;24.04.2026;;;;;;");
    expect(parseAvisCsv(breite6).header.zahlungsDatum).toBe("2026-01-07");
    expect(parseAvisCsv(breite13).header.zahlungsDatum, "82051000 als Datum gelesen")
      .toBe("2026-04-24");
  });

  it("AP-40 – `82051000` ist kein Datum und wird nicht eins", () => {
    // Der Wert, der drei Avise seit Juli unbezahlbar gemacht hat. Steht in
    // der Datei kein Datum, ist das Feld `null` — nicht der Rohwert.
    const ohneDatum = kasse("3;130050598;82051000;5798,66;EUR;");
    expect(parseAvisCsv(ohneDatum).header.zahlungsDatum).toBeNull();
  });

  it("AP-41 – die Kostenträger-IK wird nicht als Belegnummer gespeichert", () => {
    // Die naheliegende Regel — „die erste lange Ziffernfolge, die kein Betrag
    // und kein Datum ist" — griffe hier auf 130050598, also genau auf die IK:
    // sie reproduziert den Bug, den sie beheben soll. IK und Belegnummer sind
    // durch ihre Gestalt NICHT unterscheidbar.
    //
    // Deshalb wird die Belegnummer nur dort gelesen, wo die Messung sie deckt
    // (Breite 6, 19 von 19 Zeilen einheitlich) — sonst bleibt sie leer.
    const aok = kasse("3;130050598;82051000;5798,66;EUR;TEXT;24.04.2026;;;;;;");
    expect(parseAvisCsv(aok).header.belegNummer, "die IK steht als Belegnummer").toBeNull();

    const barmer = kasse("3;769501965926;07.01.2026;340,17;DE92100101237314306198;");
    expect(parseAvisCsv(barmer).header.belegNummer).toBe("769501965926");
  });

  it("AP-42 – `EUR` ist keine IBAN", () => {
    const aok = kasse("3;130050598;82051000;5798,66;EUR;TEXT;24.04.2026;;;;;;");
    expect(parseAvisCsv(aok).header.zahlungsempfaengerIban).toBeNull();

    const barmer = kasse("3;769501965926;07.01.2026;340,17;DE92100101237314306198;");
    expect(parseAvisCsv(barmer).header.zahlungsempfaengerIban)
      .toBe("DE92100101237314306198");
  });

  it("AP-43 – der Betrag bleibt unberührt, ist aber NICHT strukturell erkannt", () => {
    // ── Richtigstellung: der Kommentar hier behauptete das Gegenteil ──
    // „Der Betrag wird seit #1687 strukturell erkannt und ist der einzige
    // Wert, der überall stimmt" — das gilt für die `2;`-Zeilen.
    // `detectAmountFieldIndex` läuft NUR im `lineType === "2"`-Zweig; der
    // Gesamtbetrag der `3;`-Zeile liest weiterhin `parts[3]`.
    const aok = kasse("3;130050598;82051000;5798,66;EUR;TEXT;24.04.2026;;;;;;");
    expect(parseAvisCsv(aok).header.gesamtBetragCents).toBe(579866);

    // Und so sieht der Fall aus, den `parts[3]` nicht kann: laut Messung ist
    // `[3]` in 8 von 53 Zeilen leer, der Betrag steht dann bei `[5]`.
    // `|| "0"` macht daraus eine 0 — die als ausgewiesene Summe gilt.
    //
    // Vorbestehend, nicht von diesem PR erzeugt, und bewusst NICHT hier
    // behoben: der Umbau braucht eine eigene Messung (gibt es Zeilen mit ZWEI
    // Komma-Dezimalfeldern?). Der Test hält den Ist-Zustand fest, damit die
    // Lücke sichtbar bleibt statt als „geprüft" zu gelten — siehe FINDING im PR.
    const betragBeiFuenf = kasse("3;123456789;ABC;;07.01.2026;49,13;775335315683;");
    expect(parseAvisCsv(betragBeiFuenf).header.gesamtBetragCents,
      "der Betrag bei [5] wird jetzt gefunden — dann gehört dieser Test umgeschrieben")
      .toBe(0);
  });

  it("AP-44 – die AOK-Zeile mit SECHS Feldern schreibt die IK nicht", () => {
    // ── B1 aus Gate 2: `parts.length === 6` war der falsche Zeuge ──
    // Diese Zeile liegt seit Task #1687 als Fixture im Repo
    // (`avis-parser-regression.test.ts`) — und die erste Fassung des Fixes
    // schrieb dort weiterhin die Kostenträger-IK als Belegnummer, also genau
    // den Defekt, gegen den dieser PR gebaut ist.
    //
    // Der Denkfehler war die Deckung der Messung: der IK-Gegencheck lief über
    // die 30 IBAN-Zeilen; diese trägt bei [4] `EUR` und ist keine.
    const sechsFelder = kasse("3;130050598;82051000;301,26;EUR;");
    const h = parseAvisCsv(sechsFelder).header;
    expect(h.belegNummer, "die IK steht als Belegnummer").toBeNull();
    expect(h.zahlungsDatum).toBeNull();
    expect(h.zahlungsempfaengerIban).toBeNull();
  });

  it("AP-45 – der Layout-Zeuge hängt nicht am abschließenden Semikolon", () => {
    // Die alte „6" bedeutete fünf Felder PLUS Schluss-Semikolon. Dieselbe
    // BARMER-Zeile ohne es hatte sieben Felder und verlor die Belegnummer —
    // obwohl `[1]` dieselbe Rolle trägt.
    const mit = kasse("3;769501965926;07.01.2026;340,17;DE92100101237314306198;");
    const ohne = kasse("3;769501965926;07.01.2026;340,17;DE92100101237314306198");
    for (const [name, csv] of [["mit", mit], ["ohne", ohne]] as const) {
      expect(parseAvisCsv(csv).header.belegNummer, `${name} Schluss-Semikolon`)
        .toBe("769501965926");
    }
  });

  it("AP-46 – die IBAN: normalisiert gesucht, bei Mehrdeutigkeit null", () => {
    // Für das DATUM gibt es eine Eindeutigkeits-Messung („keine der 53 Zeilen
    // trägt zwei"). Für die IBAN gibt es KEINE — „der erste Treffer gewinnt"
    // wäre dort eine Annahme ohne Messung. Sie wiegt schwer, weil die IBAN bei
    // der Kassen-Familie der einzige Diskriminator ist und ein rückwirkendes
    // Auto-Close gatet.
    const mitLeerzeichen = kasse("3;769501965926;07.01.2026;340,17;DE92 1001 0123 7314 3061 98;");
    expect(parseAvisCsv(mitLeerzeichen).header.zahlungsempfaengerIban)
      .toBe("DE92100101237314306198");

    const zweiKandidaten = kasse("3;RE20260212000123;07.01.2026;340,17;DE92100101237314306198;");
    expect(parseAvisCsv(zweiKandidaten).header.zahlungsempfaengerIban,
      "bei zwei Kandidaten gewinnt der erste").toBeNull();
  });

  it("AP-47 – ein unmögliches Datum ist kein Datum", () => {
    // `32.13.2026` passierte das Muster und wurde zu `2026-13-32`;
    // `parseLocalDate` rollt das still zu Februar 2027 durch. Die Zusage
    // „null oder gültiges ISO" trägt erst mit der Bereichsprüfung.
    const unmoeglich = kasse("3;769501965926;32.13.2026;340,17;DE92100101237314306198;");
    const r = parseAvisCsv(unmoeglich);
    expect(r.header.zahlungsDatum).toBeNull();
    // Und es wird gemeldet, nicht verschwiegen — sonst fällt es erst dem auf,
    // der Wochen später abschließen will.
    expect(r.hinweise.some(h => /Zahlungsdatum/.test(h)),
      "die Vorschau schweigt über das fehlende Datum").toBe(true);
  });
});
