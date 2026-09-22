import {
  type AvisColumnMap,
  type AvisFormat,
  AvisDateiaufbauError,
  AvisParseUncertainError,
  buildSuggestedColumnMap,
  classifyKassenCsvFormat,
  detectAmountFieldIndex,
} from "../../shared/domain/qonto/avis-format";
import { extractInvoiceNumber, extractReInvoiceNumber } from "../../shared/domain/qonto/avis-match";

export { AvisParseUncertainError, AvisDateiaufbauError };
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
   * Was unerklaert bleibt. 0 heisst: die Datei ist in sich stimmig — nicht,
   * dass die Betraege richtig sind. `null` = nichts zu vergleichen, und das
   * ist kein bestandener Vergleich.
   *
   * **Die Formel ist je Familie verschieden, und das gehoert hier benannt:**
   *  - Kassen-CSV: `ausPosten − Abzuege − ausgewiesen`, ein Differenzbetrag.
   *  - DAVASO: die Summe der BLOCK-ABSTAENDE (je Block der kleinere Abstand
   *    der Belegsumme zu Forderung bzw. Zahlbetrag der Kopfzeile). Das ist
   *    kein Differenzbetrag, und `ausPostenCents`/`ausgewiesenCents` sind dort
   *    datei-weite Summen OHNE Bezug zu dieser Zahl — bei einer Kuerzung
   *    stehen deshalb 5816, 11719 und 0 nebeneinander, ohne sich zu
   *    widersprechen.
   *
   * Ein Begriff, zwei Rechnungen: das ist ein Zweitbegriff unter einem Typ und
   * als FINDING im PR vermerkt. Benannt ist er hier, damit ihn niemand fuer
   * eine Differenz haelt, die er nachrechnen koennte.
   */
  abweichungCents: number | null;
}

