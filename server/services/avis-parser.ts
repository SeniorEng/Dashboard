import {
  type AvisColumnMap,
  type AvisFormat,
  AvisParseUncertainError,
  buildSuggestedColumnMap,
  classifyKassenCsvFormat,
  detectAmountFieldIndex,
} from "../../shared/domain/qonto/avis-format";
import { extractInvoiceNumber, extractReInvoiceNumber } from "../../shared/domain/qonto/avis-match";

export { AvisParseUncertainError };
export type { AvisColumnMap };

interface ParsedAvisHeader {
  format: AvisFormat;
  avisNummer: string | null;
  belegNummer: string | null;
  gesamtBetragCents: number;
  zahlungsDatum: string | null;
  kostentraegerIk: string | null;
  kostentraegerName: string | null;
  zahlungsempfaengerIk: string | null;
  zahlungsempfaengerIban: string | null;
  skontoCents: number;
  kuerzungCents: number;
}

interface ParsedAvisItem {
  belegNr: string | null;
  vorgangsNr: string | null;
  rechnungsNummer: string | null;
  rechnungsDatum: string | null;
  verwendungszweck: string | null;
  betragCents: number;
  skontoCents: number;
  /**
   * Datei-Abzug auf DIESEM Posten. Auf der DAVASO-Paar-Struktur traegt die
   * Kopfzeile je Rechnung ihre eigene Kuerzung — ein Kopf-Feld waere dort die
   * Kuerzung der ERSTEN Rechnung, faelschlich fuer alle gelesen.
   */
  kuerzungCents: number;
  buchungsDatum: string | null;
}

/**
 * Der datei-interne KONSISTENZ-Hinweis. Ausdruecklich NICHT der Riegel.
 *
 * ── Was hier vorher stand, und warum es falsch war ──────────────────────
 * „Die zwei unabhaengigen Zahlen der Datei … haette beide Fehler vom
 * 21.09.2026 am ersten Tag gezeigt." Das hat der Gate-2-Review widerlegt und
 * eine Messung an den echten Prod-Dateien bestaetigt:
 *
 *  1. **Keine datei-interne Zahl ueberlebt einen Skalenfehler.** Beide Zahlen
 *     kommen durch denselben `parseBetragCents`-Aufruf. Liest er `70.00` als
 *     7.000 statt 70, skalieren Postensumme UND ausgewiesene Summe mit, und
 *     die Differenz bleibt 0. Genau der Faktor 100, gegen den dieser Riegel
 *     gebaut war, laeuft durch ihn hindurch.
 *
 *  2. **Auf der DAVASO-Paar-Struktur ist der Vergleich tautologisch.** Je
 *     Rechnung stehen dort zwei Zeilen: eine Kopfzeile mit Forderung UND
 *     Zahlbetrag (zeilenweise identisch, 70.00/70.00) und eine Postenzeile
 *     mit nur der Forderung. Gemessen ueber die 29 lesbaren DAVASO-Dateien:
 *     66 von 66 Kopfzeilen exakt gleich. `abweichung = 0` ist dort eine
 *     EIGENSCHAFT DES FORMATS, kein Pruefergebnis.
 *
 * Die echte zweite Zahl steht deshalb nicht in der Datei, sondern im System:
 * `ZEM_RecNr` nennt die Rechnung, die Rechnung traegt `gross_amount_cents`.
 * Dieser Vergleich laeuft durch keinen gemeinsamen Parser und ist von jeder
 * Dateikonvention unabhaengig — siehe `server/services/avis-rechnungsabgleich.ts`.
 * ER ist der Riegel; was hier steht, faengt nur noch Feldversatz und
 * verlorene Zeilen INNERHALB einer Datei.
 */
