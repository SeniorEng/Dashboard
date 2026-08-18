import { describe, it, expect } from "vitest";
import {
  bewerteStatuszeilen,
  InvoiceStatusDomainError,
} from "../../server/startup/assert-invoice-status-domain";
import { INVOICE_STATUSES, LEGACY_INVOICE_STATUSES } from "@shared/schema/billing";

/**
 * Der Entscheidungskern des Rechnungs-Status-Boot-Gates (6hHqw8c7).
 *
 * ── Warum diese Fälle im Unit-Projekt liegen ────────────────────────────
 * Die erste Fassung prüfte alles gegen eine echte Datenbank — und der Fall
 * „leerer Bestand" zählte dabei die GANZE `invoices`-Tabelle. In CI teilen sich
 * die Dateien eines Shard-Legs eine Datenbank ohne Truncate; 106 Rechnungen aus
 * `tests/billing/` liefen davor. Der Test war keine Zusicherung, sondern eine
 * Wette auf die Shard-Verteilung, und in CI verloren.
 *
 * Der Kern ist rein: Zeilen rein, Befunde raus. Damit sind diese Fälle
 * unabhängig von Fremddaten, Reihenfolge und Datenbank.
 */

describe("bewerteStatuszeilen — Entscheidungskern des Boot-Gates", () => {
  it("leerer Bestand besteht", () => {
    // Die Gegenprobe zum Abbruch: das Gate darf nicht einfach immer werfen.
    // Frische Datenbanken (CI, Wegwerf-DB, erster Boot) haben keine Rechnungen.
    expect(bewerteStatuszeilen([])).toEqual({ befunde: [], betroffen: 0 });
  });

  it("jeder gültige Status passiert — gegen eine UNABHÄNGIG ausgeschriebene Liste", () => {
    // ── Warum die Werte hier hartkodiert stehen ──────────────────────────
    // Die erste Fassung iterierte `INVOICE_STATUSES` und erwartete, dass
    // `parseInvoiceStatus` sie akzeptiert. Das ist `x.includes(x[i])` — beide
    // Seiten lesen dieselbe Konstante, der Fall kann nicht rot werden. Die
    // Garantie, die er tragen sollte („fiele ein Wert heraus, bräche das Gate
    // bei normalen Daten ab"), hat er nie gemessen.
    //
    // Hier steht die Liste als zweite Quelle. Verschwindet ein Wert aus
    // `INVOICE_STATUSES`, ohne dass jemand diesen Fall anfasst, wird er rot —
    // und genau das soll er.
    const gueltig = ["entwurf", "versendet", "bezahlt", "storniert", "abgeschlossen"];

    for (const status of gueltig) {
      expect(bewerteStatuszeilen([{ status, anzahl: 1 }]).befunde, status).toEqual([]);
    }

    // Und die Gegenrichtung: die ausgeschriebene Liste MUSS die Union sein.
    // Kommt ein Status dazu, ohne dass dieser Fall ihn kennt, faellt es hier
    // auf — statt spaeter beim Boot gegen echte Daten.
    expect([...gueltig].sort()).toEqual([...INVOICE_STATUSES].sort());
  });

  it("ALTWERT: Befund mit Wert, Anzahl und Migrations-Hinweis", () => {
    const { befunde, betroffen } = bewerteStatuszeilen([{ status: "avis_erhalten", anzahl: 54 }]);
    expect(befunde).toHaveLength(1);
    expect(befunde[0]).toContain("avis_erhalten");
    expect(befunde[0], "Anzahl fehlt").toMatch(/54 Zeile/);
    expect(befunde[0], "Altwert-Hinweis fehlt").toContain("ALTWERT");
    expect(betroffen).toBe(54);
  });

  it("erkennt JEDEN dokumentierten Altwert, nicht nur den häufigsten", () => {
    // `teilweise_bezahlt` kam in Prod mit 0 Zeilen vor und wäre beim Testen
    // leicht vergessen worden — genau die Sorte Wert, die dann durchrutscht.
    for (const alt of LEGACY_INVOICE_STATUSES) {
      expect(bewerteStatuszeilen([{ status: alt, anzahl: 1 }]).befunde, alt).toHaveLength(1);
    }
  });

  it("ein völlig unbekannter Wert bricht ab — aber OHNE Altwert-Hinweis", () => {
    // Ein Tippfehler oder eine Handkorrektur ist kein Migrations-Fall. Die
    // Meldung darf dann nicht auf eine Migration verweisen, die es nicht gibt.
    const { befunde } = bewerteStatuszeilen([{ status: "voellig_unbekannt", anzahl: 2 }]);
    expect(befunde[0]).toContain("voellig_unbekannt");
    expect(befunde[0], "ALTWERT darf hier NICHT stehen").not.toMatch(/ALTWERT/);
  });

  it("mehrere kaputte Werte: alle gemeldet, Anzahl summiert", () => {
    const { befunde, betroffen } = bewerteStatuszeilen([
      { status: "versendet", anzahl: 100 },
      { status: "avis_erhalten", anzahl: 54 },
      { status: "teilweise_bezahlt", anzahl: 3 },
    ]);
    // Der gültige Wert erzeugt keinen Befund, die beiden Altwerte je einen.
    expect(befunde).toHaveLength(2);
    // Und die Summe zählt nur die betroffenen Zeilen, nicht den ganzen Bestand.
    expect(betroffen).toBe(57);
  });

  it("die Fehlermeldung sagt, warum der Abbruch die bessere Lage ist", () => {
    // Handlungsleitend heisst auch: der Operator soll den Abbruch nicht als
    // Panne lesen, sondern als Schutz — sonst umgeht er ihn.
    const fehler = new InvoiceStatusDomainError(["irgendein Befund"], 7);
    expect(fehler.message).toMatch(/7 Rechnung/);
    expect(fehler.message).toMatch(/alte Version online/);
    expect(fehler.message, "verweist auf keinen Pfad, den es nicht gibt")
      .not.toMatch(/docs\/rechnungsstatus-zielmodell\.md/);
  });
});
