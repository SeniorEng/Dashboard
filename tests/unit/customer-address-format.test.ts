/**
 * Task #1030 — Unit-Tests für die reine Stammadress-Formatierung (SSoT für die
 * Leistungsnachweis-„Leistungsempfänger/in"-Anschrift und den Selbstzahler-/
 * Kostenerstattungs-Rechnungsempfänger).
 *
 * Der String MUSS byte-genau zur Inline-Formatierung im
 * `invoice-pdf-orchestrator` (Kostenerstattungs-Override) passen, damit
 * Render-Pfad und Daten-Korrektur denselben Wert erzeugen.
 */
import { describe, it, expect } from "vitest";
import { formatCustomerMasterAddress } from "../../server/lib/customer-address-format";

describe("formatCustomerMasterAddress", () => {
  it("formatiert Strasse+Nr in Zeile 1 und PLZ+Stadt in Zeile 2", () => {
    expect(
      formatCustomerMasterAddress({ strasse: "Musterweg", nr: "12a", plz: "10115", stadt: "Berlin" }),
    ).toBe("Musterweg 12a\n10115 Berlin");
  });

  it("lässt fehlende Hausnummer in Zeile 1 weg", () => {
    expect(
      formatCustomerMasterAddress({ strasse: "Musterweg", nr: null, plz: "10115", stadt: "Berlin" }),
    ).toBe("Musterweg\n10115 Berlin");
  });

  it("rendert nur PLZ wenn Stadt fehlt", () => {
    expect(
      formatCustomerMasterAddress({ strasse: "Musterweg", nr: "1", plz: "10115", stadt: null }),
    ).toBe("Musterweg 1\n10115");
  });

  it("rendert nur Stadt wenn PLZ fehlt", () => {
    expect(
      formatCustomerMasterAddress({ strasse: "Musterweg", nr: "1", plz: null, stadt: "Berlin" }),
    ).toBe("Musterweg 1\nBerlin");
  });

  it("gibt nur Zeile 1 zurück, wenn PLZ und Stadt fehlen", () => {
    expect(
      formatCustomerMasterAddress({ strasse: "Musterweg", nr: "1", plz: null, stadt: null }),
    ).toBe("Musterweg 1");
  });

  it("gibt null zurück, wenn alle Felder leer/null sind", () => {
    expect(formatCustomerMasterAddress({ strasse: null, nr: null, plz: null, stadt: null })).toBeNull();
    expect(formatCustomerMasterAddress({ strasse: "", nr: "", plz: "", stadt: "" })).toBeNull();
    expect(formatCustomerMasterAddress({})).toBeNull();
  });

  it("matcht byte-genau die Orchestrator-Inline-Formatierung", () => {
    const c = { strasse: "Lindenstr.", nr: "7", plz: "20095", stadt: "Hamburg" };
    const inline =
      [c.strasse, c.nr].filter(Boolean).join(" ") +
      (c.plz || c.stadt ? `\n${c.plz || ""} ${c.stadt || ""}` : "");
    expect(formatCustomerMasterAddress(c)).toBe(inline);
  });
});
