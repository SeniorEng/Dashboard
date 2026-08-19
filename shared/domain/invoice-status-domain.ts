/**
 * SSoT-Prüfung: **Kann dieser Code jeden Status lesen, der in der Datenbank steht?**
 *
 * ── Wozu ────────────────────────────────────────────────────────────────
 * Der neue Code kennt die Altwerte (`avis_erhalten`, `teilweise_bezahlt`) nicht
 * mehr; `parseInvoiceStatus` wirft bei ihnen. Der Wurf reißt nicht die einzelne
 * Zeile mit, sondern den ganzen Lesepfad — `GET /api/billing` und das
 * Cockpit-Board antworten mit 500. Am 18.08.2026 lief der Publish 28 Minuten
 * VOR der Datenmigration, und die Abrechnung war rund eine Stunde nicht
 * bedienbar.
 *
 * Diese Funktion ist die Prüfung dahinter. Sie läuft im **Release-Step** vor
 * dem Deploy (`scripts/migrate.sh`), nicht beim Boot: ein Fehlschlag bricht den
 * Deploy ab, hindert aber nie einen laufenden Container am Wiederhochkommen.
 *
 * ── Warum sie mit `parseInvoiceStatus` prüft ────────────────────────────
 * Nicht mit einer nachgebauten Werteliste. Sie stellt genau die Frage, an der
 * der Lesepfad später scheitert, und kann deshalb nicht von ihm abdriften. Eine
 * eigene Liste wäre ein Zweitbegriff und liefe beim nächsten Status-Umbau still
 * auseinander.
 *
 * Rein: Zeilen rein, Befunde raus. Keine Datenbank, kein Server, kein
 * Plattform-Bezug — damit ist sie ohne Wegwerf-DB testbar und in jeder
 * Umgebung dieselbe Antwort.
 */
import { parseInvoiceStatus } from "../schema/billing";

export interface StatusZeile {
  status: string;
  anzahl: number;
}

export interface StatusBefund {
  /** Eine lesbare Zeile je unbekanntem Wert. Leer = alles lesbar. */
  befunde: string[];
  /** Summe der Zeilen, die auf einen unbekannten Wert entfallen. */
  betroffen: number;
}

export function bewerteStatuszeilen(zeilen: readonly StatusZeile[]): StatusBefund {
  const befunde: string[] = [];
  let betroffen = 0;
  for (const zeile of zeilen) {
    try {
      // Der Kontext landet in der Meldung von `parseInvoiceStatus` und macht
      // aus „Wert unbekannt" ein „Wert unbekannt, N Zeilen betroffen".
      parseInvoiceStatus(zeile.status, `${zeile.anzahl} Zeile(n) in invoices.status`);
    } catch (err) {
      betroffen += zeile.anzahl;
      befunde.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { befunde, betroffen };
}

/** Die handlungsleitende Meldung für einen abgebrochenen Release-Step. */
export function releaseAbbruchMeldung(befund: StatusBefund): string {
  return (
    `RELEASE ABGEBROCHEN — ${befund.betroffen} Rechnung(en) tragen einen Status,\n` +
    `den der auszuliefernde Code nicht kennt.\n\n` +
    befund.befunde.map((b) => `  ${b}`).join("\n") +
    `\n\nDiese Zeilen würden im Lesepfad eine Ausnahme auslösen und die\n` +
    `Rechnungsliste (GET /api/billing) sowie das Cockpit-Board mit 500\n` +
    `beantworten — nicht nur die betroffene Zeile, sondern die ganze Antwort.\n\n` +
    `Die Datenmigration muss VOR dem Deploy laufen. Der Weg steht in\n` +
    `docs/rechnungsstatus-zielmodell.md, Abschnitt 5.\n\n` +
    `Der Deploy bricht bewusst hier ab: die laufende Version bleibt unberührt\n` +
    `und bedient weiter, statt dass eine neue startet, die es nicht kann.`
  );
}
