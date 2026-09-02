import { describe, expect, it } from "vitest";

import {
  billingReferenceDate,
  billingReferenceMonth,
  countPastWeekdaysInMonth,
  pastWeekdayInBillingMonth,
  snapToWeekday,
} from "./billing-month";
import { isWeekend } from "@shared/utils/datetime";

/**
 * Nagelt die Invariante fest, wegen der es diesen Helfer gibt: An JEDEM
 * Kalendertag muss der Ankertag auf einen Monat zeigen, der genug vergangene
 * Werktage für die Fixtures hat. Der Test läuft ohne DB und ohne Server.
 */
describe("billingReferenceDate — kalender-unabhängig", () => {
  const MIN = 5;

  it("liefert an jedem Tag von 2026 einen Monat mit >= 5 vergangenen Werktagen", () => {
    const bad: string[] = [];
    for (let month = 0; month < 12; month++) {
      const lastDay = new Date(2026, month + 1, 0).getDate();
      for (let day = 1; day <= lastDay; day++) {
        // 09:00 lokal: die Fixtures vergleichen gegen Mitternachts-Daten.
        const now = new Date(2026, month, day, 9, 0, 0);
        const ref = billingReferenceDate(now);
        if (countPastWeekdaysInMonth(ref) < MIN) {
          bad.push(`${now.toDateString()} -> ${ref.toDateString()}`);
        }
      }
    }
    expect(bad, `Tage ohne brauchbaren Anker:\n${bad.join("\n")}`).toEqual([]);
  });

  it("bleibt im laufenden Monat, sobald dieser genug Werktage hergibt", () => {
    // Di, 18.08.2026 — der August hat bis dahin reichlich Werktage.
    const now = new Date(2026, 7, 18, 9, 0, 0);
    const { year, month, reference } = billingReferenceMonth(now);
    expect(reference.getTime()).toBe(now.getTime());
    expect({ year, month }).toEqual({ year: 2026, month: 8 });
  });

  it("weicht am Monatsanfang auf den Vormonat aus — der Fall, der die Suite kippte", () => {
    // So, 02.08.2026: im August gibt es NULL vergangene Werktage.
    const now = new Date(2026, 7, 2, 9, 0, 0);
    expect(countPastWeekdaysInMonth(now)).toBe(0);

    const { year, month, reference } = billingReferenceMonth(now);
    expect({ year, month }).toEqual({ year: 2026, month: 7 });
    expect(reference.getDate()).toBe(31);
    expect(countPastWeekdaysInMonth(reference)).toBeGreaterThanOrEqual(MIN);
  });

  it("ist am Monatsletzten stabil (simulierter 31.07.2026, Freitag)", () => {
    const now = new Date(2026, 6, 31, 9, 0, 0);
    const { year, month, reference } = billingReferenceMonth(now);
    expect({ year, month }).toEqual({ year: 2026, month: 7 });
    expect(reference.getTime()).toBe(now.getTime());
  });

  it("überschreitet die Jahresgrenze korrekt (01.01. -> Dezember des Vorjahres)", () => {
    const now = new Date(2026, 0, 1, 9, 0, 0);
    const { year, month } = billingReferenceMonth(now);
    expect({ year, month }).toEqual({ year: 2025, month: 12 });
  });
});

/**
 * Dieselbe Kalender-Unabhängigkeit für den Termin-Slot selbst. Die duplizierten
 * `weekdayInCurrentMonth()`-Kopien lieferten am Wochenend-Monatsanfang entweder
 * einen Fehler oder — schlimmer — ein ZUKUNFTSDATUM, das die as-of-Leser nicht
 * zählen. Beides ist hier ausgeschlossen.
 */
describe("pastWeekdayInBillingMonth — nie leer, nie in der Zukunft", () => {
  it("liefert an jedem Tag von 2026 einen vergangenen Werktag im Anker-Monat", () => {
    const bad: string[] = [];
    for (let month = 0; month < 12; month++) {
      const lastDay = new Date(2026, month + 1, 0).getDate();
      for (let day = 1; day <= lastDay; day++) {
        const now = new Date(2026, month, day, 9, 0, 0);
        const iso = pastWeekdayInBillingMonth(now);
        const d = new Date(`${iso}T00:00:00`);
        const ref = billingReferenceDate(now);

        const dow = d.getDay();
        if (dow === 0 || dow === 6) bad.push(`${iso} (aus ${now.toDateString()}) ist ein Wochenende`);
        // Nie in der Zukunft — das war der eigentliche Defekt der Kopien.
        if (d.getTime() > now.getTime()) bad.push(`${iso} (aus ${now.toDateString()}) liegt in der ZUKUNFT`);
        // Und immer im Abrechnungs-Monat des Ankertags.
        if (d.getMonth() !== ref.getMonth() || d.getFullYear() !== ref.getFullYear()) {
          bad.push(`${iso} (aus ${now.toDateString()}) liegt nicht im Anker-Monat`);
        }
      }
    }
    expect(bad, `Fehlerhafte Tage:\n${bad.join("\n")}`).toEqual([]);
  });

  it("kippt NICHT am Wochenend-Monatsanfang (So, 02.08.2026 — der reale Auslöser)", () => {
    const now = new Date(2026, 7, 2, 9, 0, 0);
    // Die alten Kopien lieferten hier 2026-08-03 (Montag, ZUKUNFT) oder warfen.
    expect(pastWeekdayInBillingMonth(now)).toBe("2026-07-31");
  });

  it("bleibt im laufenden Monat, sobald dieser genug Werktage hat (Di, 18.08.2026)", () => {
    const now = new Date(2026, 7, 18, 9, 0, 0);
    expect(pastWeekdayInBillingMonth(now)).toBe("2026-08-18");
  });

  it("liegt im selben Monat wie `billingReferenceMonth` (Termin und Abrechnung driften nicht)", () => {
    for (const now of [new Date(2026, 7, 2, 9), new Date(2026, 0, 1, 9), new Date(2026, 2, 17, 9)]) {
      const { year, month } = billingReferenceMonth(now);
      const iso = pastWeekdayInBillingMonth(now);
      expect(iso.slice(0, 7)).toBe(`${year}-${String(month).padStart(2, "0")}`);
    }
  });
});

