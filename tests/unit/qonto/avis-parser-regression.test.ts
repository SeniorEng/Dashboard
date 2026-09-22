/**
 * Task #1687 — Phase 0: Regressions-Snapshot des Avis-Parsers VOR dem Umbau.
 *
 * Der Parser (`server/services/avis-parser.ts`) ist rein (keine DB), daher ein
 * schneller Unit-Test. Er friert die HEUTIGEN, FINANZIELL RELEVANTEN Ergebnisse
 * der echten Kassen-Samples ein: Betrag je Position (Integer-Cents), Gesamtbetrag,
 * Positionsanzahl und das erkannte Format. Diese Werte dürfen sich beim
 * strukturellen Umbau NICHT verändern (Regressionssicherung für DAVASO/IKK und die
 * `1;`-Formate).
 *
 * Die Fixtures sind wörtliche (aber kundenneutral belassene) Kopien der echten
 * Samples aus `attached_assets/` — inline, damit der Test nicht von der
 * Verfügbarkeit der Asset-Dateien abhängt.
 */

import { describe, it, expect } from "vitest";
import { parseAvisCsv } from "../../../server/services/avis-parser";

// --- Echte SAP-56020-Samples (…461438852 = UNSERE Zahlungsempfänger-IK). ---
// `2;`-Positionszeilen: Betrag steht an Feld-Index 4 (vor `+`/`EUR`).
const SAP_A = [
  "1;461438852;Senioren Engel Alltagsbegleitung UG (haftungsbeschränkt), Zwickauer Str. 145, 09116 Chemnitz;",
  "2;4000000618348494/007/2025;2025-08-03, 01.08.2025 - 31.08.2025;31.12.2025;49,13;+;EUR;",
  "2;4000000618348494/007/2025;09/2025, 01.09.2025 - 30.09.2025;31.12.2025;81,88;+;EUR;",
  "3;775335315683;05.01.2026;131,01;DE92100101237314306198;",
].join("\n");

const SAP_B = [
  "1;461438852;Senioren Engel Alltagsbegleitung UG (haftungsbeschränkt), Zwickauer Str. 145, 09116 Chemnitz;",
  "2;4000000653731837/004/2026;2025-12-03_4, 01.12.2025 - 31.12.2025;19.02.2026;88,55;+;EUR;",
  "2;Schröder,R.,Z817157321;03.02.2026 2025-09-08;19.02.2026;163,75;+;EUR;",
  "3;740335405540;19.02.2026;252,30;DE92100101237314306198;",
].join("\n");

const SAP_C = [
  "1;461438852;Senioren Engel Alltagsbegleitung UG (haftungsbeschränkt), Zwickauer Str. 145, 09116 Chemnitz;",
  "2;Jungnickel,B.,G192083809;26.12.2025 2025-11-03;31.12.2025;131,00;+;EUR;",
  "2;Kraft,D.,Y800652371;26.12.2025 2025-11-03;31.12.2025;90,06;+;EUR;",
  "2;Schade,R.,W255296774;26.12.2025 2025-11-03;31.12.2025;119,11;+;EUR;",
  "3;769501965926;07.01.2026;340,17;DE92100101237314306198;",
].join("\n");

