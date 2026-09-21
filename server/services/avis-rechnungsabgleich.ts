/**
 * Der Riegel des Avis-Imports: jeder Posten gegen die Rechnung, die er nennt.
 *
 * ── Warum nicht die datei-interne Pruefsumme ────────────────────────────
 * Die erste Fassung dieses Riegels verglich zwei Zahlen AUS DER DATEI
 * (Postensumme gegen ausgewiesene Summe). Der Gate-2-Review und eine Messung
 * an den echten Prod-Dateien haben sie widerlegt:
 *
 *  1. Beide Zahlen kommen durch denselben `parseBetragCents`-Aufruf. Ein
 *     Skalenfehler — genau der Faktor 100 vom 21.09.2026 — skaliert beide und
 *     kuerzt sich heraus. `abweichung = 0`.
 *  2. Auf der DAVASO-Paar-Struktur (alle 29 lesbaren Dateien) stehen
 *     Forderung und Zahlbetrag zeilenweise identisch. Der Vergleich ist dort
 *     TAUTOLOGISCH: 66 von 66 Kopfzeilen exakt gleich. `abweichung = 0` ist
 *     eine Eigenschaft des Formats, kein Pruefergebnis.
 *
 * Eine Pruefung, die per Konstruktion nicht fehlschlagen kann, ist keine —
 * und als bestanden ausgewiesen ist sie schlimmer als keine.
 *
 * ── Warum die Rechnung die einzige echte zweite Zahl ist ────────────────
 * `ZEM_RecNr` nennt die Rechnung, die Rechnung traegt `gross_amount_cents`.
 * Diese Zahl kommt aus der Datenbank, nicht aus der Datei — durch keinen
 * gemeinsamen Parser, unabhaengig von jeder Dateikonvention. Genau dieser
 * Vergleich hat den Vorfall gefunden (das UI zeigte 28.149,66 EUR
 * „Ueberzahlung"); er stand nur HINTER dem Import statt davor.
 *
 * ERSETZT `AVIS_PRUEFSUMME` als gatende Pruefung. Die datei-interne Zahl
 * bleibt als Konsistenzhinweis erhalten (sie faengt Feldversatz innerhalb
 * einer Datei), gatet aber nicht mehr.
 *
 * ── Die Grenze, ausdruecklich ───────────────────────────────────────────
 * Fuer Posten ohne aufloesbare Rechnung greift der Vergleich nicht. Die
 * werden als `ungeprueft` ausgewiesen — NICHT als bestanden. Wie viele das
 * sind, sagt der Vorschau-Lauf, statt dass wir es jetzt raten.
 */