interface AvisPruefsumme {
  /** Σ der Posten-Forderungen. */
  ausPostenCents: number;
  /** Die zweite in der Datei stehende Zahl. `null` = keine gefunden. */
  ausgewiesenCents: number | null;
  /**
   * Stammt die zweite Zahl aus ANDEREN Zeilen als die Posten?
   *
   * `false` heisst: derselbe Zeilensatz, zwei Spalten — der Vergleich kann
   * per Konstruktion keine fehlende oder doppelte Zeile finden. Er ist dann
   * ein Formatmerkmal, kein Befund, und darf nirgends als „geprueft"
   * ausgewiesen werden. Auch `true` schuetzt NICHT gegen Skalenfehler.
   */
  ausAnderenZeilen: boolean;
  /** Woher die zweite Zahl stammt — gehoert in die Vorschau, damit sie pruefbar ist. */
  quelle: string;
  /**
   * `ausPosten − Abzuege − ausgewiesen`. 0 heisst: die Datei ist in sich
   * stimmig — nicht, dass die Betraege richtig sind. `null` = keine zweite
   * Zahl, also nichts zu vergleichen, und das ist kein bestandener Vergleich.
   */
  abweichungCents: number | null;
}

interface ParsedAvis {
  header: ParsedAvisHeader;
  items: ParsedAvisItem[];
  pruefsumme: AvisPruefsumme;
}

/**
 * Die datei-interne Differenz.
 *
 * Skonto und Kuerzung sind legitime Gruende, warum die Postensumme NICHT dem
 * gezahlten Betrag entspricht — sie werden abgezogen, nicht ignoriert.
 *
 * **Je Abzugsart genau EINE Quelle.** Vorher wurden Kopf- und Posten-Skonto
 * ADDIERT; eine Datei, die denselben Abzug aggregiert oben und je Posten
 * unten fuehrt, bekam ihn zweimal abgezogen und wurde als unstimmig
 * abgelehnt, obwohl sie aufgeht (Gate-2-Befund S4, ausgefuehrt). Die Posten
 * sind die feinere Angabe und haben deshalb Vorrang; der Kopf tritt nur ein,
 * wenn die Posten nichts tragen.
 */
function bildePruefsumme(
  items: ParsedAvisItem[],
  header: ParsedAvisHeader,
  ausgewiesenCents: number | null,
  quelle: string,
  ausAnderenZeilen: boolean,
): AvisPruefsumme {
  const ausPostenCents = items.reduce((n, i) => n + i.betragCents, 0);

  const skontoPosten = items.reduce((n, i) => n + i.skontoCents, 0);
  const kuerzungPosten = items.reduce((n, i) => n + i.kuerzungCents, 0);
  const abzuege = (skontoPosten > 0 ? skontoPosten : header.skontoCents)
                + (kuerzungPosten > 0 ? kuerzungPosten : header.kuerzungCents);

  const abweichungCents = ausgewiesenCents === null
    ? null
    : ausPostenCents - abzuege - ausgewiesenCents;
  return { ausPostenCents, ausgewiesenCents, quelle, abweichungCents, ausAnderenZeilen };
}

export interface ParseAvisOptions {
  fileName?: string | null;
  /** Manuelles Spalten-Mapping als Fallback, wenn die strukturelle Betrags-
   * erkennung mehrdeutig ist (Feld-Indizes einer `2;`-Zeile). */
  columnMap?: AvisColumnMap | null;
}

/**
 * Welches Zeichen trennt die Nachkommastellen?
 *
 * Das ist KEINE Geschmacksfrage und auch nicht pro Wert zu raten: es haengt am
 * Dateiformat, und dort an einer Kopplung, der man nicht entkommt.
 *
 *   DAVASO   Header `LfdNr,…`  → KOMMA-getrennt → Dezimaltrennung ist der PUNKT
 *   Kassen   Zeilen `1;2;3;`   → SEMIKOLON     → Dezimaltrennung ist das KOMMA
 *
 * Eine komma-getrennte CSV kann keine unquotierten deutschen Dezimalkommas
 * tragen — jedes Feld zerfiele. Das Trennzeichen legt die Konvention fest.
 *
 * Gemessen am 21.09.2026 ueber 85 Dateien: DAVASO 492 Betraege mit Punkt und
 * 0 mit Komma, Kassen-CSV 0 mit Punkt und 474 mit Komma. Sauber getrennt,
 * keine Mischung.
 */
