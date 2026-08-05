/**
 * Referenz-„heute" für Abrechnungs-Fixtures.
 *
 * ERSETZT das direkte `new Date()` in den Billing-Fixtures, die einen
 * VERGANGENEN Werktags-Slot im laufenden Monat suchen (`createAppt`, 13 Dateien).
 *
 * Das Problem, das damit verschwindet: Die Fixtures suchen rückwärts vom heutigen
 * Tag bis zum Monatsersten. In den ersten Tagen eines Monats gibt es dort kaum —
 * und je nach Wochenlage GAR KEINEN — vergangenen Werktag. Am 01.08.2026 (Samstag)
 * und am 02.08.2026 (Sonntag) ist die Menge leer, die Fixtures scheitern mit
 * „kein freier Werktags-Slot im Monat gefunden", und ~30 Tests der Billing-/§45b-
 * Suite kippen auf rot, ohne dass sich eine Zeile Produktivcode geändert hat
 * (per A/B am 02.08.2026 gegen `3f98cb0a` belegt: identische Rot-Menge auf beiden
 * Ständen, also reiner Kalender-Effekt).
 *
 * Es ist dieselbe Familie wie die bekannte `getFutureDate`-Sa/So-Falle aus
 * CLAUDE.md, nur an der Monats- statt an der Wochenendgrenze.
 *
 * Die Lösung ist bewusst KEINE gefrorene Uhr: Diese Tests sprechen einen echten
 * App-Server an, der seine eigene Systemzeit liest. Ein `vi.setSystemTime` im
 * Testprozess würde die Fixture-Arithmetik verschieben, den Server aber nicht —
 * die beiden liefen auseinander, und der Server würde Termine ablehnen, die für
 * ihn in der Zukunft liegen. Stattdessen wird der ANKERTAG so gewählt, dass immer
 * genug vergangene Werktage existieren: heute, solange der laufende Monat sie
 * hergibt, sonst der letzte Tag des Vormonats.
 *
 * Die fachliche Aussage der Tests bleibt unberührt — sie rechnen weiterhin gegen
 * „einen abgeschlossenen Werktag in dem Monat, den sie abrechnen".
 */

/** So viele vergangene Werktage muss ein Monat bieten, damit die Fixtures ihre
 *  Termine (mehrere pro Test, je mit eigener Uhrzeit) unterbringen. */
const MIN_PAST_WEEKDAYS = 5;

