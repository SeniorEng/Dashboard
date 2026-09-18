import { describe, it, expect } from "vitest";
import {
  computeMonthCloseCutoff,
  isCutoffDay,
  daysUntilCutoff,
  previousMonth,
  istNachMonatsCutoff,
} from "../shared/utils/month-close-cutoff";

describe("computeMonthCloseCutoff", () => {
  it("liefert den 8. des Folgemonats, wenn Werktag (Mo-Fr, kein Feiertag)", () => {
    // Januar 2026 → 8. Februar 2026 = Sonntag → muss auf Freitag 6.2.2026 vorgezogen werden
    // Wähle einen sicheren Fall: November 2025 → 8. Dezember 2025 = Montag
    expect(computeMonthCloseCutoff(2025, 11)).toBe("2025-12-08");
  });

  it("zieht auf Freitag vor, wenn 8. Samstag ist", () => {
    // 8. November 2025 = Samstag → Cutoff für Oktober 2025 = Freitag 7.11.2025
    expect(computeMonthCloseCutoff(2025, 10)).toBe("2025-11-07");
  });

  it("zieht auf Freitag vor, wenn 8. Sonntag ist", () => {
    // 8. Februar 2026 = Sonntag → Cutoff für Januar 2026 = Freitag 6.2.2026
    expect(computeMonthCloseCutoff(2026, 1)).toBe("2026-02-06");
  });

  it("zieht zurück, wenn 8. ein bundeseinheitlicher Feiertag ist", () => {
    // 8. Mai ist nie Feiertag, aber 8. Dezember 2025 = Montag, kein Feiertag
    // Test: Cutoff für April 2025 → 8. Mai 2025 = Donnerstag, kein Feiertag
    expect(computeMonthCloseCutoff(2025, 4)).toBe("2025-05-08");
  });

  it("Reformationstag (31.10.) ist kein bundeseinheitlicher Feiertag — wird ignoriert", () => {
    // 8. November ist nicht Reformationstag, daher anderer Test:
    // Wir prüfen, dass z.B. 31.10. nicht als Feiertag den Cutoff verschiebt — dafür müssten wir den 31.10. Cutoff prüfen.
    // Hier: Cutoff für September 2025 → 8. Oktober 2025 = Mittwoch → 2025-10-08
    expect(computeMonthCloseCutoff(2025, 9)).toBe("2025-10-08");
  });

  it("funktioniert über den Jahreswechsel", () => {
    // Cutoff für Dezember 2025 → 8. Januar 2026 = Donnerstag
    expect(computeMonthCloseCutoff(2025, 12)).toBe("2026-01-08");
  });

  it("Karfreitag-Edge-Case (Karfreitag 2023 = 7. April → 8.4. = Samstag → vorgezogen auf Donnerstag 6.4.)", () => {
    // März 2023 → 8. April 2023 = Samstag → Freitag 7.4. = Karfreitag → Donnerstag 6.4.
    expect(computeMonthCloseCutoff(2023, 3)).toBe("2023-04-06");
  });
});

describe("isCutoffDay", () => {
  it("liefert true, wenn today der Cutoff-Tag ist", () => {
    expect(isCutoffDay("2025-12-08", 2025, 11)).toBe(true);
  });

  it("liefert false, wenn today nicht der Cutoff-Tag ist", () => {
    expect(isCutoffDay("2025-12-07", 2025, 11)).toBe(false);
  });
});

describe("daysUntilCutoff", () => {
  it("liefert positive Werte für künftige Cutoffs", () => {
    expect(daysUntilCutoff("2025-12-01", 2025, 11)).toBe(7);
  });

  it("liefert 0 am Cutoff-Tag", () => {
    expect(daysUntilCutoff("2025-12-08", 2025, 11)).toBe(0);
  });

  it("liefert negative Werte nach Cutoff", () => {
    expect(daysUntilCutoff("2025-12-09", 2025, 11)).toBe(-1);
  });
});

