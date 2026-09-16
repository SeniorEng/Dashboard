import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DAILY_SCHEDULER_SLOTS } from "@shared/utils/month-close-cutoff";

/**
 * Wächter für die Tages-Entprellung in `runDaily()`
 * (`server/services/month-close-scheduler.ts`).
 *
 * ── Der Fehler ───────────────────────────────────────────────────────
 * Es gab EINE Variable `lastDailyRunDate` für alle Slots, je Slot mit
 * eigenem Suffix beschrieben (`today + "-reminder"` bzw.
 * `+ "-autoclose"`). Jeder Schreibvorgang löscht die Marke des anderen.
 *
 * Auf dem Stand vor dem Fix war das **latent, nicht wirksam**: die
 * verbleibende Differenz braucht zwei Polls mit `berlinHour() === 23` im
 * selben Prozess, und bei stündlichem `setInterval` gibt es die nicht.
 * Ein Neustart zählt ausdrücklich nicht — er löscht die prozess-lokale
 * Marke selbst, verhält sich also vor und nach dem Fix gleich.
 *
 * ── Was hier geprüft wird, und mit welchem Mittel ─────────────────────
 * Zwei Sorten Aussage, zwei Sorten Test:
 *
 *  • SD-1/SD-2 sind ECHTE Zusicherungen an der exportierten Konstante.
 *    Sie fangen die Variante, die eine reine Quelltext-Prüfung NICHT
 *    fängt: zwei Slots mit demselben WERT
 *    (`{ reminder: "reminder", autoClose: "reminder" }`). Die typprüft
 *    anstandslos — `DailySlot` kollabiert dann auf `"reminder"` — und
 *    ihre Folge ist schwerer als der Ausgangsfehler: der Auto-Close
 *    liest die Marke des Reminders, überspringt sich selbst, und wegen
 *    `isCutoffDay` (strikte Tagesgleichheit) wird der Monat NIE
 *    geschlossen, still und ohne Log.
 *
 *  • SD-3 bis SD-5 sind Quelltext-Prüfungen, weil ihre Aussage
 *    strukturell ist („kein Zweig entprellt an eigener Variable"). Ein
 *    Verhaltenstest dafür müsste den Scheduler starten und die Berliner
 *    Stunde stellen — er prüfte dann die Test-Mechanik, nicht die
 *    Aussage.
 *
 * Eine frühere Fassung dieser Datei bestand NUR aus Quelltext-Prüfungen
 * und ließ beide oben genannten Varianten durch. Gemessen, nicht
 * vermutet: Variante A passierte alle vier Wächter und `tsc`.
 */

const QUELLE = resolve(__dirname, "../../server/services/month-close-scheduler.ts");

function scheduler(): string {
  return readFileSync(QUELLE, "utf8");
}

/**
 * Quelltext ohne Kommentare — der Docstring des Moduls nennt den
 * Altzustand absichtlich, und ein Zeilen-Endkommentar (`foo(); // …`)
 * darf einen Wächter nicht rot machen.
 */
function codeOhneKommentare(): string {
  return scheduler()
    .replace(/\/\*[\s\S]*?\*\//g, "")   // Blockkommentare
    .replace(/\/\/[^\n]*/g, "");        // Zeilen- und Endkommentare
}

describe("Scheduler — Tages-Entprellung je Slot", () => {
  it("SD-1 – jeder Slot hat einen EIGENEN Schluesselwert", () => {
    // Der wichtigste Test der Datei. Zwei Slots mit gleichem Wert
    // typpruefen anstandslos, und die Folge waere ein still
    // uebersprungener Monatsabschluss. Die Konstante liegt in
    // `shared/utils/month-close-cutoff.ts` und NICHT beim Scheduler,
    // weil dessen Modul beim Import eine `DATABASE_URL` verlangt — eine
    // Konstante hinter einer DB-Abhaengigkeit ist nicht als Einheit
    // pruefbar, und genau diese Pruefung ist hier der Punkt.
    const werte = Object.values(DAILY_SCHEDULER_SLOTS);
    const doppelt = werte.filter((w, i) => werte.indexOf(w) !== i);
    expect(
      doppelt,
      `zwei Slots teilen sich einen Schluesselwert: ${doppelt.join(", ")} — `
      + "der spaetere Slot uebersprange sich selbst",
    ).toEqual([]);
  });

  it("SD-2 – es gibt mindestens zwei Slots", () => {
    // Gegenprobe zu SD-1: bei einem einzigen Slot ist Eindeutigkeit
    // trivial erfuellt und der Test saege nichts.
    expect(Object.keys(DAILY_SCHEDULER_SLOTS).length).toBeGreaterThanOrEqual(2);
  });

  it("SD-3 – keine geteilte Marke mit Slot-Suffix mehr", () => {
    const treffer = codeOhneKommentare()
      .split("\n")
      .filter(z => /lastDailyRunDate/.test(z));
    expect(
      treffer,
      "`lastDailyRunDate` war die geteilte Marke — jeder Slot braucht seine eigene",
    ).toEqual([]);
  });

  it("SD-4 – kein Slot presst seine Kennung in den WERT der Marke", () => {
    // `today + "-reminder"` war die Bug-Form. Bewusst ohne Bindestrich
    // im Muster, damit `today + "_x"` nicht durchrutscht.
    const treffer = codeOhneKommentare()
      .split("\n")
      .filter(z => /today\s*\+\s*["'`]/.test(z));
    expect(
      treffer,
      "Slot-Unterscheidung gehoert in den SCHLUESSEL, nicht in den Wert",
    ).toEqual([]);
  });

  it("SD-5 – JEDER Stunden-Zweig in `runDaily` entprellt ueber `alreadyRanToday`", () => {
    // Fangt die zweite Variante: ein neuer Slot mit eigener
    // `let`-Variable umgeht die Map komplett — und genau das ist der
    // Fall, fuer den es diese Datei gibt („wer den naechsten Slot
    // einhaengt").
    const quelle = codeOhneKommentare();
    const start = quelle.indexOf("async function runDaily");
    expect(start, "`runDaily` nicht gefunden — Wächter ins Leere gelaufen")
      .toBeGreaterThan(-1);

    // Bis zur naechsten Top-Level-Deklaration lesen.
    const rest = quelle.slice(start);
    const ende = rest.search(/\n(?:export )?(?:async )?function |\n(?:export )?const /);
    const koerper = ende > 0 ? rest.slice(0, ende) : rest;

    const zweige = koerper
      .split("\n")
      .filter(z => /if\s*\(\s*hour\s*>=/.test(z));

    expect(zweige.length, "mindestens zwei Stunden-Zweige erwartet")
      .toBeGreaterThanOrEqual(2);

    const unentprellt = zweige.filter(z => !/alreadyRanToday\s*\(/.test(z));
    expect(
      unentprellt,
      "jeder Stunden-Zweig muss ueber `alreadyRanToday` entprellen, "
      + "nicht ueber eine eigene Variable",
    ).toEqual([]);
  });
});