// --- Echtes IKK-Classic-DAVASO-Sample (Header `LfdNr,…`), wörtliche Kopie. ---
// KORRIGIERT am 21.09.2026 (P1 6hXqFcc2hRQfC9qp). Vorher stand hier:
//
//   „Die DAVASO-Beträge werden HEUTE ×100 zu groß interpretiert (`127.32` →
//    1273200 Cent) — das ist eine bestehende DAVASO-Eigenheit AUSSERHALB dieses
//    Tasks. Der Snapshot friert bewusst das IST-Verhalten ein."
//
// Das war kein Snapshot einer Eigenheit, sondern eines Fehlers. Am 21.09.2026
// lief der DAVASO-Pfad zum ersten Mal in Prod und schrieb zwei Avise mit exakt
// diesem Faktor 100 — 28.149,66 € und 56.960,64 € „Überzahlung". Der Test war
// die ganze Zeit grün und hat den Fehler mitgetragen: er prüfte, dass sich
// nichts ändert, statt dass etwas stimmt.
//
// Das ist dieselbe Klasse wie ID-4 in #154 (ein Test, der den Port als Teil des
// Hosts festnagelte und damit ein Passwort-Leck deckte): ein Test, der
// VERHALTEN zementiert, prüft keine Zusage — er verteidigt den Ist-Zustand,
// auch gegen dessen Reparatur. Wer ein Ist-Verhalten einfriert, das er selbst
// für falsch hält, muss es als Befund melden, nicht als Sollwert schreiben.
//
// Struktur des Samples (maßgeblich für die Summenzeilen-Erkennung): Zeile 1 hat
// KEINE `ZEM_BelegNr` und trägt in `KTR_BTR_Zahlg` den Gesamtbetrag 692.12;
// die fünf Postenzeilen tragen Belegnummern und lassen `KTR_BTR_Zahlg` leer.
const IKK_DAVASO = [
  "LfdNr,AvisPos,AVISNr,KTR_IK,KTR_Name,ZEM_IK,ZEM_IBAN,ZEM_RecNr,ZEM_BelegNr,ZEM_VorgangsNr,ZEM_RecDatum,ZEMRecEingDatum,ZEM_BTR_Forderg,KTR_BTR_Zahlg,KTR_BTR_Skonto,KTR_BTR_DTA_Kuerzg,Datum_ZahlungAusfuehrg",
  "1,1,ICL01159,183500693,IKK classic,461438852,DE92100101237314306198,2026-01-02,,2505802877,13.02.2026,16.02.2026,692.12,692.12,0.00,0.00,26.02.2026",
  "2,1,ICL01159,183500693,IKK classic,461438852,DE92100101237314306198,2026-01-02,1,2505802877,13.02.2026,16.02.2026,127.32,,0.00,,",
  "3,1,ICL01159,183500693,IKK classic,461438852,DE92100101237314306198,2026-01-02,2,2505802877,13.02.2026,16.02.2026,230.61,,0.00,,",
  "4,1,ICL01159,183500693,IKK classic,461438852,DE92100101237314306198,2026-01-02,3,2505802877,13.02.2026,16.02.2026,68.73,,0.00,,",
  "5,1,ICL01159,183500693,IKK classic,461438852,DE92100101237314306198,2026-01-02,4,2505802877,13.02.2026,16.02.2026,87.46,,0.00,,",
  "6,1,ICL01159,183500693,IKK classic,461438852,DE92100101237314306198,2026-01-02,5,2505802877,13.02.2026,16.02.2026,178.00,,0.00,,",
].join("\n");

describe("Task #1687 — Parser-Regressions-Snapshot (Betrag/Gesamt/Anzahl)", () => {
  it("SAP-Sample A: Betrag aus dem richtigen Feld (nicht dem Datum)", () => {
    const r = parseAvisCsv(SAP_A);
    expect(r.items.map(i => i.betragCents)).toEqual([4913, 8188]);
    expect(r.header.gesamtBetragCents).toBe(13101);
    expect(r.header.zahlungsempfaengerIk).toBe("461438852");
    expect(r.header.zahlungsDatum).toBe("2026-01-05");
  });

  it("SAP-Sample B: gemischte Referenzformate, Beträge stabil", () => {
    const r = parseAvisCsv(SAP_B);
    expect(r.items.map(i => i.betragCents)).toEqual([8855, 16375]);
    expect(r.header.gesamtBetragCents).toBe(25230);
  });

  it("SAP-Sample C: drei Positionen, Beträge stabil", () => {
    const r = parseAvisCsv(SAP_C);
    expect(r.items.map(i => i.betragCents)).toEqual([13100, 9006, 11911]);
    expect(r.header.gesamtBetragCents).toBe(34017);
  });

  it("IKK/DAVASO: EIN Block, EIN Posten — 692,12 € in Cent", () => {
    // ── Dritte Korrektur an derselben Erwartung, dritter falscher Modellteil ──
    //  1. „×100 ist eine DAVASO-Eigenheit"  → war ein Fehler, kein Format.
    //  2. „5 Positionen"                    → sind fünf BELEGE EINER Rechnung.
    //  3. Beträge aus `ZEM_BTR_Forderg`     → der Avis sagt, was GEZAHLT wurde.
    //
    // Dieses Sample ist EIN Block: eine Kopfzeile (ohne `ZEM_BelegNr`, mit
    // `KTR_BTR_Zahlg` = 692.12) und fünf Belegzeilen, die alle dieselbe
    // `ZEM_RecNr` tragen. Das ist eine Rechnung, nicht fünf — an 29 Dateien
    // gemessen: `ZEM_RecNr` je Block genau eine, 0 Abweichungen.
    const r = parseAvisCsv(IKK_DAVASO);
    expect(r.header.format).toBe("davaso");
    expect(r.items, "die fünf Belege wurden wieder zu fünf Posten").toHaveLength(1);
    expect(r.items[0].betragCents).toBe(69212);
    expect(r.items[0].belegNr).toBe("1, 2, 3, 4, 5");
    expect(r.header.gesamtBetragCents).toBe(69212);
    expect(r.header.kostentraegerName).toBe("IKK classic");
    expect(r.header.kostentraegerIk).toBe("183500693");
  });

  it("IKK/DAVASO: die Belegzeilen bestätigen die Forderung der Kopfzeile", () => {
    // Der datei-interne Konsistenzhinweis: Forderung gegen Forderung, aus
    // VERSCHIEDENEN Zeilen — ein verlorener oder verdoppelter Beleg fällt auf.
    // Er ist ausdrücklich NICHT der Riegel: beide Zahlen kommen durch denselben
    // Parser und skalieren bei einem Faktor-100-Fehler gemeinsam mit.
    const r = parseAvisCsv(IKK_DAVASO);
    expect(r.pruefsumme.ausPostenCents).toBe(69212);
    expect(r.pruefsumme.ausgewiesenCents).toBe(69212);
    expect(r.pruefsumme.abweichungCents).toBe(0);
  });

  it("IKK/DAVASO: die Rechnungsnummer ist die des Altbestands — kein RE-Format", () => {
    // `ZEM_RecNr` trägt hier `2026-01-02`. Das ist kein Parse-Fehler, sondern
    // der Bestand vor Juli 2026: gemessen nennen 41 von 66 Kopfzeilen keine
    // EngelDesk-Rechnungsnummer (27 ein Muster wie `2026-01-123`, 14 ein
    // Datum); tolerant über alle 17 Spalten gesucht, 41 von 41 nirgends.
    //
    // Diese Posten gehören in den `ungeprueft`-Ausgang des Rechnungsabgleichs —
    // nicht in `bestaetigt`. Ab 01.07.2026 nennt die Kasse die Nummer
    // (25 von 29), und der aktuelle Rückstand ab 01.08. trägt sie 15 von 15.
    const r = parseAvisCsv(IKK_DAVASO);
    expect(r.items[0].rechnungsNummer).toBe("2026-01-02");
  });
});

