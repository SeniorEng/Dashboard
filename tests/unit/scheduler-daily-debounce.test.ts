import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Wächter für die Tages-Entprellung in `runDaily()`
 * (`server/services/month-close-scheduler.ts`).
 *
 * ── Der Fehler ───────────────────────────────────────────────────────
 * Es gab EINE Variable `lastDailyRunDate` für alle Slots, je Slot mit
 * eigenem Suffix beschrieben (`today + "-reminder"` bzw.
 * `+ "-autoclose"`). Jeder Schreibvorgang löscht die Marke des anderen,
 * also ist die Bedingung des jeweils anderen Slots danach wieder wahr.
 *
 * Wirksam wird das in Stunde 23, wo beide Bedingungen gleichzeitig
 * gelten: läuft der Poll dort ein zweites Mal — nach einem Neustart in
 * diesem Fenster —, führt die Reminder-Welle ihre Abfragen erneut aus.
 * Ein Doppelversand entsteht nicht, weil die Sperre im Audit-Log sitzt.
 *
 * ── Warum ein Textprüfer und kein Verhaltenstest ─────────────────────
 * `runDaily` ist nicht exportiert, und der Zustand ist modul-lokal: ein
 * Verhaltenstest müsste den Scheduler starten, die Berliner Stunde
 * stellen und zwei Polls in derselben Stunde erzwingen. Das prüft dann
 * die Test-Mechanik, nicht die Aussage.
 *
 * Die Aussage ist strukturell — „jeder Slot hat seine eigene Marke" —
 * und genau das lässt sich am Quelltext belastbar prüfen. Der Wächter
 * ist bewusst schmal: er verbietet die EINE Form, die den Bug
 * ausmacht, und schreibt keine Implementierung vor.
 *
 * Gegen den Vorzustand sind beide Fälle ROT.
 */

const QUELLE = resolve(__dirname, "../../server/services/month-close-scheduler.ts");

function scheduler(): string {
  return readFileSync(QUELLE, "utf8");
}

/** Zeilen ohne Kommentare — der Docstring nennt den Altzustand absichtlich. */
function codeZeilen(): string[] {
  return scheduler()
    .split("\n")
    .filter(z => {
      const t = z.trim();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
}

describe("Scheduler — Tages-Entprellung je Slot", () => {
  it("SD-1 – keine geteilte Marke mit Slot-Suffix mehr", () => {
    // Die Signatur des Bugs: EINE Variable, in die mehrere Slots mit
    // unterschiedlichem Suffix schreiben.
    const treffer = codeZeilen().filter(z => /lastDailyRunDate/.test(z));
    expect(
      treffer,
      "`lastDailyRunDate` war die geteilte Marke — jeder Slot braucht seine eigene",
    ).toEqual([]);
  });

  it("SD-2 – kein Slot schreibt `today + \"-<suffix>\"` in eine Marke", () => {
    // Auch unter anderem Variablennamen bleibt das Muster falsch: ein
    // Suffix am Datum ist der Versuch, mehrere Slots in EINEN Wert zu
    // pressen.
    const treffer = codeZeilen().filter(z => /today\s*\+\s*["'`]-/.test(z));
    expect(
      treffer,
      "Slot-Unterscheidung gehoert in den Schluessel, nicht in den Wert",
    ).toEqual([]);
  });

  it("SD-3 – jeder Slot, der eine Marke setzt, hat einen eigenen Schluessel", () => {
    // Gegenprobe zu SD-1/SD-2: dass die alte Form weg ist, heisst noch
    // nicht, dass die neue trägt. Hier wird gezaehlt, ob es ueberhaupt
    // mehrere unterscheidbare Slots gibt — und ob sie verschieden sind.
    const quelle = scheduler();
    const schluessel = [...quelle.matchAll(/lastRunPerSlot\.set\(\s*([^,]+),/g)]
      .map(m => m[1].trim());

    expect(schluessel.length, "mindestens zwei Slots erwartet").toBeGreaterThanOrEqual(2);
    expect(
      new Set(schluessel).size,
      `zwei Slots teilen sich einen Schluessel: ${schluessel.join(", ")}`,
    ).toBe(schluessel.length);
  });

  it("SD-4 – die Schluessel sind Konstanten, keine losen Strings", () => {
    // Lose Strings an zwei Stellen sind der Weg, auf dem zwei Slots
    // versehentlich denselben Schluessel bekommen.
    const quelle = scheduler();
    expect(quelle, "DAILY_SLOTS fehlt").toContain("DAILY_SLOTS");

    const losString = [...quelle.matchAll(/lastRunPerSlot\.(?:set|get)\(\s*["'`]/g)];
    expect(
      losString.map(m => m[0]),
      "Slot-Schluessel gehoeren in `DAILY_SLOTS`, nicht als Literal an die Aufrufstelle",
    ).toEqual([]);
  });
});