/**
 * `snapToWeekday` — Eigenschaftstest neben dem Helfer, nicht beim Aufrufer.
 *
 * Der Helfer hatte bis hierher KEINEN eigenen Test, obwohl vier Fixtures ihn
 * benutzen. Eine erste Fassung dieses Blocks lag in
 * `tests/equality/month-close-cutoff.test.ts` — also bei genau EINEM Aufrufer
 * und nur fuer dessen Aufrufform (`…-15`, vorwaerts). Hier erben ihn alle vier,
 * und die beiden anderen Aufrufformen sind mit abgedeckt:
 *   - `…-01` vorwaerts  (`tests/equality/45b-fifo-breakdown-consistency.test.ts`)
 *   - `…-01` RUECKWAERTS (`tests/budget/date-drift-pre-check-vs-booking.test.ts`)
 *
 * Der Rueckwaerts-Fall ist der interessante: am Monatsersten kann er den Monat
 * VERLASSEN. Das ist kein Fehler des Helfers — er verspricht Naehe, nicht
 * Monatstreue —, aber es ist eine Eigenschaft, die ein Aufrufer kennen muss.
 * Deshalb steht sie hier als Zusage und nicht als Ueberraschung.
 *
 * Bereich 1970-2100: nicht "viele Jahre" als Selbstzweck, sondern alle 14
 * moeglichen Kalenderjahr-Layouts mehrfach. Der Block braucht weder DB noch
 * Server noch Uhr.
 */
describe("snapToWeekday — jede Kalenderlage", () => {
  const monate = function* () {
    for (let jahr = 1970; jahr <= 2100; jahr++) {
      for (let monat = 1; monat <= 12; monat++) yield { jahr, monat };
    }
  };

  it("`…-15` vorwaerts: immer Werktag, immer derselbe Monat", () => {
    const kaputt: string[] = [];
    for (const { jahr, monat } of monate()) {
      const roh = `${jahr}-${String(monat).padStart(2, "0")}-15`;
      const g = snapToWeekday(roh);
      if (isWeekend(g)) kaputt.push(`${g} (aus ${roh}) ist Sa/So`);
      if (g.slice(0, 7) !== roh.slice(0, 7)) kaputt.push(`${g} (aus ${roh}) faellt aus dem Monat`);
    }
    expect(kaputt).toEqual([]);
  });

  it("`…-01` vorwaerts: immer Werktag, immer derselbe Monat", () => {
    const kaputt: string[] = [];
    for (const { jahr, monat } of monate()) {
      const roh = `${jahr}-${String(monat).padStart(2, "0")}-01`;
      const g = snapToWeekday(roh);
      if (isWeekend(g)) kaputt.push(`${g} (aus ${roh}) ist Sa/So`);
      if (g.slice(0, 7) !== roh.slice(0, 7)) kaputt.push(`${g} (aus ${roh}) faellt aus dem Monat`);
    }
    expect(kaputt).toEqual([]);
  });

  it("`…-01` rueckwaerts: immer Werktag — verlaesst aber bewusst den Monat", () => {
    let verlaesstMonat = 0;
    const kaputt: string[] = [];
    for (const { jahr, monat } of monate()) {
      const roh = `${jahr}-${String(monat).padStart(2, "0")}-01`;
      const g = snapToWeekday(roh, "backward");
      if (isWeekend(g)) kaputt.push(`${g} (aus ${roh}) ist Sa/So`);
      if (g.slice(0, 7) !== roh.slice(0, 7)) verlaesstMonat++;
    }
    expect(kaputt, "rueckwaerts muss ebenfalls immer auf einem Werktag landen").toEqual([]);
    // Die Zusage lautet Naehe, NICHT Monatstreue. Wer `backward` auf den
    // Monatsersten anwendet und Monatstreue braucht, muss selbst klammern.
    expect(verlaesstMonat, "erwartet: der Rueckwaerts-Fall verlaesst am Monatsersten den Monat")
      .toBeGreaterThan(0);
  });

  it("Gegenprobe: rohe `…-15` sind ueberhaupt oft Sa/So — sonst waere alles oben leer", () => {
    const wochenende: string[] = [];
    for (const { jahr, monat } of monate()) {
      const roh = `${jahr}-${String(monat).padStart(2, "0")}-15`;
      if (isWeekend(roh)) wochenende.push(roh);
    }
    expect(wochenende.length).toBeGreaterThan(100);
    // Der Tag, an dem `month-close-cutoff` in CI kippte (Ticket 6hQGx9WhX3hHHVXp).
    expect(wochenende).toContain("2026-08-15");
  });
});