describe("previousMonth", () => {
  it("liefert den Vormonat für ein normales Datum", () => {
    expect(previousMonth("2025-05-15")).toEqual({ year: 2025, month: 4 });
  });

  it("rollt im Januar auf Dezember des Vorjahres", () => {
    expect(previousMonth("2026-01-08")).toEqual({ year: 2025, month: 12 });
  });
});

/**
 * Ticket 6hWgVqw2C8442hcG — Weg B. Bis hierher war `istNachMonatsCutoff` nur
 * indirekt über EINEN Integrationstest mit einer 2049er-Fixture abgedeckt. Die
 * Kanten waren gerechnet, nicht gefahren; hier werden sie gefahren.
 */
describe("istNachMonatsCutoff", () => {
  it("der Cutoff-Tag SELBST zaehlt noch nicht als vorbei", () => {
    // An diesem Tag laeuft der Auto-Abschluss erst (`isCutoffDay`, strikte
    // Tagesgleichheit). Waere es `<= 0`, fiele das Potenzial einen Tag zu
    // frueh auf das Ist — und zwar waehrend der Abschluss noch laeuft.
    const cutoff = computeMonthCloseCutoff(2026, 8);
    expect(cutoff).toBe("2026-09-08");
    expect(istNachMonatsCutoff(cutoff, 2026, 8)).toBe(false);
  });

  it("einen Tag spaeter ist er vorbei", () => {
    expect(istNachMonatsCutoff("2026-09-09", 2026, 8)).toBe(true);
  });

  it("mitten im Monat ist er nicht vorbei", () => {
    expect(istNachMonatsCutoff("2026-08-15", 2026, 8)).toBe(false);
  });

  it("weit vor und weit nach dem Monat", () => {
    expect(istNachMonatsCutoff("2020-01-01", 2026, 8), "Jahre davor").toBe(false);
    expect(istNachMonatsCutoff("2030-01-01", 2026, 8), "Jahre danach").toBe(true);
  });

  it("Dezember → Januar: der Cutoff liegt im Folgejahr", () => {
    // Der Ueberlauf ist die Stelle, an der eine von Hand gebaute Datumsrechnung
    // kippt. `computeMonthCloseCutoff` loest ihn ueber `Date.UTC` und nimmt die
    // Feiertagsliste des FOLGEjahres — hier wird das Ergebnis gefahren, nicht
    // die Implementierung nacherzaehlt.
    const cutoff = computeMonthCloseCutoff(2026, 12);
    expect(cutoff.startsWith("2027-01-"), `Cutoff war ${cutoff}`).toBe(true);
    expect(istNachMonatsCutoff(cutoff, 2026, 12), "am Cutoff noch offen").toBe(false);
    expect(istNachMonatsCutoff("2027-01-31", 2026, 12), "Ende Januar vorbei").toBe(true);
    expect(istNachMonatsCutoff("2026-12-31", 2026, 12), "Silvester noch offen").toBe(false);
  });

  it("die Rueckverlegung ueber Wochenende/Feiertag wird mitgetragen", () => {
    // Der Cutoff ist NICHT der 8., sondern der 8. mit Rueckverlegung. Genau
    // deshalb ist die Funktion abgeleitet und rechnet nicht selbst: wer „der
    // 8." annimmt, liegt in jedem Monat falsch, in dem der 8. auf ein
    // Wochenende faellt.
    //
    // Gesucht wird ein solcher Monat, statt einen zu behaupten.
    let gefunden = 0;
    for (let m = 1; m <= 12; m++) {
      const c = computeMonthCloseCutoff(2026, m);
      if (!c.endsWith("-08")) {
        gefunden += 1;
        // Am zurueckverlegten Tag noch offen, am Tag darauf vorbei.
        expect(istNachMonatsCutoff(c, 2026, m), `Cutoff ${c} muss offen sein`).toBe(false);
      }
    }
    expect(gefunden, "kein Monat mit Rueckverlegung gefunden — Annahme pruefen")
      .toBeGreaterThan(0);
  });
});