export type Dezimalkonvention = "punkt" | "komma";

/**
 * Betrag in Cent — mit AUSDRUECKLICHER Konvention.
 *
 * ERSETZT `parseEuroCents`, das die deutsche Konvention global annahm: es
 * strich JEDEN Punkt als Tausendertrenner. Gegen eine DAVASO-Datei las es
 * `70.00` als 7000 Euro und speicherte 700.000 Cent — **Faktor genau 100**,
 * immer, weil zwei Nachkommastellen hochrutschen.
 *
 * Belegt an zwei Prod-Avisen (ICL01278/ICL01290, 21.09.2026): jeder einzelne
 * Posten exakt x100, und die Differenz zur Rechnungssumme centgenau die
 * angezeigte „Ueberzahlung" (28.149,66 € bzw. 56.960,64 €).
 *
 * **Die Konvention wird uebergeben, nicht erraten.** Eine Heuristik pro Wert
 * kann `1.234` nicht entscheiden — deutsche Tausender oder 1,234 mit Punkt? —
 * und genau diese Mehrdeutigkeit hat den Fehler ermoeglicht.
 */
export function parseBetragCents(value: string, konvention: Dezimalkonvention): number {
  const roh = value.trim().replace(/\s/g, "").replace(/€/g, "");
  if (!roh) return 0;
  const cleaned = konvention === "komma"
    // deutsch: Punkte sind Tausendertrenner, das Komma trennt die Nachkommastellen
    ? roh.replace(/\./g, "").replace(",", ".")
    // englisch: Kommas sind Tausendertrenner, der Punkt trennt die Nachkommastellen
    : roh.replace(/,/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

function detectDelimiter(headerLine: string): string {
  const semicolons = (headerLine.match(/;/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;
  return semicolons > commas ? ";" : ",";
}

/** Rohformat: `davaso` (Header `LfdNr,…`) vs. `1;`-Kassen-Familie vs. unbekannt. */
function detectRawFormat(csvContent: string): "davaso" | "kassen" | null {
  const firstLine = csvContent.replace(/^\uFEFF/, "").trim().split("\n")[0].trim();
  if (firstLine.startsWith("LfdNr,") || firstLine.startsWith("LfdNr;")) {
    return "davaso";
  }
  if (/^\uFEFF?\s*1;/.test(firstLine)) {
    return "kassen";
  }
  return null;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === delimiter && !inQuotes) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return raw;
}

function parseDavaso(csvContent: string): ParsedAvis {
  const lines = csvContent.replace(/^\uFEFF/, "").trim().split("\n");
  if (lines.length < 2) throw new Error("CSV enthält keine Daten");

  const headerLine = lines[0];
  const delimiter = detectDelimiter(headerLine);
  const columns = headerLine.split(delimiter).map(c => c.trim());

  const colIdx: Record<string, number> = {};
  columns.forEach((col, i) => { colIdx[col] = i; });

  const getField = (row: string[], col: string): string => {
    const idx = colIdx[col];
    if (idx === undefined || idx >= row.length) return "";
    return row[idx]?.trim() || "";
  };

  const dataRows = lines.slice(1).filter(l => l.trim()).map(l => splitCsvLine(l, delimiter));

  const headerData: ParsedAvisHeader = {
    format: "davaso",
    avisNummer: null,
    belegNummer: null,
    gesamtBetragCents: 0,
    zahlungsDatum: null,
    kostentraegerIk: null,
    kostentraegerName: null,
    zahlungsempfaengerIk: null,
    zahlungsempfaengerIban: null,
    skontoCents: 0,
    kuerzungCents: 0,
  };

  /**
   * DAVASO ist in BLOECKEN aufgebaut — eine Rechnung je Block.
   *
   * ── Was hier vorher stand, und warum es falsch war ──────────────────────
   * Der Parser sammelte die Posten aus den Zeilen MIT `ZEM_BelegNr` und nahm
   * ihren `ZEM_BTR_Forderg`. Das sind die Unterpositionen, und das ist die
   * FORDERUNG. Ein Avis sagt aber, was GEZAHLT wurde, und das steht in
   * `KTR_BTR_Zahlg` auf der Kopfzeile.
   *
   * Bei 65 von 66 gemessenen Kopfzeilen sind beide Zahlen gleich, deshalb ist
   * es nie aufgefallen. Bei der 66. nicht: `Avis_ICL01267.csv`, RE-2026-0213 —
   * gefordert 117,19 EUR, gezahlt 58,16 EUR. Der alte Aufbau haette 117,19
   * gebucht, der Rechnungsabgleich haette `bestaetigt` gemeldet, und die
   * Unterzahlung von 59,03 EUR waere unsichtbar geblieben. Dieselbe Datei
   * liegt im aktuellen Rueckstand.
   *
   * Die zweite Folge traegt genauso weit: bei einem Block mit mehreren Belegen
   * (N=5 im Repo-Fixture) entstanden FUENF Posten fuer EINE Rechnung — alle
   * Belege eines Blocks tragen dieselbe `ZEM_RecNr`. Der alte Regressionstest
   * hat das als „5 Positionen" eingefroren.
   *
   * ── Die Struktur, an 29 Dateien gemessen ────────────────────────────────
   *  - Kopfzeile: KEINE `ZEM_BelegNr` (0 von 66), traegt `ZEM_RecNr`,
   *    `KTR_BTR_Zahlg`, Skonto, Kuerzung, Zahldatum.
   *  - Postenzeilen: `ZEM_BelegNr` gefuellt (114 von 114), tragen ihren
   *    Anteil der Forderung und dieselbe `ZEM_RecNr` wie ihre Kopfzeile
   *    (0 Abweichungen).
   *  - Blockgroessen: N=1 54x, N=2 2x, N=3 1x, N=5 3x, N=6 4x, N=7 2x.
   *    **54 von 66 sind 1:1** — genau dort faellt der Spaltenfehler nicht auf.
   */
  interface Block {
    kopf: string[];
    posten: string[][];
  }

  const bloecke: Block[] = [];
  for (const row of dataRows) {
    if (getField(row, "ZEM_BelegNr")) {
      const offen = bloecke[bloecke.length - 1];
      if (!offen) {
        // Eine Postenzeile vor der ersten Kopfzeile gehoert zu keiner Rechnung.
        // In 29 gemessenen Dateien kommt das nicht vor; kaeme es vor, waere
        // still eine Forderung ohne Zahlung im Avis — deshalb laut.
        throw new Error(
          `Postenzeile ohne vorangehende Kopfzeile (Beleg ${getField(row, "ZEM_BelegNr")}). `
          + "Dateiaufbau nicht erkannt, Import abgelehnt.",
        );
      }
      offen.posten.push(row);
    } else {
      bloecke.push({ kopf: row, posten: [] });
    }
  }

  const kopfZeile = bloecke[0]?.kopf ?? dataRows[0];
  if (kopfZeile) {
    // Avis-Nummer, Kostentraeger und IBAN wiederholen sich zeilenweise; das
    // Zahlungsdatum steht auf den Kopfzeilen.
    headerData.avisNummer = getField(kopfZeile, "AVISNr") || null;
    headerData.kostentraegerIk = getField(kopfZeile, "KTR_IK") || null;
    headerData.kostentraegerName = getField(kopfZeile, "KTR_Name") || null;
    headerData.zahlungsempfaengerIk = getField(kopfZeile, "ZEM_IK") || null;
    headerData.zahlungsempfaengerIban = getField(kopfZeile, "ZEM_IBAN") || null;
    headerData.zahlungsDatum = toIsoDate(getField(kopfZeile, "Datum_ZahlungAusfuehrg") || null);
  }

  // Ein Posten je BLOCK, nicht je Belegzeile — und mit dem ZAHLbetrag.
  const items: ParsedAvisItem[] = bloecke.map(b => ({
    // Der Block kann mehrere Belege tragen; sie gehoeren alle zu dieser einen
    // Rechnung. Bei N=1 ist es schlicht die Belegnummer.
    belegNr: b.posten.map(r => getField(r, "ZEM_BelegNr")).filter(Boolean).join(", ") || null,
    vorgangsNr: getField(b.kopf, "ZEM_VorgangsNr") || null,
    /**
     * Kanonisch, wo erkennbar — sonst der ROHWERT.
     *
     * Der Kassen-Pfad normalisiert seine Referenz seit jeher ueber
     * `extractReInvoiceNumber` (O→0, eingeschobene Leerzeichen wie in
     * `RE-2026- 0212`). DAVASO nahm `ZEM_RecNr` roh — zwei Arten, dieselbe
     * Frage zu beantworten. Eine Nummer mit so einer Eigenheit faende der
     * Rechnungsabgleich nicht und meldete `ungeprueft`: kein falscher Betrag,
     * aber eine ausgelassene Pruefung, die wie ein Befund aussieht.
     *
     * `?? roh` und ausdruecklich NICHT `?? null`: 41 von 66 gemessenen
     * Kopfzeilen nennen keine EngelDesk-Nummer, sondern ein Muster wie
     * `2026-01-123` oder ein Datum — der Bestand vor Juli 2026, als Alrik noch
     * von Hand abrechnete. Das ist keine kaputte Rechnungsnummer, das ist die
     * Realitaet von damals. Ein Parser, der daraus etwas macht, das wie eine
     * Nummer aussieht, erfindet Daten; einer, der sie verwirft, verschweigt
     * sie. Sie bleibt stehen und landet sichtbar in `ungeprueft`.
     */
    rechnungsNummer: extractReInvoiceNumber(getField(b.kopf, "ZEM_RecNr"))
      ?? (getField(b.kopf, "ZEM_RecNr") || null),
    rechnungsDatum: toIsoDate(getField(b.kopf, "ZEM_RecDatum") || null),
    verwendungszweck: null,
    betragCents: parseBetragCents(getField(b.kopf, "KTR_BTR_Zahlg"), "punkt"),
    skontoCents: parseBetragCents(getField(b.kopf, "KTR_BTR_Skonto"), "punkt"),
    kuerzungCents: parseBetragCents(getField(b.kopf, "KTR_BTR_DTA_Kuerzg"), "punkt"),
    buchungsDatum: null,
  }));

  /**
   * Zwei Belegzeilen mit derselben Belegnummer sind kein Avis, sondern eine
   * verdoppelte Zeile (Gate-2-Befund G). Geprueft wird auf den ROHZEILEN, nicht
   * auf den Posten: die Belegnummer ist der Schluessel der Datei, ein Posten
   * fasst inzwischen einen ganzen Block zusammen.
   */
  const alleBelege = bloecke.flatMap(b => b.posten.map(r => getField(r, "ZEM_BelegNr")));
  const dubletten = alleBelege.filter((b, i) => alleBelege.indexOf(b) !== i);
  if (dubletten.length > 0) {
    throw new Error(
      `Belegnummer mehrfach in der Datei: ${[...new Set(dubletten)].join(", ")}. `
      + "Eine verdoppelte Zeile wuerde den Betrag doppelt buchen. Import abgelehnt.",
    );
  }

  // Der Gesamtbetrag ist die Summe der ZAHLbetraege — also das, was die Bank
  // ueberweist. Genau diese Groesse braucht die Triple-Equality des
  // Bulk-Matchers (Bank ~ Avis-Summe ~ Σ offene Rechnungen).
  headerData.gesamtBetragCents = items.reduce((n, i) => n + i.betragCents, 0);
  headerData.skontoCents = items.reduce((n, i) => n + i.skontoCents, 0);
  headerData.kuerzungCents = items.reduce((n, i) => n + i.kuerzungCents, 0);

  /**
   * Der datei-interne Konsistenzhinweis: FORDERUNG gegen FORDERUNG.
   *
   * Die Kopfzeile eines Blocks traegt die Gesamtforderung, die Postenzeilen
   * ihre Anteile. Das sind verschiedene Zeilen, und sie muessen aufgehen — ein
   * verlorener oder verdoppelter Posten faellt damit auf.
   *
   * Bewusst NICHT Forderung gegen Zahlung: die beiden duerfen auseinanderliegen
   * (das ist eine Kuerzung, siehe ICL01267), und ein Hinweis, der bei jedem
   * legitimen Fall anschlaegt, wird weggesehen.
   *
   * Und weiterhin blind gegen einen SKALENFEHLER — beide Zahlen kommen durch
   * denselben `parseBetragCents`-Aufruf. Dafuer ist der Rechnungsabgleich da.
   */
  const forderungKopf = bloecke.reduce(
    (n, b) => n + parseBetragCents(getField(b.kopf, "ZEM_BTR_Forderg"), "punkt"), 0);
  const forderungPosten = bloecke.reduce(
    (n, b) => n + b.posten.reduce(
      (m, r) => m + parseBetragCents(getField(r, "ZEM_BTR_Forderg"), "punkt"), 0), 0);

  const hatPosten = bloecke.some(b => b.posten.length > 0);

  return {
    header: headerData,
    items,
    pruefsumme: {
      ausPostenCents: forderungPosten,
      ausgewiesenCents: hatPosten ? forderungKopf : null,
      quelle: "ZEM_BTR_Forderg der Kopfzeilen gegen die ihrer Belegzeilen",
      abweichungCents: hatPosten ? forderungPosten - forderungKopf : null,
      ausAnderenZeilen: true,
    },
  };
}

/**
 * Parser der `1;`-Kassen-Familie (AOK-Plus, Barmer & Co.). Zeilentypen:
 *  - `1;<Zahlungsempfänger-IK>;<Name/Anschrift>;`
 *  - `2;<Referenz/Verwendungszweck>;…;<Betrag>;<+/->;EUR;` → Betrag STRUKTURELL erkannt
 *  - `3;<Belegnummer>;<Zahlungsdatum>;<Gesamtbetrag>;<Empfänger-IBAN>;`
 *
 * Der Betrag wird nicht mehr an einem festen Feld-Index angenommen, sondern über
 * `detectAmountFieldIndex` ermittelt. Ist er mehrdeutig und liegt kein manuelles
 * `columnMap` vor, wird `AvisParseUncertainError` geworfen (⇒ Mapping-Dialog).
 */
function parseKassenCsv(csvContent: string, options?: ParseAvisOptions): ParsedAvis {
  const lines = csvContent.trim().split("\n").map(l => l.replace(/^\uFEFF/, "").trim()).filter(l => l);

  const headerData: ParsedAvisHeader = {
    format: "kassen-csv",
    avisNummer: null,
    belegNummer: null,
    gesamtBetragCents: 0,
    zahlungsDatum: null,
    kostentraegerIk: null,
    kostentraegerName: null,
    zahlungsempfaengerIk: null,
    zahlungsempfaengerIban: null,
    skontoCents: 0,
    kuerzungCents: 0,
  };

  const items: ParsedAvisItem[] = [];
  const columnMap = options?.columnMap ?? null;
  // „keine Summenzeile gefunden" und „Summenzeile sagt 0" sind zwei
  // verschiedene Dinge — nur das erste heisst „nichts zu vergleichen".
  let gesamtbetragGefunden = false;

  for (const line of lines) {
    const parts = line.split(";").map(p => p.trim());
    const lineType = parts[0];

    if (lineType === "1") {
      headerData.zahlungsempfaengerIk = parts[1] || null;
    } else if (lineType === "2") {
      let betragIdx: number;
      if (columnMap) {
        betragIdx = columnMap.betrag;
      } else {
        betragIdx = detectAmountFieldIndex(parts);
        if (betragIdx < 0) {
          const preview = lines
            .filter(l => l.startsWith("2;"))
            .slice(0, 5)
            .map(l => l.split(";").map(p => p.trim()));
          throw new AvisParseUncertainError(
            "Betrags-Feld konnte nicht eindeutig erkannt werden. Bitte Spalten manuell zuordnen.",
            preview,
            buildSuggestedColumnMap(parts),
          );
        }
      }

      const betragCents = parseBetragCents(parts[betragIdx] ?? "0", "komma");

      const verwendungszweck = parts[1] || null;
      const refFieldIdx = columnMap?.referenz ?? 2;
      const datumIdx = columnMap?.datum ?? 3;

      // Die kanonische RE-Rechnungsnummer hat Vorrang und darf in JEDEM Feld der
      // Zeile stehen — manche Kassen legen sie neben das Buchungsdatum statt in
      // die Referenzspalte. Erst danach die feldbasierte Heuristik; deren
      // Ziffern-Fallback würde sonst die lange Kassen-Belegnummer greifen und die
      // echte Rechnungsnummer verdecken (⇒ Matching fiele still auf den Betrag
      // zurück und scheiterte bei Teilzahlungen/mehrdeutigen Beträgen).
      let rechnungsNummer = extractReInvoiceNumber(line);
      if (!rechnungsNummer) {
        rechnungsNummer = extractInvoiceNumber(parts[refFieldIdx] ?? "");
      }
      if (!rechnungsNummer) {
        rechnungsNummer = extractInvoiceNumber(verwendungszweck);
      }

      items.push({
        belegNr: null,
        vorgangsNr: null,
        rechnungsNummer,
        rechnungsDatum: null,
        verwendungszweck,
        betragCents,
        skontoCents: 0,
        // Die `2;`-Zeilen der Kassen-Familie fuehren keinen Abzug je Posten;
        // Skonto/Kuerzung stehen dort, wenn ueberhaupt, im Kopf.
        kuerzungCents: 0,
        buchungsDatum: parts[datumIdx] || null,
      });
    } else if (lineType === "3") {
      headerData.belegNummer = parts[1] || null;
      headerData.zahlungsDatum = toIsoDate(parts[2] || null);
      headerData.gesamtBetragCents = parseBetragCents(parts[3] || "0", "komma");
      gesamtbetragGefunden = true;
      headerData.zahlungsempfaengerIban = parts[4] || null;
    }
  }

  headerData.format = classifyKassenCsvFormat({
    fileName: options?.fileName,
    kostentraegerName: headerData.kostentraegerName,
  });

  // Jede der 53 gemessenen Kassen-Dateien traegt genau eine `3;`-Zeile. Sie
  // steht in einer ANDEREN Zeile als die Posten und faengt damit, was der
  // Betrags-Detektor per Konstruktion nicht kann: einen FELDVERSATZ. Bei 7, 8,
  // 9 und 13 Feldern in `2;`-Zeilen ist der keine Randmoeglichkeit.
  //
  // Gegen einen SKALENFEHLER schuetzt auch sie nicht — sie kommt durch
  // denselben `parseBetragCents`-Aufruf wie die Posten. Dafuer ist der
  // Rechnungsabgleich da.
  const ausgewiesen = gesamtbetragGefunden ? headerData.gesamtBetragCents : null;

  return {
    header: headerData,
    items,
    pruefsumme: bildePruefsumme(items, headerData, ausgewiesen, "Summenzeile 3;", true),
  };
}

export function parseAvisCsv(csvContent: string, options?: ParseAvisOptions): ParsedAvis {
  const format = detectRawFormat(csvContent);
  if (!format) {
    throw new Error("CSV-Format nicht erkannt. Unterstützt: DAVASO (Header 'LfdNr,...') und Kassen-CSV (Zeilentypen 1/2/3 mit Semikolon).");
  }
  if (format === "davaso") return parseDavaso(csvContent);
  return parseKassenCsv(csvContent, options);
}