import { and, eq, ilike, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import { invoices } from "../../shared/schema";
import { resolveUniqueMatch } from "../../shared/domain/qonto/avis-match";
import { statusesAllowedToTransitionTo } from "../../shared/domain/invoice-status";
import {
  classifyPaymentDifference,
  isPaymentFullyCovered,
} from "../../shared/domain/qonto/payment-difference";

export interface AbgleichPosten {
  rechnungsNummer: string | null;
  betragCents: number;
  skontoCents: number;
  kuerzungCents: number;
}

export interface RechnungTreffer {
  id: number;
  invoiceNumber: string;
  grossAmountCents: number;
}

/**
 * Die Klassifikation kommt aus `classifyPaymentDifference` — NICHT von hier.
 *
 * „Deckt diese Zahlung diese Rechnung?" ist eine fachliche Frage, und sie hat
 * seit Langem eine SSoT (`shared/domain/qonto/payment-difference.ts`), samt
 * Toleranz-Politik und der Regel, wann als Vollzahlung gebucht werden darf.
 * Die erste Fassung dieses Moduls rechnete sie noch einmal selbst aus — ein
 * Zweitbegriff derselben Frage, ausgerechnet in dem PR, der Zweitbegriffe
 * abraeumt. Zwei Toleranzen waeren irgendwann auseinandergelaufen, und die
 * hier waere die unbeaufsichtigte gewesen.
 *
 * Abgebildet wird nur noch, was der IMPORT daraus macht:
 *
 * - `bestaetigt` ← `exact` / `tolerated`, also `isPaymentFullyCovered`.
 * - `ueberzahlung` ← `overpaid`: der Avis nennt MEHR als die Rechnung. Das ist
 *   die Signatur des Vorfalls vom 21.09.2026 und hat keinen legitimen Fall —
 *   eine Kasse zahlt nicht mehr, als gefordert wurde. **Blockiert als
 *   einziger Status.**
 * - `unterzahlung` ← `underpaid`: eine Kuerzung durch die Kasse. Normaler
 *   Geschaeftsfall, den der Lesepfad je Position abbildet. Wird gemeldet.
 *   Meine erste Fassung lehnte sie ab und ist an einem Bestandstest
 *   aufgefallen, der genau diese Ableitung prueft — ein Riegel, der
 *   Fachlichkeit zum Fehler macht, ist nicht strenger, sondern falsch.
 * - `ungeprueft`: keine aufloesbare Rechnung, also nichts verglichen. Kein
 *   bestandener Vergleich.
 *
 * **Die Grenze, ausdruecklich:** ein Fehler in der anderen Richtung (Betraege
 * zu klein) ist von einer echten Kuerzung nicht zu unterscheiden — beide
 * sehen aus wie „es fliesst weniger". Der Vorschau-Lauf zeigt Unterzahlungen
 * deshalb einzeln, statt sie stillschweigend durchzuwinken.
 */
export type AbgleichStatus = "bestaetigt" | "ueberzahlung" | "unterzahlung" | "ungeprueft";

export interface AbgleichBefund {
  rechnungsNummer: string | null;
  avisCents: number;
  /** `null`, solange keine Rechnung aufgeloest werden konnte. */
  rechnungCents: number | null;
  /** Skonto + Kuerzung dieses Postens — die benennbaren Gruende fuer eine Differenz. */
  abzugCents: number;
  /**
   * `rechnung − abzug − avis` aus `classifyPaymentDifference`.
   * POSITIV = Unterzahlung, NEGATIV = Ueberzahlung. `null` ohne Rechnung.
   */
  differenzCents: number | null;
  status: AbgleichStatus;
  grund: string;
}

export interface AbgleichErgebnis {
  befunde: AbgleichBefund[];
  bestaetigt: number;
  /** Blockiert den Import. */
  ueberzahlungen: number;
  /** Wird gemeldet, blockiert NICHT. */
  unterzahlungen: number;
  ungeprueft: number;
}

/**
 * ── Die Toleranz gilt je POSTEN, nicht auf der Avis-Summe ───────────────
 * Gefragt wurde, ob sich 56 Posten à 99 ct zu 55,44 EUR aufsummieren koennen.
 * Rechnerisch ja; gebaut ist es trotzdem nicht, und zwar aus demselben Grund,
 * aus dem dieses Modul ueberhaupt auf `classifyPaymentDifference` delegiert:
 *
 * Eine zusaetzliche Toleranz auf der Avis-Summe waere eine ZWEITE Antwort auf
 * „wann ist eine Zahlung nah genug an der Forderung?". Jeder dieser 56 Posten
 * ist laut SSoT einzeln als Vollzahlung buchbar — wenn diese Politik fuer 56
 * Rechnungen falsch ist, ist sie fuer eine falsch, und dann gehoert sie in
 * `PAYMENT_DIFFERENCE_TOLERANCE_CENTS` geaendert, nicht hier umgangen.
 *
 * Gemessen an den echten Dateien: 65 von 66 Kopfzeilen sind centgenau, die
 * 66. weicht um 59,03 EUR ab — also weit ausserhalb jeder Toleranz. Der Fall
 * tritt in den Daten nicht auf. Sollte er auftreten, ist das ein Befund fuer
 * die SSoT, kein Anlass fuer einen Sonderweg an dieser Stelle.
 */

/**
 * Rechnung ueber die REFERENZ aufloesen — niemals ueber den Betrag.
 *
 * Der Betrags-Fallback aus `autoMatchAvisItems` darf hier nicht hinein: eine
 * Rechnung zu finden, WEIL der Betrag passt, und dann den Betrag zu
 * bestaetigen, waere ein Zirkelschluss. Er koennte per Konstruktion nie eine
 * Abweichung melden. Deshalb sind die beiden Wege getrennte Funktionen und
 * nicht ein Schalter — ein Schalter waere irgendwann falsch gesetzt.
 */
export async function findeRechnungUeberNummer(nummer: string | null): Promise<RechnungTreffer | null> {
  if (!nummer) return null;

  const exakt = await db.select({
    id: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
    grossAmountCents: invoices.grossAmountCents,
  }).from(invoices).where(eq(invoices.invoiceNumber, nummer)).limit(1);
  if (exakt.length > 0) return exakt[0];

  // Tolerante Suche nur bei Nicht-Kanonischen Nummern und nur bei GENAU einem
  // Treffer (`limit 2` ⇒ `resolveUniqueMatch` verwirft ≥2 als mehrdeutig).
  if (!nummer.startsWith("RE-") && nummer.length >= 6) {
    const unscharf = await db.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      grossAmountCents: invoices.grossAmountCents,
    }).from(invoices).where(ilike(invoices.invoiceNumber, `%${nummer}%`)).limit(2);
    return resolveUniqueMatch(unscharf);
  }
  return null;
}

/**
 * Betrags-Fallback: genau EINE offene Rechnung mit exakt passendem Brutto.
 *
 * Nur fuer die ZUORDNUNG nach dem Import, nie fuer die Pruefung davor (siehe
 * `findeRechnungUeberNummer`).
 */