/** Zählt die Werktage vom Monatsersten bis einschließlich des Stichtags. */
export function countPastWeekdaysInMonth(ref: Date): number {
  let n = 0;
  for (let day = 1; day <= ref.getDate(); day++) {
    const dow = new Date(ref.getFullYear(), ref.getMonth(), day).getDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/**
 * Ankertag für Fixtures, die einen vergangenen Werktags-Slot brauchen.
 *
 * Liefert `now`, wenn der laufende Monat mindestens `MIN_PAST_WEEKDAYS`
 * vergangene Werktage hat — sonst den letzten Tag des Vormonats (12:00, damit
 * Vergleiche gegen Mitternachts-Daten eindeutig sind). Ein voller Vormonat hat
 * immer genug Werktage, das Ergebnis ist also an JEDEM Kalendertag brauchbar.
 */
export function billingReferenceDate(now: Date = new Date()): Date {
  if (countPastWeekdaysInMonth(now) >= MIN_PAST_WEEKDAYS) return now;
  return new Date(now.getFullYear(), now.getMonth(), 0, 12, 0, 0);
}

/** Abrechnungs-Monat (1-basiert) zum Ankertag — ersetzt
 *  `const now = new Date(); const year = now.getFullYear(); …`. */
export function billingReferenceMonth(now: Date = new Date()): {
  reference: Date;
  year: number;
  month: number;
} {
  const reference = billingReferenceDate(now);
  return {
    reference,
    year: reference.getFullYear(),
    month: reference.getMonth() + 1,
  };
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Jüngster VERGANGENER Werktag im Abrechnungs-Monat des Ankertags, als
 * `YYYY-MM-DD`.
 *
 * ERSETZT die zwölf wortgleich duplizierten `weekdayInCurrentMonth()`-Kopien in
 * den Test-Dateien sowie `latestPastWeekday()` in
 * `tests/billing/invoice-45b-reduction.test.ts`.
 *
 * Die Kopien hatten zwei Ausprägungen, beide kalender-fragil:
 *  - „nur rückwärts, sonst `throw`": kippt am Monatsanfang, wenn es noch keinen
 *    vergangenen Werktag gibt (01./02.08.2026 = Sa/So).
 *  - „rückwärts, sonst VORWÄRTS": liefert in genau derselben Lage ein
 *    ZUKUNFTSDATUM. Das ist die tückischere Variante — die Fixture legt den
 *    Termin an, aber die as-of-Leser (`transactionDate <= heute`) zählen ihn
 *    nicht, und der Test scheitert mit „erwartet 3800, war 0" statt mit einem
 *    Datums-Fehler.
 *
 * Weil der Ankertag notfalls in den Vormonat ausweicht, existiert immer ein
 * vergangener Werktag — die Funktion kann nicht scheitern. Wer zusätzlich Jahr/
 * Monat braucht (Leistungsnachweis, Rechnungslauf), MUSS sie aus
 * `billingReferenceMonth()` ziehen und nicht aus `new Date()`, sonst zeigen
 * Termin und Abrechnungsmonat in verschiedene Monate.
 */
export function pastWeekdayInBillingMonth(now: Date = new Date()): string {
  const ref = billingReferenceDate(now);
  for (let day = ref.getDate(); day >= 1; day--) {
    const cand = new Date(ref.getFullYear(), ref.getMonth(), day);
    const dow = cand.getDay();
    if (dow !== 0 && dow !== 6) return ymd(cand);
  }
  // Unerreichbar: `billingReferenceDate` garantiert >= MIN_PAST_WEEKDAYS.
  throw new Error(
    `pastWeekdayInBillingMonth: kein vergangener Werktag in ${ref.getMonth() + 1}/${ref.getFullYear()} — ` +
      `Ankertag-Invariante verletzt (siehe billing-month.test.ts)`,
  );
}

/**
 * Zieht ein KONKRETES Datum auf den nächsten Werktag (Default vorwärts).
 *
 * ERSETZT die hartkodierten Tagesangaben in Budget-Fixtures (`…-01`, `…-15`),
 * die je nach Monat auf ein Wochenende fallen. Die Termin-Anlage lehnt das
 * bewusst ab — `server/routes/appointments.ts` antwortet auf Samstag/Sonntag mit
 * 400 („Termine können nicht auf Samstage oder Sonntage gelegt werden") —, und
 * die Fixture stirbt dann an einer Produktregel statt an ihrem Prüfgegenstand.
 * Gesehen im August 2026: der 01. UND der 15. waren beide Samstage.
 *
 * Bewusst KEIN „nimm irgendeinen Werktag": das Datum bleibt so nah wie möglich
 * am gemeinten Tag (max. +2 Tage), damit „Monatsanfang" auch Monatsanfang
 * bleibt und der Termin im selben Monat wie die Allokation liegt.
 *
 * Unterschied zu {@link pastWeekdayInBillingMonth}: die dortige Funktion SUCHT
 * einen vergangenen Werktag im Abrechnungsmonat; diese hier KORRIGIERT ein
 * bereits gewähltes Datum. Zwei verschiedene Fragen, deshalb zwei Funktionen.
 */
export function snapToWeekday(iso: string, direction: "forward" | "backward" = "forward"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const cand = new Date(y, m - 1, d);
  const step = direction === "forward" ? 1 : -1;
  // Höchstens zwei Schritte nötig: Sa→Mo bzw. So→Fr.
  for (let i = 0; i < 3; i++) {
    const dow = cand.getDay();
    if (dow !== 0 && dow !== 6) return ymd(cand);
    cand.setDate(cand.getDate() + step);
  }
  throw new Error(`snapToWeekday: kein Werktag in Reichweite von ${iso}`);
}

/**
 * Anker für §45b-CARRYOVER-Szenarien.
 *
 * ERSETZT die hartkodierten Jahreszahlen in den Übertrags-Fixtures
 * (`carryover: { year: 2025 }`, `expiresAt === "2026-06-30"`) und das implizite
 * „heute" als Stichtag.
 *
 * Das Problem: Ein §45b-Übertrag aus Jahr Y gilt im Folgejahr und verfällt
 * strikt am 30.06. (SGB XI §45b Abs. 3, siehe CLAUDE.md). Fixtures, die einen
 * Vorjahres-Übertrag seeden und ihn dann gegen „heute" lesen, unterstellen
 * damit stillschweigend das ERSTE HALBJAHR. Ab dem 01.07. ist der Übertrag
 * korrekt verfallen, die Tests kippen auf rot — ohne dass sich eine Zeile
 * Produktivcode geändert hätte.
 *
 * DIE FRIST SELBST WIRD NICHT ANGEFASST. Dieser Helfer verschiebt weder den
 * 30.06. noch weicht er eine Assertion auf: er liefert das Jahrespaar relativ
 * zum Lauf und einen Stichtag, an dem der Übertrag nachweislich noch gilt.
 * `expiresAt` bleibt exakt der 30.06. des Zieljahres und gehört weiter
 * assertiert — nur eben relativ statt als Literal.
 *
 * Der Stichtag ist immer VERGANGEN (damit Termine dokumentierbar sind) und
 * liegt immer im H1 des Zieljahres. Läuft der Test in den ersten Januartagen,
 * gibt es kein solches Datum im laufenden Jahr — dann rückt das Zieljahr um
 * eins zurück, analog zu {@link billingReferenceDate}.
 */
export function carryoverAnchor(now: Date = new Date()): {
  /** Jahr, AUS dem der Übertrag stammt (Seed: `carryover.year`). */
  sourceYear: number;
  /** Jahr, IN dem der Übertrag gilt. */
  targetYear: number;
  /** Verfallsdatum des Übertrags — der 30.06. des Zieljahres. */
  expiresAt: string;
  /** Stichtag im H1 des Zieljahres, garantiert in der Vergangenheit. */
  asOf: string;
} {
  // Spätester unbedenklicher Punkt im H1: Mitte Juni, klar vor der Grenze.
  const preferred = (y: number) => new Date(y, 5, 15);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  let targetYear = now.getFullYear();
  let asOfDate = preferred(targetYear) <= yesterday ? preferred(targetYear) : yesterday;

  // Zu früh im Jahr: kein vergangener Tag im H1 des laufenden Jahres.
  if (asOfDate < new Date(targetYear, 0, 1)) {
    targetYear -= 1;
    asOfDate = preferred(targetYear);
  }

  return {
    sourceYear: targetYear - 1,
    targetYear,
    expiresAt: `${targetYear}-06-30`,
    asOf: snapToWeekday(ymd(asOfDate), "backward"),
  };
}
