import { describe, expect, it } from "vitest";

import {
  billingReferenceDate,
  billingReferenceMonth,
  countPastWeekdaysInMonth,
  expirySubjectAnchor,
  pastWeekdayInBillingMonth,
} from "./billing-month";

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
 * Nagelt die Zusage fest, wegen der es `expirySubjectAnchor` gibt: Die
 * §45b-Frist muss an JEDEM Lauftag in der REALEN Zukunft liegen. Nur dann kann
 * der App-Server (eigener Prozess, reale Uhr) den Übertrag nicht vorzeitig
 * abschreiben, bevor der Test selbst einfriert. Läuft ohne DB und ohne Server.
 */
describe("expirySubjectAnchor — Frist immer real in der Zukunft", () => {
  it("liefert an jedem Tag eines Schaltjahres eine Frist nach dem Lauftag", () => {
    for (let day = 0; day < 366; day++) {
      const now = new Date(2028, 0, 1 + day, 12, 0, 0);
      const { sourceYear, targetYear, expiresAt } = expirySubjectAnchor(now);

      expect(sourceYear).toBe(now.getFullYear());
      expect(targetYear).toBe(now.getFullYear() + 1);
      // Die Frist ist exakt der 30.06. des Zieljahres (§45b Abs. 3) …
      expect(expiresAt).toBe(`${targetYear}-06-30`);
      // … und liegt strikt nach dem Lauftag.
      const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      expect(expiresAt > todayIso).toBe(true);
    }
  });

  it("überlebt den Jahreswechsel (31.12. → 01.01.)", () => {
    const silvester = expirySubjectAnchor(new Date(2026, 11, 31, 23, 59, 0));
    const neujahr = expirySubjectAnchor(new Date(2027, 0, 1, 0, 1, 0));
    expect(silvester.expiresAt).toBe("2027-06-30");
    expect(neujahr.expiresAt).toBe("2028-06-30");
    // In beiden Lagen bleibt die Frist nach dem jeweiligen Lauftag.
    expect(silvester.expiresAt > "2026-12-31").toBe(true);
    expect(neujahr.expiresAt > "2027-01-01").toBe(true);
  });

  it("friert auf den ersten Tag NACH der Frist ein, in ORTSZEIT (kein fixer UTC-Offset)", () => {
    const { targetYear, expiresAt, frozenJustAfterExpiry } = expirySubjectAnchor(
      new Date(2026, 7, 6, 12, 0, 0),
    );
    expect(frozenJustAfterExpiry).toBe(`${targetYear}-07-01T00:01:00`);
    // Ohne Offset geparst = Ortszeit; der lokale Kalendertag muss der Tag NACH
    // der Frist sein, sonst greift der Verfall im Test nicht.
    const frozen = new Date(frozenJustAfterExpiry);
    const localIso = `${frozen.getFullYear()}-${String(frozen.getMonth() + 1).padStart(2, "0")}-${String(frozen.getDate()).padStart(2, "0")}`;
    expect(localIso).toBe(`${targetYear}-07-01`);
    expect(localIso > expiresAt).toBe(true);
  });
});
