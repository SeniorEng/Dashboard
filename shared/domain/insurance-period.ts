/**
 * Task #1893 — Zeitraum-Semantik der Kostenträger-Zuordnung
 * (`customer_insurance_history`).
 *
 * DIE eine Quelle für zwei fachliche Fragen:
 *
 *   1. „Welcher Stichtag gilt für einen Abrechnungszeitraum?"
 *      → {@link billingPeriodAsOfISO}. Ende des Abrechnungszeitraums, NICHT
 *        `todayISO()`. Eine im Juli erstellte Juni-Rechnung muss den im Juni
 *        gültigen Kostenträger adressieren.
 *
 *   2. „Ist eine Menge von Gültigkeitsfenstern zulässig?"
 *      → {@link validateInsuranceWindows}.
 *
 * Fachliche Festlegung (Alrik, 30.07.2026): Ein Kassenwechsel ist
 * AUSSCHLIESSLICH zum 1. eines Monats zulässig — hart erzwungen, nicht nur
 * empfohlen. Damit fällt ein Abrechnungsmonat immer eindeutig unter GENAU EINE
 * Kasse; der Mitten-im-Monat-Fall (zwei Kostenträger in einem Monat, Split,
 * Ambiguität) entfällt konstruktiv.
 *
 * Fenster-Konvention: `validFrom` und `validTo` sind BEIDE inklusiv.
 * `validTo = null` heißt „offenes Ende" (aktuell gültig). Das Vorgänger-Fenster
 * endet am Tag VOR dem neuen `validFrom`, also am letzten Tag des Vormonats —
 * lückenlos und überlappungsfrei.
 *
 * Reines Domain-Modul: keine DB, keine I/O. Der DB-seitige Leser ist
 * `resolveCustomerInsuranceAt` (`server/storage/customer-mgmt/insurance.ts`).
 */

import { addDays, lastDayOfMonth } from "../utils/datetime";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Benutzer-sichtbare Meldung, wenn `validFrom` kein Monatserster ist. */
export const INSURANCE_WINDOW_MUST_START_ON_FIRST =
  "Ein Kassenwechsel ist nur zum Monatsersten möglich. Bitte den 1. eines Monats als „Gültig ab“ wählen.";

export interface InsuranceWindow {
  /** DB-Id, falls die Zeile bereits existiert (nur für Meldungen). */
  id?: number;
  /** Inklusiver Beginn (YYYY-MM-DD), MUSS ein Monatserster sein. */
  validFrom: string;
  /** Inklusives Ende (YYYY-MM-DD) oder `null` für „offenes Ende". */
  validTo: string | null;
}

/**
 * True, wenn `iso` ein ISO-Datum ist, das es im Kalender WIRKLICH gibt.
 *
 * ERSETZT die frühere reine Form-Prüfung (nur `ISO_DATE_RE`). Die ließ
 * `2026-13-45` oder `2026-02-30` durch — Zeichenketten in korrekter Form, die
 * kein Datum bezeichnen. Da `validFrom` als nacktes `z.string()` hereinkommt
 * (`shared/schema/insurance.ts`), war das der einzige Filter davor: der
 * Erstzuordnungs-Anker nahm `2026-13-45` als Kandidaten und machte daraus den
 * „Monatsersten" `2026-13-01`, den `validateInsuranceWindow` anstandslos
 * akzeptierte (Form stimmt, Tag ist der 01.). Postgres hätte den INSERT dann mit
 * einem 500 quittiert statt mit der deutschen 400-Meldung.
 *
 * Jahre < 100 werden bewusst mit abgelehnt (`Date.UTC` bildet sie auf 19xx ab) —
 * fail-closed, in dieser Domäne gibt es sie nicht.
 */
