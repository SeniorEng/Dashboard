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

  it("6 — im Cluster erscheint es als „abgeschlossen“, nicht als „storniert“", () => {
    // Fachlich: ein Storno-Dokument ist FERTIG, nicht storniert. Dieselbe
    // Aussage wie bei einer bezahlten Rechnung — deshalb derselbe Cluster.
    const cluster = assignInvoiceActionCluster({
      status: "abgeschlossen",
      invoiceType: "stornorechnung",
      billingType: "pflegekasse_gesetzlich",
    });
    expect(cluster).toBe("abgeschlossen");

    // Eine wirklich stornierte RECHNUNG dagegen bleibt „storniert“.
    expect(assignInvoiceActionCluster({
      status: "storniert",
      invoiceType: "rechnung",
      billingType: "pflegekasse_gesetzlich",
    })).toBe("storniert");
  });
});
