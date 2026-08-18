import { describe, expect, it } from "vitest";
import {
  assignInvoiceStage,
  assignInvoiceActionCluster,
  traegtOffeneForderung,
  istAktionsfaehigeRechnung,
  PIPELINE_STAGES,
} from "@shared/domain/billing-pipeline";
import { INVOICE_STATUSES, type InvoiceStatus } from "@shared/schema/billing";

/**
 * Die BENANNTE €-Ausschluss-Regel (Ziel-Spec, Abschnitt 4.4).
 *
 * ── Warum diese Datei existiert ─────────────────────────────────────────
 * Bis zum Status-Umbau folgte der Ausschluss der Storno-Beträge IMPLIZIT
 * daraus, dass der Typ `stornorechnung` in den Side-Zustand „storniert" fiel.
 * Der Umbau nimmt dem Typ genau diese Rolle — und damit wäre der Ausschluss
 * lautlos mit ihm verschwunden.
 *
 * Größenordnung, falls das passierte: die Storno-Dokumente tragen in Produktion
 * zusammen −15.884,35 €. Sie würden die Stufe `versendet` von 23.748,53 € auf
 * rund 7.864 € drücken — eine Zahl, die nichts Reales beschreibt, weil das
 * Original bereits als `storniert` herausgerechnet ist. Doppelzählung.
 *
 * Und das Entscheidende: es wäre **kein Test rot geworden**. Deshalb diese
 * Datei.
 */

function rechnung(status: InvoiceStatus, invoiceType = "rechnung") {
  return { status, invoiceType };
}

describe("Storno-Dokumente tragen keinen offenen Forderungsbetrag (Spec 4.4)", () => {
  it("1 — die Regel gilt unabhängig vom Status", () => {
    // Der Punkt der benannten Regel: sie hängt am TYP, nicht daran, welcher
    // Status gerade zufällig in den Side-Zustand fällt.
    for (const status of INVOICE_STATUSES) {
      expect(
        traegtOffeneForderung(rechnung(status, "stornorechnung")),
        `stornorechnung/${status}`,
      ).toBe(false);
    }
  });

  it("2 — normale Rechnungen und historische Nachberechnungen tragen sie sehr wohl", () => {
    for (const typ of ["rechnung", "nachberechnung"]) {
      expect(traegtOffeneForderung(rechnung("versendet", typ)), typ).toBe(true);
    }
  });

  it("3 — KEIN Storno-Dokument landet in einer €-tragenden Stufe", () => {
    // Die eigentliche Zusicherung. Stufen tragen die €-Summen des
    // Cockpit-Boards; ein Side-Zustand tut das nicht.
    for (const status of INVOICE_STATUSES) {
      const zuordnung = assignInvoiceStage(rechnung(status, "stornorechnung"));
      expect(zuordnung.kind, `stornorechnung/${status}`).toBe("side");
      if (zuordnung.kind === "side") {
        expect(zuordnung.state).toBe("storno_dokument");
      }
    }
  });

  it("4 — jede Stufe ist ausschliesslich von forderungstragenden Dokumenten erreichbar", () => {
    // Gegenrichtung zu Test 3: keine Stufe darf über den Storno-Typ erreichbar
    // sein. Fiele die Regel weg, würde hier `versendet` erscheinen.
    const erreichteStufen = new Set<string>();
    for (const status of INVOICE_STATUSES) {
      const z = assignInvoiceStage(rechnung(status, "stornorechnung"));
      if (z.kind === "stage") erreichteStufen.add(z.stage);
    }
    expect([...erreichteStufen], "Storno-Dokumente in Stufen").toEqual([]);
    // Und die Stufen selbst existieren weiterhin — sonst prüfte Test 4 nichts.
    expect(PIPELINE_STAGES.length).toBeGreaterThan(0);
  });

  it("5 — ein Storno-Dokument ist nie aktionsfaehig", () => {
    // `istAktionsfaehigeRechnung` speist Listen-Auswahl, Massenaktionen und
    // Druckliste. Vor dem Umbau ergab sich das aus `!isStorniertInvoice`;
    // seither muss es die benannte Regel tragen.
    for (const status of INVOICE_STATUSES) {
      expect(
        istAktionsfaehigeRechnung(rechnung(status, "stornorechnung")),
        `stornorechnung/${status}`,
      ).toBe(false);
    }
  });

  it("6 — im Cluster steht es bei den Gutschriften, NICHT bei „abgeschlossen“", () => {
    // ── Was diese Prüfung vorher behauptete ──────────────────────────────
    // „Ein Storno-Dokument ist FERTIG, nicht storniert — deshalb derselbe
    // Cluster wie eine bezahlte Rechnung." Das verwechselte zwei Ebenen: der
    // STATUS `abgeschlossen` beschreibt das Dokument, der CLUSTER gruppiert die
    // Rechnungsliste und trägt je Gruppe eine €-Summe.
    //
    // Storno-Dokumente tragen negative Beträge. Im Cluster „Bezahlt —
    // abgeschlossen" hätten sie die Summe um −15.884,35 € (Prod) gedrückt,
    // während „Stornierte Rechnungen und Gutschriften" die Gegenbuchung
    // verloren hätte, die sich dort gegen die stornierten Originale aufhebt.
    for (const status of INVOICE_STATUSES) {
      expect(
        assignInvoiceActionCluster({
          status,
          invoiceType: "stornorechnung",
          billingType: "pflegekasse_gesetzlich",
        }),
        `stornorechnung/${status}`,
      ).toBe("storniert");
    }

    // Eine stornierte RECHNUNG liegt im selben Cluster — dort heben sich
    // Original und Gutschrift gegeneinander auf. Genau das ist der Zweck.
    expect(assignInvoiceActionCluster({
      status: "storniert",
      invoiceType: "rechnung",
      billingType: "pflegekasse_gesetzlich",
    })).toBe("storniert");

    // Gegenprobe: eine BEZAHLTE Rechnung ist „abgeschlossen“ — sonst prüfte
    // der Fall oben nur, dass irgendetwas nie diesen Cluster erreicht.
    expect(assignInvoiceActionCluster({
      status: "bezahlt",
      invoiceType: "rechnung",
      billingType: "pflegekasse_gesetzlich",
    })).toBe("abgeschlossen");
  });
});
