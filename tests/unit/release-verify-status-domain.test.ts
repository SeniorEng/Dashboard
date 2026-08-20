/**
 * Der reine Kern des Release-Steps (6hHqw8c7).
 *
 * Warum hier und nicht als Integrationstest: `bewerteStatuszeilen` bekommt
 * Zeilen und gibt Befunde zurück — keine DB nötig. Ein früherer Entwurf prüfte
 * gegen die echte Tabelle und zählte dabei den GANZEN Bestand statt der eigenen
 * Fixture; „leerer Bestand" war dort nicht darstellbar. Der reine Kern kennt
 * das Problem nicht.
 */
import { describe, expect, it } from "vitest";
import {
  bewerteStatuszeilen,
  releaseAbbruchMeldung,
} from "@shared/domain/invoice-status-domain";
import { INVOICE_STATUSES } from "@shared/schema/billing";

describe("bewerteStatuszeilen", () => {
  it("leerer Bestand ist lesbar (allererster Deploy)", () => {
    const befund = bewerteStatuszeilen([]);
    expect(befund.befunde).toEqual([]);
    expect(befund.betroffen).toBe(0);
  });

  it("laesst jeden Status durch, den das SSoT kennt", () => {
    const zeilen = INVOICE_STATUSES.map((status) => ({ status, anzahl: 1 }));
    const befund = bewerteStatuszeilen(zeilen);
    expect(befund.befunde).toEqual([]);
    expect(befund.betroffen).toBe(0);
  });

  it("faengt den Altwert, an dem der 18.08.2026 gescheitert ist", () => {
    const befund = bewerteStatuszeilen([{ status: "avis_erhalten", anzahl: 54 }]);
    expect(befund.befunde).toHaveLength(1);
    expect(befund.befunde[0]).toContain("avis_erhalten");
    expect(befund.betroffen).toBe(54);
  });

  it("summiert ueber mehrere unbekannte Werte und prueft nach dem ersten weiter", () => {
    const befund = bewerteStatuszeilen([
      { status: "avis_erhalten", anzahl: 54 },
      { status: "bezahlt", anzahl: 900 },
      { status: "teilweise_bezahlt", anzahl: 3 },
    ]);
    // Beide Altwerte gemeldet — ein Abbruch beim ersten würde den zweiten
    // verschweigen und einen zweiten Fehlversuch nötig machen.
    expect(befund.befunde).toHaveLength(2);
    expect(befund.betroffen).toBe(57);
  });

  it("zaehlt bekannte Werte NICHT zu den Betroffenen", () => {
    const befund = bewerteStatuszeilen([
      { status: "bezahlt", anzahl: 1000 },
      { status: "avis_erhalten", anzahl: 1 },
    ]);
    expect(befund.betroffen).toBe(1);
  });

  it("faengt auch Muell, der kein Altwert ist (leerer String, NULL-Ersatz)", () => {
    const befund = bewerteStatuszeilen([
      { status: "", anzahl: 2 },
      { status: "Bezahlt", anzahl: 1 },
    ]);
    expect(befund.befunde).toHaveLength(2);
    expect(befund.betroffen).toBe(3);
  });
});

describe("releaseAbbruchMeldung", () => {
  it("nennt Anzahl, den konkreten Wert und den Weg zur Behebung", () => {
    const meldung = releaseAbbruchMeldung(
      bewerteStatuszeilen([{ status: "avis_erhalten", anzahl: 54 }]),
    );
    expect(meldung).toContain("RELEASE ABGEBROCHEN");
    expect(meldung).toContain("54 Rechnung(en)");
    expect(meldung).toContain("avis_erhalten");
    expect(meldung).toContain("docs/rechnungsstatus-zielmodell.md");
    // Der Betreiber soll ohne Nachfrage wissen, dass die alte Version weiter
    // bedient — sonst wird aus einem sauberen Abbruch ein Panik-Eingriff.
    expect(meldung).toContain("laufende Version bleibt unberührt");
  });

  it("gibt die DATABASE_URL nicht weiter (die Meldung landet in Deploy-Logs)", () => {
    const meldung = releaseAbbruchMeldung(
      bewerteStatuszeilen([{ status: "avis_erhalten", anzahl: 1 }]),
    );
    expect(meldung).not.toMatch(/postgres(ql)?:\/\//);
  });
});