export function isIsoDate(iso: string | null | undefined): iso is string {
  if (typeof iso !== "string") return false;
  const m = ISO_DATE_RE.exec(iso);
  if (m === null) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** True, wenn `iso` ein echtes Datum ist UND auf den 1. eines Monats fällt. */
export function isMonthStartISO(iso: string): boolean {
  return isIsoDate(iso) && iso.slice(8, 10) === "01";
}

/** `YYYY-MM-DD` → `YYYY-MM-01`. */
export function monthStartOfISO(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * Task #1898 — Anker für die ERSTZUORDNUNG eines Kostenträgers.
 *
 * Der Monatserste-Zwang aus #1893 ist fachlich für den WECHSEL gedacht: ein
 * Abrechnungsmonat soll eindeutig unter genau eine Kasse fallen. Bei der
 * ERSTEN Zuordnung gibt es aber nichts zu wechseln — vorher war der Kunde
 * überhaupt keiner Kasse zugeordnet. Ein Kunde, der am 14. angelegt wird, ist
 * für den ganzen Monat bei dieser Kasse; der 1. desselben Monats ist die
 * korrekte, nicht die geschönte Angabe.
 *
 * Anker = der FRÜHERE von (angefragtes Datum, Vertragsbeginn), abgerundet auf
 * den 1. `heute` nur als Rückfalloption, wenn beide fehlen.
 *
 * Daraus folgt beides, was gelten muss:
 *  - **Rückwärts-Bound**: der Anker greift nur so weit zurück, wie das
 *    angefragte Datum ODER der Vertragsbeginn es hergeben — nie weiter. `heute`
 *    kann ihn NICHT zurückziehen (es ist kein Kandidat, solange einer der
 *    beiden brauchbar ist). Damit reicht eine Erstzuordnung nie ungefragt in
 *    bereits abgerechnete Zeiträume hinein.
 *  - **nie später als der Vertragsbeginn**: liegt der Vertragsbeginn früher als
 *    das angefragte Datum, gewinnt er das Minimum, und das Abrunden kann ihn nur
 *    noch früher machen. Es entsteht keine Lücke, in der Leistungen ohne
 *    zugeordnete Kasse dastünden.
 *
 * Ein angefragtes ZUKUNFTSDATUM wird dagegen honoriert (fachliche Entscheidung
 * Alrik, 04.08.2026) — siehe die Begründung im Rumpf. Der Anker ist also
 * ausdrücklich NICHT auf „≤ heute" gedeckelt.
 *
 * Bewusst KEINE Normalisierung eines Wechsels: die zweite und jede weitere
 * Zuordnung bleibt hart auf den Monatsersten begrenzt
 * ({@link INSURANCE_WINDOW_MUST_START_ON_FIRST}). Ein Wechseldatum still
 * umzuschreiben würde einen Abrechnungsmonat rückwirkend der falschen Kasse
 * zuordnen — genau der Fehler, den #1893 abgestellt hat.
 *
 * @param requestedISO Das vom Aufrufer angefragte `validFrom`.
 * @param contractStartISO Vertragsbeginn, falls bekannt (sonst `null`).
 * @param todayIso Heutiges Datum als `YYYY-MM-DD` (injiziert, nie intern
 *   ermittelt — sonst wäre die Funktion nicht testbar und fiele unter die
 *   `todayISO()`-vs-`asOf`-Falle).
 */
export function firstInsuranceAnchorISO(
  requestedISO: string | null | undefined,
  contractStartISO: string | null | undefined,
  todayIso: string,
): string {
  // Kandidaten sind das ANGEFRAGTE Datum und der Vertragsbeginn. Das Minimum
  // gewinnt, abgerundet auf den 1. `heute` ist NUR Rueckfalloption, wenn keiner
  // von beiden brauchbar ist — ausdruecklich KEINE Obergrenze.
  //
  // Zwei Zusagen, beide tragend:
  //
  // 1. RUECKWAERTS nur so weit, wie Anfrage ODER Vertrag es hergeben — nie
  //    weiter. Ohne das angefragte Datum als Kandidat haenge der gespeicherte
  //    Wert allein am Vertragsbeginn: ein Bestandskunde mit altem Vertrag, der
  //    heute erstmals eine Kasse bekommt, wuerde dorthin zurueckdatiert und
  //    damit rueckwirkend fuer JEDEN vergangenen Monat dieser Kasse zugeordnet.
  //    Bereits erstellte Rechnungen wuerden beim Versand an einen
  //    Kostentraeger adressiert, der zum Erstellzeitpunkt nicht galt.
  //
  // 2. VORWAERTS wird ein angefragtes Zukunftsdatum HONORIERT (fachliche
  //    Entscheidung Alrik, 04.08.2026). `heute` war frueher der Startwert und
  //    zog ein Fenster ab 15.01.2027 auf den 01.08.2026 zurueck — die Kasse
  //    bekam damit fuenf Monate zugeordnet, in denen sie nicht zustaendig war.
  //    Derselbe Schaden wie (1), nur aus der Gegenrichtung. Ein Fenster, das
  //    erst kuenftig beginnt, ist bis dahin schlicht nicht gueltig;
  //    `resolveCustomerInsuranceAt` liefert dann korrekt nichts, und der Kunde
  //    hat bewusst voruebergehend keine aktuelle Kasse.
  const candidates = [requestedISO, contractStartISO].filter(isIsoDate);
  const earliest = candidates.length
    ? candidates.reduce((a, b) => (b < a ? b : a))
    : todayIso;
  return monthStartOfISO(earliest);
}

/**
 * Der Tag VOR `iso` — so schließt ein Vorgänger-Fenster lückenlos an ein neues
 * `validFrom` an. Für einen Monatsersten ist das exakt der letzte Tag des
 * Vormonats.
 */
export function dayBeforeISO(iso: string): string {
  return addDays(iso, -1);
}

/**
 * Stichtag eines Abrechnungszeitraums = dessen ENDE.
 *
 * `dateTo` (expliziter Zeitraum-Filter, z. B. Teilmonats-Abrechnung) hat
 * Vorrang; sonst der letzte Tag des Abrechnungsmonats. Da Kassenwechsel nur zum
 * Monatsersten zulässig sind, liefert jeder Tag des Monats dieselbe Kasse — das
 * Monatsende ist die kanonische Wahl.
 */
export function billingPeriodAsOfISO(
  billingYear: number,
  billingMonth: number,
  dateTo?: string | null,
): string {
  if (isIsoDate(dateTo)) return dateTo;
  return lastDayOfMonth(billingYear, billingMonth);
}

/**
 * Prüft eine EINZELNE Fenster-Kante: `validFrom` muss ein Monatserster sein und
 * `validTo` (falls gesetzt) darf nicht vor `validFrom` liegen.
 *
 * @returns Deutsche Fehlermeldung oder `null`, wenn zulässig.
 */
export function validateInsuranceWindow(window: InsuranceWindow): string | null {
  if (!isIsoDate(window.validFrom)) {
    return "„Gültig ab“ ist kein gültiges Datum (erwartet JJJJ-MM-TT).";
  }
  if (!isMonthStartISO(window.validFrom)) {
    return INSURANCE_WINDOW_MUST_START_ON_FIRST;
  }
  if (window.validTo !== null && window.validTo !== undefined) {
    if (!isIsoDate(window.validTo)) {
      return "„Gültig bis“ ist kein gültiges Datum (erwartet JJJJ-MM-TT).";
    }
    if (window.validTo < window.validFrom) {
      return `„Gültig bis“ (${window.validTo}) liegt vor „Gültig ab“ (${window.validFrom}).`;
    }
  }
  return null;
}

/**
 * Prüft die GESAMTE Fenster-Menge eines Kunden: jede Kante einzeln, dann
 * Überlappungs- und Lückenfreiheit über die nach `validFrom` sortierte Kette.
 *
 * Ein offenes Ende (`validTo = null`) darf nur das JÜNGSTE Fenster haben —
 * sonst überlappt es alles Nachfolgende.
 *
 * @returns Deutsche Fehlermeldung oder `null`, wenn die Menge zulässig ist.
 */
export function validateInsuranceWindows(windows: readonly InsuranceWindow[]): string | null {
  for (const w of windows) {
    const single = validateInsuranceWindow(w);
    if (single) return single;
  }

  const sorted = [...windows].sort((a, b) => a.validFrom.localeCompare(b.validFrom));

  for (let i = 0; i < sorted.length - 1; i++) {
    const prev = sorted[i];
    const next = sorted[i + 1];

    if (prev.validFrom === next.validFrom) {
      return `Zwei Zuordnungen beginnen am selben Tag (${prev.validFrom}). Zeiträume müssen sich abwechseln.`;
    }
    if (prev.validTo === null || prev.validTo === undefined) {
      return `Die Zuordnung ab ${prev.validFrom} hat kein „Gültig bis“, obwohl ab ${next.validFrom} eine weitere folgt. Nur die jüngste Zuordnung darf offen bleiben.`;
    }
    if (prev.validTo >= next.validFrom) {
      return `Die Zeiträume ab ${prev.validFrom} und ab ${next.validFrom} überschneiden sich (${prev.validFrom}–${prev.validTo} vs. ab ${next.validFrom}).`;
    }
    const expectedEnd = dayBeforeISO(next.validFrom);
    if (prev.validTo !== expectedEnd) {
      return `Zwischen ${prev.validTo} und ${next.validFrom} klafft eine Lücke ohne Kostenträger. Die vorherige Zuordnung muss am ${expectedEnd} enden.`;
    }
  }

  return null;
}

/**
 * Wählt aus einer Fenster-Menge das am `asOfISO` gültige Fenster.
 *
 * Pure Spiegelung des SQL-Prädikats in `resolveCustomerInsuranceAt`
 * (`validFrom <= asOf AND (validTo IS NULL OR validTo >= asOf)`, jüngstes
 * `validFrom` gewinnt) — damit Tests die Auswahl ohne DB prüfen können.
 */
export function pickInsuranceWindowAt<T extends InsuranceWindow>(
  windows: readonly T[],
  asOfISO: string,
): T | undefined {
  let best: T | undefined;
  for (const w of windows) {
    if (w.validFrom > asOfISO) continue;
    if (w.validTo !== null && w.validTo !== undefined && w.validTo < asOfISO) continue;
    if (!best || w.validFrom > best.validFrom) best = w;
  }
  return best;
}