interface ParsedAvis {
  header: ParsedAvisHeader;
  items: ParsedAvisItem[];
  pruefsumme: AvisPruefsumme;
  /**
   * Auffaelligkeiten, die NICHT blockieren.
   *
   * Der dritte Ausgang neben „abgelehnt" und „in Ordnung": etwas ist
   * ungewoehnlich, hat aber eine legitime Lesart. Ein Riegel waere hier
   * falsch — er traefe den seltenen echten Fall genauso wie den Fehler —,
   * und Schweigen waere es auch: dann entscheidet niemand, weil niemand es
   * sieht. Die Vorschau zeigt sie an.
   */
  hinweise: string[];
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

/**
 * Wie `parseBetragCents`, aber „nicht lesbar" ist ein FEHLER, kein 0.
 *
 * `parseBetragCents` bildet `""` und `NaN` beide auf `0` ab — bequem fuer
 * optionale Felder, toedlich fuer Pflichtfelder. Gate 2 (2. Durchgang, S1) hat
 * es ausgefuehrt: benennt DAVASO die Spalte `KTR_BTR_Zahlg` um, liefert
 * `getField` `""`, jeder Posten bekommt 0 ct, die Pruefsumme steht auf 0 und
 * meldet gruen, und der Rechnungsabgleich sagt `unterzahlung` — die blockiert
 * bewusst nicht. Eine vollstaendig falsch gelesene Datei waere als Avis mit
 * lauter Nullposten angelegt worden.
 *
 * Fuer die Felder, ohne die ein Posten keinen Sinn hat, wird deshalb hier
 * abgebrochen. Ein `0.00` in der Datei ist ausdruecklich ERLAUBT — nur das
 * fehlende oder unlesbare Feld nicht. Genau diese Unterscheidung konnte die
 * alte Fassung nicht treffen.
 */
function parseBetragCentsStrikt(
  value: string, konvention: Dezimalkonvention, feld: string, ort: string,
): number {
  const roh = value.trim().replace(/\s/g, "").replace(/€/g, "");
  if (!roh) {
    throw new AvisDateiaufbauError(
      `Pflichtfeld ${feld} ist leer (${ort}). Dateiaufbau nicht erkannt, Import abgelehnt.`,
    );
  }
  const cleaned = konvention === "komma"
    ? roh.replace(/\./g, "").replace(",", ".")
    : roh.replace(/,/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) {
    /**
     * Den ROHWERT nicht zitieren.
     *
     * Er landet als 400-`message` im Toast. Bei einem Feldversatz in der
     * komma-getrennten Datei steht an dieser Position irgendein anderer
     * Zellinhalt — und diese Dateien tragen Versichertennamen und -nummern
     * (Gate 2 zu #159). Feldname und Laenge genuegen, um die Stelle in der
     * Datei zu finden; der Inhalt gehoert nicht in eine Fehlermeldung.
     */
    throw new AvisDateiaufbauError(
      `Pflichtfeld ${feld} ist kein Betrag (${ort}). `
      + "Dateiaufbau nicht erkannt, Import abgelehnt.",
    );
  }
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

/** `dd.mm.yyyy` oder bereits `yyyy-mm-dd` — sonst nichts. */
const DEUTSCHES_DATUM = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const ISO_DATUM = /^\d{4}-\d{2}-\d{2}$/;

/** IBAN: zwei Buchstaben, zwei Ziffern, dann alphanumerisch. `EUR` faellt durch. */
const IBAN_FELD = /^[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,}$/;

/** Sieht dieses Feld wie ein Datum aus? Grundlage der strukturellen Erkennung. */
function istDatumsFeld(wert: string): boolean {
  const w = wert.trim();
  return DEUTSCHES_DATUM.test(w) || ISO_DATUM.test(w);
}

/**
 * Datum in ISO — oder `null`. NIE der Rohwert.
 *
 * ── Was hier vorher stand, und was es gekostet hat ──────────────────────
 * `raw.split(".")`, bei drei Teilen umsortieren, **sonst `raw` zurueckgeben**.
 * Damit wurde aus `82051000` ein „Datum" — und das landete in
 * `payment_advices.zahlungs_datum` von drei Avisen (#7, #8, #41, gemessen 3
 * von 37).
 *
 * Die Folge sass zwei Ebenen weiter: `mark-paid` rechnet
 * `paidAt = parseLocalDate(advice.zahlungsDatum)`, das ergibt `Invalid Date`,
 * und der Treiber lehnt den Schreibvorgang ab (gemessen). Transaktion,
 * Rollback, HTTP 500 — **„Als bezahlt markieren" ist fuer diese Avise seit
 * Juli unbenutzbar**, 49 gebundene Rechnungen ueber 5.798,66 EUR.
 *
 * Kein falsches `paid_at` in der Datenbank. Das lag aber am SPALTENTYP:
 * `paid_at` ist `timestamp`. Waere es `text`, stuende `82051000` heute als
 * Bezahldatum bei 49 Rechnungen. Das Typ-System war die letzte
 * Verteidigungslinie und die einzige — Glueck, keine Konstruktion.
 *
 * ── Die Bauform, zum dritten Mal ────────────────────────────────────────
 * `getField` gibt `""` fuer eine fehlende Spalte, `parseBetragCents` gab `0`
 * fuer Unlesbares, `toIsoDate` gab den Rohwert: **„nicht lesbar" wird zu
 * einem Wert statt zu einem Fehler.** Drei Stellen, drei Haende, dieselbe
 * bequeme Wahl — sie zwingt den Aufrufer nicht, einen Fehlerfall zu
 * behandeln. Die Frage, die sie alle drei gefunden haette: *wer sieht es,
 * wenn hier nichts Lesbares ankam?*
 *
 * Gemessen vor dem Umbau: 3 von 37 `zahlungs_datum` sind kein gueltiges
 * ISO-Datum, und es sind genau diese drei. `null` setzt also nichts still auf
 * leer, das heute jemand liest.
 */
function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const w = raw.trim();
  const de = w.match(DEUTSCHES_DATUM);
  if (de) return `${de[3]}-${de[2]}-${de[1]}`;
  if (ISO_DATUM.test(w)) return w;
  return null;
}

function parseDavaso(csvContent: string): ParsedAvis {
  const lines = csvContent.replace(/^\uFEFF/, "").trim().split("\n");
  if (lines.length < 2) throw new AvisDateiaufbauError("CSV enthält keine Daten");

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

  /**
   * Die Spalten, ohne die dieser Parser nichts Sinnvolles sagen kann.
   *
   * Fehlt eine, liefert `getField` still `""` — und `""` ist von einem echten
   * Leerwert nicht zu unterscheiden. Gate 2 (S1, ausgefuehrt): eine umbenannte
   * `ZEM_BelegNr` macht JEDE Zeile zur Kopfzeile, eine umbenannte
   * `KTR_BTR_Zahlg` macht jeden Posten zu 0 ct. Beides lief ohne einen Laut
   * durch. Der Riegel steht deshalb am Header, wo der Fehler entsteht, nicht
   * drei Ebenen weiter unten, wo er nur noch wie ein Datenproblem aussieht.
   */
  const PFLICHTSPALTEN = ["ZEM_BelegNr", "ZEM_RecNr", "ZEM_BTR_Forderg", "KTR_BTR_Zahlg"] as const;
  const fehlend = PFLICHTSPALTEN.filter(c => colIdx[c] === undefined);
  if (fehlend.length > 0) {
    throw new AvisDateiaufbauError(
      `DAVASO-Datei ohne Pflichtspalten: ${fehlend.join(", ")}. `
      + `Gefunden: ${columns.join(", ")}. Import abgelehnt.`,
    );
  }

  const dataRows = lines.slice(1).filter(l => l.trim()).map(l => splitCsvLine(l, delimiter));

  /**
   * Ortsangabe fuer Fehlermeldungen — `LfdNr`, sonst gar nichts.
   *
   * Jede Struktur-Meldung verlaesst den Server als 400-`message` und landet im
   * Toast. Die Dateien tragen Versichertennamen und -nummern; eine Meldung,
   * die eine Zelle zitiert, gibt im Feldversatz-Fall genau die preis. `LfdNr`
   * ist reine Dateimechanik, lokalisiert aber exakt.
   */
  const ortVon = (row: string[]): string => {
    const lfd = getField(row, "LfdNr");
    return lfd ? `Zeile LfdNr ${lfd}` : "Zeile ohne LfdNr";
  };

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
        throw new AvisDateiaufbauError(
          `Belegzeile ohne vorangehende Kopfzeile (${ortVon(row)}). `
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
    // Strikt: eine Kopfzeile OHNE Zahlbetrag ist keine Kopfzeile, sondern ein
    // nicht erkannter Dateiaufbau. `0.00` bleibt erlaubt.
    betragCents: parseBetragCentsStrikt(
      getField(b.kopf, "KTR_BTR_Zahlg"), "punkt", "KTR_BTR_Zahlg", ortVon(b.kopf),
    ),
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
  /**
   * Die gemessene Invariante als Riegel: jede Belegzeile traegt dieselbe
   * `ZEM_RecNr` wie ihre Kopfzeile (114 von 114, 0 Abweichungen).
   *
   * Sie lag gratis da und wurde nicht geprueft (Gate 2, S6). Sie ist der
   * einzige Weg, einen falschen Block-Zuschlag zu bemerken: laufen zwei
   * Kopfzeilen hintereinander, landen die folgenden Belege alle im zweiten
   * Block — betragsneutral, aber die Belegnummern stehen danach persistiert
   * an der falschen Rechnung.
   */
  for (const b of bloecke) {
    const kopfRec = getField(b.kopf, "ZEM_RecNr");
    for (const r of b.posten) {
      const postenRec = getField(r, "ZEM_RecNr");
      if (postenRec !== kopfRec) {
        // Der Riegel, der per Konstruktion GENAU im Feldversatz-Fall feuert —
        // also dort, wo an diesen Positionen fremder Zellinhalt steht. Er
        // zitierte drei Zellen. Jetzt nur noch die beiden Orte.
        throw new AvisDateiaufbauError(
          `Belegzeile (${ortVon(r)}) nennt eine andere ZEM_RecNr als ihre Kopfzeile `
          + `(${ortVon(b.kopf)}). Block-Zuordnung nicht erkannt, Import abgelehnt.`,
        );
      }
    }
  }

  /**
   * Dubletten je BLOCK, nicht dateiweit.
   *
   * `ZEM_BelegNr` ist die Position INNERHALB einer Avis-Position, kein
   * Schluessel der Datei. Im Repo-Fixture `ICL01159` laufen die Nummern 1..5
   * innerhalb EINES Blocks; eine Datei mit vier 1:1-Bloecken traegt damit
   * viermal die `1`.
   *
   * Dateiweit geprueft lehnte der Riegel deshalb **jede intakte Mehrblock-
   * Datei** ab statt einer kaputten — reproduziert am Aufbau von
   * `Avis_ICL01278.csv` (22.09.2026, Prod). Der Gate-2-Review hatte es
   * benannt: „er lehnt auch eine Datei ab, in der dieselbe Belegnummer legitim
   * in zwei Bloecken vorkommt; das ist von der zitierten Messung nicht
   * gedeckt." Es war eine Annahme mehr, als gemessen wurde — und ein Riegel
   * auf einer ungemessenen Annahme trifft den Normalfall, nicht den Fehler.
   *
   * ── ACHTUNG, und das stand hier zuerst FALSCH ──────────────────────────
   * „Eine verdoppelte Zeile steht per Definition im selben Block" — nein. Die
   * Blockgrenze ist „Zeile ohne `ZEM_BelegNr`", also eroeffnet eine
   * verdoppelte KOPFZEILE einen neuen Block. Eine zweimal angehaengte Datei
   * lief damit mit doppeltem Betrag durch (Gate 2 zu #159, ausgefuehrt:
   * `posten=4 gesamt=20000` statt 10000). Der dateiweite Riegel aus #158 fing
   * das zufaellig mit; die Verengung auf den Block hat es aufgegeben.
   *
   * Dieser Riegel hier faengt also nur noch die verdoppelte BELEGZEILE — und
   * die aendert den Betrag gar nicht, seit die Posten aus der Kopfzeile
   * gebildet werden. Er schuetzt die Pruefsumme, nicht das Geld. Die Meldung
   * sagt das jetzt auch.
   */
  for (const b of bloecke) {
    const belege = b.posten.map(r => getField(r, "ZEM_BelegNr"));
    const dubletten = belege.filter((x, i) => belege.indexOf(x) !== i);
    if (dubletten.length > 0) {
      throw new AvisDateiaufbauError(
        `Belegnummer mehrfach im selben Block (Kopfzeile ${ortVon(b.kopf)}, `
        + `${dubletten.length} Wiederholung(en)). `
        + "Die Belegzeilen eines Blocks muessen eindeutig sein. Import abgelehnt.",
      );
    }
  }

  /**
   * Zwei VOLLSTAENDIG identische Bloecke: dieselbe Rechnung, derselbe
   * Zahlbetrag, dieselben Belege.
   *
   * Der Fall, den die Verengung auf den Block aufgegeben hat (Gate 2 zu #159):
   * eine zweimal angehaengte oder konkatenierte Datei. Sie lief mit doppeltem
   * `gesamtBetragCents` durch, und downstream faengt sie nichts — der
   * Rechnungsabgleich bewertet JE POSTEN, beide Dubletten sind einzeln
   * `bestaetigt`, und `mark-paid` klassifiziert ebenfalls je Posten. Sichtbar
   * wuerde es erst am Bankabgleich.
   *
   * ── Warum IDENTISCH und nicht das Paar (ZEM_RecNr, ZEM_BelegNr) ─────────
   * Das Paar waere der schaerfere Riegel — er fienge auch Teilverdopplungen.
   * Er traegt aber nur, wenn `ZEM_RecNr` je Datei eindeutig ist, und **das
   * ist nicht gemessen.** Gemessen sind Gefuelltheit, Komplementaritaet,
   * Blockgroessen und die Kopf-gegen-Beleg-Gleichheit — nicht die
   * Eindeutigkeit der Rechnungsnummer ueber Bloecke hinweg.
   *
   * ── Und `ZEM_VorgangsNr` gehoert in den Schluessel ─────────────────────
   * Die erste Fassung nahm nur (RecNr, Zahlbetrag, Belege) und begruendete das
   * mit: „dieselbe Rechnung zweimal mit demselben Betrag hat unter keiner
   * Lesart einen legitimen Fall". **Der Satz war nicht gedeckt.** Die Messung
   * sagte nur, dass gleiche Betraege in DIESEN 29 Dateien nicht vorkommen —
   * daraus folgt nicht „nie". Und ein paar Zeilen weiter steht hier selbst,
   * dass `ZEM_RecNr` im Altbestand ein ZEITRAUM ist: zwei Bloecke mit gleichem
   * Zeitraum, gleichem Standardbetrag und je `BelegNr=1` sind dann keine
   * Verdopplung, sondern die intakte Monatsdatei mit zwei Vorgaengen. Gate 2
   * (3. Durchgang) hat genau die gegen das echte Spaltenlayout ausgefuehrt und
   * abgelehnt bekommen.
   *
   * `ZEM_VorgangsNr` trennt die beiden Faelle, und zwar gemessen: ueber alle
   * 66 Bloecke nie leer, blockweit konstant (Kopf = Posten), und **0 Mal
   * dieselbe Nummer in zwei Bloecken**. Eine zweimal angehaengte Datei
   * wiederholt sie mitsamt allem anderen — die echte Verdopplung wird weiter
   * gefangen; zwei echte Vorgaenge nicht mehr.
   *
   * Ein zusaetzliches Feld im Identitaets-Schluessel kann nur WENIGER
   * ablehnen. Es erzeugt also per Konstruktion keinen neuen Fehlalarm —
   * deshalb war es auch ohne die Messung sicher; die Messung sagt, wie SCHARF
   * es ist. `AvisPos`/`LfdNr` gehoeren ausdruecklich NICHT hinein: die kann
   * ein Zusammenfuehrer neu vergeben, dann laeuft die echte Verdopplung durch.
   */
  const blockSchluessel = bloecke.map(b => JSON.stringify([
    getField(b.kopf, "ZEM_VorgangsNr"),
    getField(b.kopf, "ZEM_RecNr"),
    getField(b.kopf, "KTR_BTR_Zahlg"),
    b.posten.map(r => getField(r, "ZEM_BelegNr")).sort(),
  ]));
  const identisch = blockSchluessel.filter((k, i) => blockSchluessel.indexOf(k) !== i);
  if (identisch.length > 0) {
    const rec = JSON.parse(identisch[0])[0] as string;
    throw new AvisDateiaufbauError(
      `Block mehrfach in der Datei (Rechnung ${rec}): gleiche Rechnung, gleicher `
      + "Zahlbetrag, gleiche Belege. Das wuerde den Betrag doppelt buchen. Import abgelehnt.",
    );
  }

  // Der Gesamtbetrag ist die Summe der ZAHLbetraege — also das, was die Bank
  // ueberweist. Genau diese Groesse braucht die Triple-Equality des
  // Bulk-Matchers (Bank ~ Avis-Summe ~ Σ offene Rechnungen).
  headerData.gesamtBetragCents = items.reduce((n, i) => n + i.betragCents, 0);
  headerData.skontoCents = items.reduce((n, i) => n + i.skontoCents, 0);
  headerData.kuerzungCents = items.reduce((n, i) => n + i.kuerzungCents, 0);

  /**
   * Der datei-interne Konsistenzhinweis — Belegsumme gegen die Kopfzeile.
   *
   * Die Kopfzeile eines Blocks traegt zwei Zahlen (Forderung und Zahlbetrag),
   * die Belegzeilen ihre Anteile. Das sind verschiedene Zeilen, und sie
   * muessen aufgehen.
   *
   * ── Was hier vorher stand, und warum es raus muss ───────────────────────
   * „FORDERUNG gegen FORDERUNG. Bewusst NICHT Forderung gegen Zahlung." Das
   * war die Begruendung vor dem Vorschau-Lauf vom 22.09.2026 — und sie steht
   * seit der Doppel-Lesart unten im direkten Widerspruch zum Code. Zwei sich
   * widersprechende Begruendungen in einer Funktion sind schlimmer als eine
   * fehlende: der naechste Leser greift die falsche mit 50 Prozent.
   *
   * Weiterhin blind gegen einen SKALENFEHLER — beide Zahlen kommen durch
   * denselben `parseBetragCents`-Aufruf. Dafuer ist der Rechnungsabgleich da.
   */
  /**
   * JE BLOCK vergleichen, nicht global.
   *
   * Gate 2 (S6, ausgefuehrt): globale Summen heben sich auf. Bei der
   * Zeilenfolge Kopf/Kopf/Beleg/Beleg landen beide Belege im zweiten Block —
   * der erste ist dann belegfrei, der zweite hat einen zu viel, und die
   * globale Differenz bleibt 0. Der Docblock versprach, ein verlorener oder
   * verdoppelter Posten falle auf; global tat er das nicht.
   *
   * Summiert werden deshalb die BETRAEGE der Einzeldifferenzen. 0 heisst dann
   * „jeder Block geht auf" und nicht „die Fehler gleichen sich aus".
   */
  const forderungKopf = bloecke.reduce(
    (n, b) => n + parseBetragCents(getField(b.kopf, "ZEM_BTR_Forderg"), "punkt"), 0);
  const forderungPosten = bloecke.reduce(
    (n, b) => n + b.posten.reduce(
      (m, r) => m + parseBetragCents(getField(r, "ZEM_BTR_Forderg"), "punkt"), 0), 0);

  /**
   * ZWEI zulaessige Lesarten, weil nur eine davon gemessen ist.
   *
   * ── Was der Vorschau-Lauf vom 22.09.2026 gezeigt hat ────────────────────
   * `Avis_ICL01267.csv`, die einzige Kuerzung im ganzen Bestand, ist zwei
   * Zeilen lang:
   *
   *   Kopfzeile    Forderg 117.19   Zahlg 58.16
   *   Belegzeile   Forderg  58.16
   *
   * Die Belegzeile traegt den GEKUERZTEN Betrag, summiert sich also auf den
   * Zahlbetrag — nicht auf die Kopf-Forderung. Der Vergleich „Kopf-Forderung
   * gegen Beleg-Forderung" meldete deshalb 5903 und war damit auf dem
   * Kuerzungs-Pfad nicht mehr von einem Parse-Fehler zu unterscheiden: genau
   * die Schaerfe, die der Rechnungsabgleich hergestellt hatte, waere hier
   * wieder weg gewesen.
   *
   * Im Normalfall sind Forderung und Zahlbetrag der Kopfzeile identisch
   * (gemessen: 65 von 66 Kopfzeilen), dann fallen beide Lesarten zusammen.
   *
   * ── Warum trotzdem BEIDE zugelassen sind ────────────────────────────────
   * Die naheliegende Korrektur waere „gegen den Zahlbetrag pruefen". Sie
   * stuetzt sich aber auf **genau einen** gemessenen Kuerzungs-Fall — und aus
   * einem Fall eine Konvention zu machen, ist der Fehler, der an diesem
   * Vorgang schon fuenfmal passiert ist.
   *
   * Ein Block gilt deshalb als stimmig, wenn seine Belegsumme EINE der beiden
   * Zahlen trifft. Das gibt nichts auf, was der Hinweis leisten soll: eine
   * verlorene oder verdoppelte Belegzeile verfehlt BEIDE. Gemeldet wird der
   * kleinere der beiden Abstaende — also das, was auch unter der guenstigsten
   * Lesart unerklaert bleibt.
   */
  /**
   * ── „Gibt nichts auf" war falsch, und das ist die sechste Wiederholung ──
   * Die zweite Lesart fuegt einen ZWEITEN NULLPUNKT hinzu, und der liegt genau
   * dort, wo der plausibelste Dateifehler landet. Gate 2 hat es ausgefuehrt:
   *
   *   Kopf  Forderg 100.00  Zahlg 95.00  Skonto 5.00
   *   Beleg 1  95.00
   *   Beleg 2   5.00        ← geht verloren   → Abweichung 0 statt 500
   *
   * Die Kasse kuerzt oder skontiert GENAU die Positionen, die die Differenz
   * ausmachen — faellt eine davon weg, trifft die Belegsumme exakt den
   * Zahlbetrag. Der Satz war also nur dort wahr, wo der Diff gar nichts tut
   * (Forderung = Zahlbetrag, 65 von 66), und falsch ueberall dort, wo er wirkt.
   *
   * ── Die Antwort ist nicht, eine Lesart zu streichen ─────────────────────
   * Beide sind belegt: die Forderungs-Lesart durch 65 Kopfzeilen, die
   * Zahlbetrags-Lesart durch die eine gemessene Kuerzung. Eine davon zu
   * verwerfen hiesse, aus der jeweils anderen Datenmenge eine Konvention zu
   * machen — derselbe Sprung, der hier fuenfmal danebenging.
   *
   * Stattdessen wird der Graubereich SICHTBAR: trifft die Belegsumme nur EINE
   * der beiden Zahlen, geht der Block unter genau einer Lesart auf, und
   * welche stimmt, weiss niemand. Das ist ein Hinweis, kein Riegel — er
   * blockiert nichts und erzeugt die Datenbasis, die heute fehlt. Ohne ihn
   * wuerde die Frage nie beantwortet, weil niemand mehr sieht, wie oft die
   * zweite Lesart traegt.
   *
   * Im Normalfall sind beide Zahlen gleich, dann faellt der Hinweis weg.
   */
  const nurZahlbetrag: string[] = [];
  const nurForderung: string[] = [];
  const ohneForderung: string[] = [];

  const abweichungJeBlock = bloecke
    .filter(b => b.posten.length > 0)
    .reduce((n, b, i) => {
      const rohForderung = getField(b.kopf, "ZEM_BTR_Forderg");
      const kopfForderung = parseBetragCents(rohForderung, "punkt");
      const kopfZahlung = parseBetragCents(getField(b.kopf, "KTR_BTR_Zahlg"), "punkt");
      const postenF = b.posten.reduce(
        (m, r) => m + parseBetragCents(getField(r, "ZEM_BTR_Forderg"), "punkt"), 0);

      // Die KANONISIERTE Nummer, nicht der Rohwert der Zelle. `items` ist
      // index-gleich zu `bloecke`; der dritte Hinweis-Produzent nennt sie
      // ebenfalls kanonisch, und zwei Schreibweisen derselben Nummer in einem
      // Kanal machen ihn unlesbar.
      const nummer = items[i]?.rechnungsNummer ?? ortVon(b.kopf);

      /**
       * Eine LEERE Kopf-Forderung wird gemeldet, nicht abgelehnt.
       *
       * Sie war kurzzeitig ein harter Abbruch (Gate 2 zu #160, 1. Durchgang).
       * Der zweite Durchgang hat das zu Recht kassiert: beide Formen —
       * „leere Kopf-Forderung" und „Block ohne Belegzeile" — sind mit
       * 0 von 66 GLEICH gut belegt, und zwanzig Zeilen weiter stand die
       * Begruendung gegen einen Riegel. Zwei identische Beweislagen,
       * entgegengesetzt behandelt, im selben Commit.
       *
       * Dazu: `ZEM_BTR_Forderg` speist AUSSCHLIESSLICH diesen Hinweis. Das
       * Geld kommt aus `KTR_BTR_Zahlg`. Eine Datei, deren Betraege
       * vollstaendig lesbar sind, wegen eines fehlenden Hinweis-Eingangs
       * abzulehnen, ist die falsche Seite von fail-loud.
       */
      if (!rohForderung.trim()) {
        ohneForderung.push(nummer);
        return n;
      }

      const abstandForderung = Math.abs(postenF - kopfForderung);
      const abstandZahlung = Math.abs(postenF - kopfZahlung);

      if (kopfForderung !== kopfZahlung && (abstandForderung === 0) !== (abstandZahlung === 0)) {
        (abstandZahlung === 0 ? nurZahlbetrag : nurForderung).push(nummer);
      }
      return n + Math.min(abstandForderung, abstandZahlung);
    }, 0);

  /**
   * Ein Block ohne Belegzeile faellt aus der Pruefung heraus (`filter` oben) —
   * gemessen kommt er in 0 von 66 Bloecken vor. Eine ungemessene Form still zu
   * uebergehen ist genau das Muster, das hier sechsmal danebenging; ein Riegel
   * darauf waere aber wieder eine Annahme ueber die Messung hinaus. Also:
   * melden.
   */
  const ohneBelegzeile = bloecke
    .map((b, i) => ({ b, nummer: items[i]?.rechnungsNummer ?? ortVon(b.kopf) }))
    .filter(x => x.b.posten.length === 0)
    .map(x => x.nummer);

  /**
   * AGGREGIERT, nicht je Block.
   *
   * Die Bedingung „Forderung != Zahlbetrag und genau eine Lesart geht auf" ist
   * kein Anomalie-Praedikat, sondern das Praedikat „dieser Block wurde
   * gekuerzt oder skontiert und ist in sich stimmig" — der intakte
   * Geschaeftsfall. Heute betrifft das 1 von 66 Kopfzeilen; eine Kasse, die
   * systematisch nur ihren Anteil zahlt, erzeugt es auf JEDEM Block.
   * Ausgefuehrt: zwoelf solche Bloecke ergaben zwoelf gleichlautende Hinweise.
   *
   * Ein Kanal, der reihenweise dasselbe meldet, wird weggesehen — und dann ist
   * er schlimmer als keiner. Eine Zeile mit den betroffenen Nummern
   * beantwortet dieselbe Frage.
   *
   * ── Und die URSACHE ist je Zweig eine ANDERE ────────────────────────────
   * Der erste Entwurf nannte in beiden Zweigen „eine fehlende Belegzeile".
   * Im Forderungs-Zweig ist das die einzige Ursache, die es NICHT sein kann:
   * die Belegsumme trifft dort die Forderung exakt, eine fehlende Zeile macht
   * sie kleiner. Der Bediener wurde also genau dort, wo er hinsehen soll, auf
   * die falsche Spalte geschickt (Gate 2, 2. Durchgang, ausgefuehrt).
   *
   * Der Text unterscheidet ausserdem NICHT mehr pauschal „Kuerzung": das Repo
   * trennt gewaehrten Nachlass (Skonto) und auferlegten Abzug (Kuerzung)
   * scharf, und welcher von beiden vorliegt, sagt die Kopfzeile.
   */
  const liste = (n: string[]) => n.join(", ");
  const graubereich: string[] = [];
  if (nurZahlbetrag.length > 0) {
    graubereich.push(
      `${nurZahlbetrag.length} Block/Bloecke gehen nur gegen den ZAHLBETRAG der Kopfzeile `
      + `auf (${liste(nurZahlbetrag)}). Bei einem ausgewiesenen Abzug ist das normal — `
      + "es kann aber auch eine FEHLENDE Belegzeile sein. Bitte gegen die Datei pruefen.",
    );
  }
  if (nurForderung.length > 0) {
    graubereich.push(
      `${nurForderung.length} Block/Bloecke gehen nur gegen die FORDERUNG der Kopfzeile `
      + `auf (${liste(nurForderung)}). Die Belegzeilen tragen dann den ungekuerzten `
      + "Betrag — es kann aber auch eine UEBERZAEHLIGE Belegzeile sein. Bitte pruefen.",
    );
  }
  if (ohneForderung.length > 0) {
    graubereich.push(
      `${ohneForderung.length} Kopfzeile(n) ohne ZEM_BTR_Forderg (${liste(ohneForderung)}). `
      + "Der Betrag ist davon unberuehrt (er kommt aus KTR_BTR_Zahlg), aber der "
      + "datei-interne Abgleich faellt fuer diese Bloecke aus.",
    );
  }
  if (ohneBelegzeile.length > 0) {
    graubereich.push(
      `${ohneBelegzeile.length} Block/Bloecke ohne Belegzeile (${liste(ohneBelegzeile)}). `
      + "In den gemessenen Dateien kommt das nicht vor — bitte pruefen.",
    );
  }

  const hatPosten = bloecke.some(b => b.posten.length > 0);

  /**
   * Eine KANONISCHE Rechnungsnummer in mehreren Bloecken — Hinweis, kein Riegel.
   *
   * ── Warum nicht abgelehnt ───────────────────────────────────────────────
   * Gemessen ueber alle 29 Dateien: `ZEM_RecNr` wiederholt sich in genau zwei
   * Dateien ueber Bloecke hinweg, beide Male mit verschiedenen Betraegen und
   * Posten — und beide Male ist die Nummer Altbestand (`2026-03-06`,
   * `2026-04-06/4`). Dort ist `ZEM_RecNr` kein Schluessel, sondern ein
   * Zeitraum; die Wiederholung ist erwartbar und bedeutungslos. Ein Riegel auf
   * das Paar (RecNr, BelegNr) haette diese zwei intakten Dateien abgelehnt.
   *
   * In den 12 Dateien mit KANONISCHEN Nummern kommt keine Mehrfach-RecNr vor.
   * Dort waere ein Riegel scharf — aber er traefe auch den Fall, den 12
   * Dateien nicht ausschliessen koennen: eine Kasse, die dieselbe Rechnung in
   * zwei Tranchen innerhalb eines Avis zahlt. Die sieht genauso aus wie eine
   * Teilverdopplung, und aus der Datei heraus ist sie nicht zu unterscheiden.
   *
   * Die echte Verdopplung — zweimal angehaengte oder konkatenierte Datei —
   * erzeugt IDENTISCHE Bloecke und wird oben abgelehnt. Was hier bleibt, ist
   * der Graubereich, und fuer den ist Melden die richtige Antwort: er ist
   * selten genug, dass ein Mensch hinsehen kann, und mehrdeutig genug, dass
   * eine Maschine nicht entscheiden sollte.
   */
  /**
   * Geprueft wird die KANONISIERTE Nummer, nicht der Rohwert — und „kanonisch"
   * beantwortet die SSoT, nicht ein eigener Regex.
   *
   * Die erste Fassung hatte `/^RE-\d{4}-\d+$/` gegen `getField(..., "ZEM_RecNr")`
   * laufen lassen. Zwei Fehler in einem: der Parser kanonisiert die Nummer 200
   * Zeilen weiter oben ueber `extractReInvoiceNumber` (O→0, eingeschobene
   * Leerzeichen wie `RE-2026- 0212`), und ein eigener Regex ist der DRITTE
   * Block fuer eine Frage, fuer die `avis-match.ts` ausdruecklich eine SSoT
   * fuehrt.
   *
   * Gate 2 (3. Durchgang) hat es ausgefuehrt: bei `RE-2026-O212` verwarf der
   * Test beide Bloecke als „Altbestand" und verschluckte den Hinweis — der
   * Mechanismus, der Altbestand schonen soll, schluckte eine echte kanonische
   * Nummer.
   */
  const recNummern = items.map(i => i.rechnungsNummer ?? "");
  const mehrfachKanonisch = [...new Set(
    recNummern.filter((r, i) =>
      extractReInvoiceNumber(r) !== null && recNummern.indexOf(r) !== i),
  )];
  const hinweise = [...graubereich, ...mehrfachKanonisch.map(r =>
    `Rechnung ${r} kommt in mehreren Bloecken vor. In den gemessenen Dateien `
    + "gibt es das bei kanonischen Nummern nicht — bitte pruefen, ob es zwei "
    + "Tranchen sind oder eine Teilverdopplung.",
  )];

  return {
    header: headerData,
    items,
    hinweise,
    pruefsumme: {
      ausPostenCents: forderungPosten,
      ausgewiesenCents: hatPosten ? forderungKopf : null,
      quelle: "Belegsumme je Block gegen Forderung ODER Zahlbetrag der Kopfzeile "
        + "(beide zulaessig — bei einer Kuerzung traegt die Belegzeile den gekuerzten Betrag)",
      abweichungCents: hatPosten ? abweichungJeBlock : null,
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
      /**
       * Die Kopffelder STRUKTURELL erkennen, nicht positionell.
       *
       * ── Der Prod-Fall (Avis 41, AOK, 22.09.2026) ──────────────────────
       * Feste Indizes ergaben dort:
       *   belegNummer   = 130050598   ← die Kostentraeger-IK
       *   zahlungsDatum = "82051000"  ← kein Datum
       *   IBAN          = "EUR"
       *
       * Gemessen ueber alle 53 Kassen-Dateien gibt es DREI Belegungen der
       * `3;`-Zeile: Breite 6 (Datum bei [2]), Breite 7 AOK (Datum bei [6],
       * [2] traegt die Konstante 82051000), Breite 7 BARMER (Datum bei [2],
       * [6] leer). **Die Feldzahl allein identifiziert das Layout nicht** —
       * bei 33 von 53 Zeilen ist die Belegung bei gleicher Breite
       * uneinheitlich. „Breite als Schluessel" war mein erster Vorschlag und
       * ist durch die Messung widerlegt.
       *
       * Der Betrag wird seit Task #1687 strukturell erkannt und ist laut
       * derselben Messung der einzige Wert, der heute ueberall stimmt. Die
       * uebrigen Kopffelder folgen jetzt demselben Weg.
       */
      const felder = parts.slice(1);

      // Das Datum ist eindeutig: KEINE der 53 `3;`-Zeilen traegt zwei
      // Datums-Felder, und `82051000` faellt durch beide Datumsmuster.
      headerData.zahlungsDatum = toIsoDate(felder.find(istDatumsFeld) ?? null);

      // Die IBAN ebenso — `EUR` ist keine.
      headerData.zahlungsempfaengerIban = felder.find(f => IBAN_FELD.test(f.trim())) ?? null;

      headerData.gesamtBetragCents = parseBetragCents(parts[3] || "0", "komma");
      gesamtbetragGefunden = true;

      /**
       * Die BELEGNUMMER geht NICHT strukturell — und wird deshalb nur dort
       * gelesen, wo die Messung sie deckt.
       *
       * Die naheliegende Regel („die erste lange Ziffernfolge, die kein
       * Betrag und kein Datum ist") greift bei der AOK-Zeile auf
       * `130050598`, also genau auf die IK: sie reproduziert den Bug, den sie
       * beheben soll. **IK und Belegnummer sind durch ihre Gestalt nicht
       * unterscheidbar**, das ist grundsaetzlich und kein Detail.
       *
       * Breite 6 ist die einzige gemessen EINHEITLICHE Belegung (19 von 19
       * Zeilen, `[1]` traegt die Belegnummer). Nur dort wird gelesen; sonst
       * bleibt das Feld leer.
       *
       * ── Und das kostet NICHTS, auch das ist gemessen ──────────────────
       * Die naheliegende Erweiterung waere gewesen: `[1]` lesen, wann immer
       * eine IBAN gefunden wurde — denn BARMER-Layouts tragen eine, AOK-
       * Layouts `EUR`. Die Messung ueber alle 53 Dateien sagt dazu zweierlei:
       *
       *  - Sicher waere sie: in keiner der 30 IBAN-Zeilen steht bei `[1]` die
       *    Kostentraeger-IK.
       *  - **Nutzlos waere sie trotzdem:** 19 der 30 sind Breite 6 (hier schon
       *    gelesen), und in den uebrigen 11 ist `[1]` durchgehend TEXT. Die
       *    Regel haette also bei genau den Zeilen, die sie zurueckgewinnen
       *    sollte, einen Text als Belegnummer eingetragen.
       *
       * In Breite 7 gibt es keine Belegnummer, die man verlieren koennte.
       *
       * Die Korrelation „BARMER traegt IBAN" belegt eben NICHT, dass `[1]`
       * dort eine Belegnummer ist — sie war die Sorte Regel, die an diesem
       * Vorgang achtmal danebenging. Ein falsch gefuelltes Feld sieht
       * benutzbar aus; am 22.09. wurde ein Dublettenriegel auf genau diesem
       * Feld vermutet, weil dort eine Nummer stand.
       */
      headerData.belegNummer = parts.length === 6 ? (parts[1] || null) : null;
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
    hinweise: [],
    pruefsumme: bildePruefsumme(items, headerData, ausgewiesen, "Summenzeile 3;", true),
  };
}

export function parseAvisCsv(csvContent: string, options?: ParseAvisOptions): ParsedAvis {
  const format = detectRawFormat(csvContent);
  if (!format) {
    throw new AvisDateiaufbauError("CSV-Format nicht erkannt. Unterstützt: DAVASO (Header 'LfdNr,...') und Kassen-CSV (Zeilentypen 1/2/3 mit Semikolon).");
  }
  if (format === "davaso") return parseDavaso(csvContent);
  return parseKassenCsv(csvContent, options);
}