export async function findeRechnungUeberBetrag(betragCents: number): Promise<RechnungTreffer | null> {
  if (betragCents <= 0) return null;
  const treffer = await db.select({
    id: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
    grossAmountCents: invoices.grossAmountCents,
  }).from(invoices).where(and(
    eq(invoices.grossAmountCents, betragCents),
    inArray(invoices.status, statusesAllowedToTransitionTo("bezahlt")),
  )).limit(2);
  return resolveUniqueMatch(treffer);
}

export async function pruefeGegenRechnungen(posten: AbgleichPosten[]): Promise<AbgleichErgebnis> {
  const befunde: AbgleichBefund[] = [];

  for (const p of posten) {
    const rechnung = await findeRechnungUeberNummer(p.rechnungsNummer);
    const abzugCents = p.skontoCents + p.kuerzungCents;

    if (!rechnung) {
      befunde.push({
        rechnungsNummer: p.rechnungsNummer,
        avisCents: p.betragCents,
        rechnungCents: null,
        abzugCents,
        differenzCents: null,
        status: "ungeprueft",
        grund: p.rechnungsNummer
          ? `Rechnung ${p.rechnungsNummer} nicht im System — Betrag nicht unabhaengig geprueft`
          : "Posten nennt keine Rechnungsnummer — Betrag nicht unabhaengig geprueft",
      });
      continue;
    }

    // Skonto und Kuerzung mindern die Forderung legitim — genau das, was die
    // SSoT unter `skontoCents` versteht. Ihre Differenz ist
    // `gross − abzug − gezahlt`, also POSITIV bei Unterzahlung.
    //
    // ── Und sie sind in den echten Dateien LEER ───────────────────────────
    // Gemessen ueber alle 66 Kopfzeilen der DAVASO-Dateien: `KTR_BTR_Skonto`
    // ungleich 0 in NULL Faellen, `KTR_BTR_DTA_Kuerzg` ebenso — auch in der
    // einen Zeile, die nachweislich gekuerzt wurde (RE-2026-0213: 117,19 EUR
    // gefordert, 58,16 EUR gezahlt, beide Abzugsspalten 0.00).
    //
    // Das Format sieht die Spalten vor, die Daten fuellen sie nicht. `abzugCents`
    // ist hier also praktisch immer 0, und eine Kuerzung ist aus der Datei
    // heraus NICHT von einem Parse-Fehler zu unterscheiden.
    //
    // Genau deshalb blockiert die Unterzahlung nicht und wird auch nicht
    // stillschweigend als in Ordnung gebucht: sie wird EINZELN gemeldet. Ein
    // Riegel, der sie abweist, haette 1 von 66 echten Zeilen abgewiesen; einer,
    // der sie durchwinkt, haette denselben Fehler gemacht wie der
    // datei-interne Vergleich — etwas als geprueft auszuweisen, das niemand
    // geprueft hat.
    const klassifikation = classifyPaymentDifference({
      invoiceGrossCents: rechnung.grossAmountCents,
      paidCents: p.betragCents,
      skontoCents: abzugCents,
    });
    const differenzCents = klassifikation.differenceCents;

    const status: AbgleichStatus =
      isPaymentFullyCovered(klassifikation) ? "bestaetigt"
      : klassifikation.result === "overpaid" ? "ueberzahlung"
      : "unterzahlung";

    const gezahlt = `${p.betragCents} ct${abzugCents ? ` (+ ${abzugCents} ct Abzug)` : ""}`;
    befunde.push({
      rechnungsNummer: rechnung.invoiceNumber,
      avisCents: p.betragCents,
      rechnungCents: rechnung.grossAmountCents,
      abzugCents,
      differenzCents,
      status,
      grund:
        status === "bestaetigt"
          ? "Avis-Betrag stimmt mit der Rechnung ueberein"
          : status === "ueberzahlung"
            ? `Avis nennt ${gezahlt} — MEHR als Rechnung ${rechnung.invoiceNumber} `
              + `ueber ${rechnung.grossAmountCents} ct. Dafuer gibt es keinen legitimen Fall.`
            : `Avis nennt ${gezahlt} — weniger als Rechnung ${rechnung.invoiceNumber} `
              + `ueber ${rechnung.grossAmountCents} ct. Kuerzung durch die Kasse, wird gemeldet.`,
    });
  }

  return {
    befunde,
    bestaetigt: befunde.filter(b => b.status === "bestaetigt").length,
    ueberzahlungen: befunde.filter(b => b.status === "ueberzahlung").length,
    unterzahlungen: befunde.filter(b => b.status === "unterzahlung").length,
    ungeprueft: befunde.filter(b => b.status === "ungeprueft").length,
  };
}