// --- Neuere SAP-Variante (Juli 2026): die Kasse legt UNSERE Rechnungsnummer
// „RE-JJJJ-NNNN" (mit Leerzeichen: „RE-2026- 0212") NEBEN das Buchungsdatum in
// die Datums-Spalte (parts[3]), während die Referenzspalte (parts[1]) die lange
// Kassen-Belegnummer trägt. VOR dem Fix griff der Ziffern-Fallback die
// Belegnummer als „Rechnungsnummer" → Nummer-Match scheiterte, das Matching fiel
// still auf den Betrag zurück und scheiterte bei Teilzahlung/mehrdeutigem Betrag.
const SAP_JULI_RE_IM_DATUM = [
  "1;461438852;Senioren Engel Alltagsbegleitung UG (haftungsbeschränkt), Zwickauer Str. 145, 09116 Chemnitz;",
  "2;853010969199;01.06.2026 - 30.06.2026;27.06.2026 RE-2026- 0212;262,00;+;EUR;",
  "2;854010988377;01.06.2026 - 30.06.2026;27.06.2026 RE-2026- 0241;39,26;+;EUR;",
  "3;130050598;82051000;301,26;EUR;",
].join("\n");

describe("SAP-Juli-Variante — RE-Nummer steht in der Datums-Spalte", () => {
  it("extrahiert die kanonische RE-Nummer (nicht die Belegnummer) trotz Leerzeichen", () => {
    const r = parseAvisCsv(SAP_JULI_RE_IM_DATUM);
    // Der Kern des Fixes: echte Rechnungsnummer statt Kassen-Belegnummer.
    expect(r.items.map(i => i.rechnungsNummer)).toEqual(["RE-2026-0212", "RE-2026-0241"]);
    // Beträge unverändert strukturell erkannt.
    expect(r.items.map(i => i.betragCents)).toEqual([26200, 3926]);
    // Datums-Spalte bleibt roh erhalten (inkl. eingebetteter RE-Nummer).
    expect(r.items.map(i => i.buchungsDatum)).toEqual([
      "27.06.2026 RE-2026- 0212",
      "27.06.2026 RE-2026- 0241",
    ]);
    expect(r.header.gesamtBetragCents).toBe(30126);
    expect(r.header.zahlungsempfaengerIk).toBe("461438852");
  });
});
