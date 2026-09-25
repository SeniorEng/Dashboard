/**
 * § 4 Nr. 16 g UStG — Rechnungstexte aus EINER Quelle (`shared/domain/ust-texte.ts`,
 * Ticket 6hcgffPJWm57p72p, Texte festgelegt von Alrik am 25.09.2026).
 * PDF und ZUGFeRD-BT-120 lesen dieselben Funktionen; die Abnahme auf dem
 * gerenderten PDF steht in `tests/billing/ust-4-16g.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  USTFREI_HINWEIS,
  ustfreiHinweis,
  leistungsempfaengerText,
  pflegegradZeitraeume,
} from "@shared/domain/ust-texte";

const frei = { vatRateBp: 0 };
const pflichtig = { vatRateBp: 1900 };

describe("Befreiungshinweis", () => {
  it("alle Positionen steuerfrei → der kurze Pflichthinweis", () => {
    expect(ustfreiHinweis([frei, frei])).toBe("Umsatzsteuerfreie Leistungen gemäß § 4 Nr. 16 UStG.");
  });

  it("keine steuerfreie Position → kein Hinweis", () => {
    expect(ustfreiHinweis([pflichtig])).toBeNull();
  });

  it("gemischt → Positionsbezug mit Bereichen", () => {
    expect(ustfreiHinweis([frei, frei, frei, pflichtig, frei])).toBe("Pos. 1–3, 5 sind umsatzsteuerfrei nach § 4 Nr. 16 UStG.");
    expect(ustfreiHinweis([pflichtig, frei])).toBe("Pos. 2 ist umsatzsteuerfrei nach § 4 Nr. 16 UStG.");
  });

  // „derselbe Text in PDF und ZUGFeRD-BT-120" sichert die e2e-Abnahme
  // (`ust-4-16g.test.ts`: BT-120 === USTFREI_HINWEIS im erzeugten XML).
});

describe("Leistungsempfänger mit Pflegegrad", () => {
  const p = (appointmentDate: string, pflegegradAmLeistungstag: number | null) => ({ appointmentDate, pflegegradAmLeistungstag });

  it("ein Grad an allen Leistungstagen → „Name (Pflegegrad N)“", () => {
    expect(leistungsempfaengerText("Erika Muster", [p("2026-10-02", 2), p("2026-10-20", 2)]))
      .toBe("Leistungsempfänger: Erika Muster (Pflegegrad 2)");
  });

  it("Wechsel im Monat → beide Grade mit Zeitraum (Format Alrik)", () => {
    expect(leistungsempfaengerText("Erika Muster", [p("2026-10-02", 2), p("2026-10-14", 2), p("2026-10-15", 3), p("2026-10-30", 3)]))
      .toBe("Leistungsempfänger: Erika Muster, Pflegegrad 2 (bis 14.10.), Pflegegrad 3 (ab 15.10.)");
  });

  it("Pflegegrad endet im Monat → „bis“, danach kein Grad (Pflichtfall 5)", () => {
    expect(leistungsempfaengerText("Erika Muster", [p("2026-08-10", 2), p("2026-08-20", null)]))
      .toBe("Leistungsempfänger: Erika Muster, Pflegegrad 2 (bis 10.08.)");
  });

  it("kein nachgewiesener Grad → nur der Name (Pflichtfall 6)", () => {
    expect(leistungsempfaengerText("Erika Muster", [p("2026-08-10", null)])).toBe("Leistungsempfänger: Erika Muster");
  });

  it("Zeiträume: Tage ohne Grad trennen, erscheinen aber nicht", () => {
    expect(pflegegradZeitraeume([p("2026-08-01", 2), p("2026-08-05", null), p("2026-08-09", 2)])).toEqual([
      { pflegegrad: 2, von: "2026-08-01", bis: "2026-08-01" },
      { pflegegrad: 2, von: "2026-08-09", bis: "2026-08-09" },
    ]);
  });
});
