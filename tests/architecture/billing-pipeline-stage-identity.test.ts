/**
 * Task #1405 — Architektur-Test: die Pipeline-Stage-Zuordnung ist TOTAL und
 * DISJUNKT.
 *
 * Hintergrund (Q1): „Eine Karte kann in N Stufen erscheinen, aber jeder € lebt
 * in genau EINER Stufe." Diese Invariante steht und fällt damit, dass die
 * reine Zuordnungsfunktion JEDE mögliche Atomic-Unit (Termin VOR Topf-Split,
 * Rechnung NACH Topf-Split) auf GENAU EINEN Ausgang abbildet — eine Stufe, ein
 * Side-Badge oder eine Exclusion. Ein nicht abgedeckter Status würde einen €
 * still verschwinden lassen (Konservierungs-Bruch); ein doppelt abgedeckter
 * Status würde ihn doppelt zählen.
 *
 * Was geprüft wird:
 *  1. `assignAppointmentStage` ist über ALLE (Termin-Status ×
 *     documentedAndSigned × isInvoiced)-Kombinationen total.
 *  2. `assignInvoiceStage` ist über ALLE (Rechnungs-Status × Rechnungs-Typ)-
 *     Kombinationen total.
 *  3. `summarizePipelineCents` zählt jeden € in genau einem Topf
 *     (Stufe XOR Side), excluded trägt nichts bei.
 */
import { describe, it, expect } from "vitest";
import {
  PIPELINE_STAGES,
  PIPELINE_SIDE_STATES,
  INVOICE_ACTION_CLUSTERS,
  assignAppointmentStage,
  assignInvoiceStage,
  assignInvoiceActionCluster,
  isAgingCluster,
  summarizePipelineCents,
  type PipelineAssignment,
  type AppointmentPipelineInput,
} from "@shared/domain/billing-pipeline";
import type { AppointmentStatus } from "@shared/domain/appointments";
import { INVOICE_STATUSES, INVOICE_TYPES } from "@shared/schema/billing";

const ALL_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  "scheduled",
  "documenting",
  "completed",
  "cancelled",
  "expired_unsigned",
  "customer_no_show",
];

const STAGE_SET = new Set<string>(PIPELINE_STAGES);
const SIDE_SET = new Set<string>(PIPELINE_SIDE_STATES);

function assertWellFormed(a: PipelineAssignment): void {
  // Genau EIN diskriminiertes Feld passt — total + disjunkt.
  if (a.kind === "stage") {
    expect(STAGE_SET.has(a.stage)).toBe(true);
  } else if (a.kind === "side") {
    expect(SIDE_SET.has(a.state)).toBe(true);
  } else {
    expect(a.kind).toBe("excluded");
    expect(["invoiced", "cancelled"]).toContain(a.reason);
  }
}

describe("billing-pipeline stage identity (total + disjunkt)", () => {
  it("assignAppointmentStage bildet jede Status-Kombination auf genau einen Ausgang ab", () => {
    for (const status of ALL_APPOINTMENT_STATUSES) {
      for (const billingType of [null, ...ALL_BILLING_TYPES]) {
        for (const hasDirectSignature of [false, true]) {
          for (const hasCompletedServiceRecord of [false, true]) {
            for (const hasEmployeeSignedServiceRecord of [false, true]) {
              for (const isInvoiced of [false, true]) {
                const input: AppointmentPipelineInput = {
                  status,
                  billingType,
                  hasDirectSignature,
                  hasCompletedServiceRecord,
                  hasEmployeeSignedServiceRecord,
                  isInvoiced,
                };
                assertWellFormed(assignAppointmentStage(input));
              }
            }
          }
        }
      }
    }
  });

  it("Termin-Mapping respektiert die fachliche Tabelle", () => {
    const base = {
      billingType: "selbstzahler" as string | null,
      hasDirectSignature: false,
      hasCompletedServiceRecord: false,
      hasEmployeeSignedServiceRecord: false,
      isInvoiced: false,
    };
    // scheduled/documenting → offen (unabhängig von Signatur, solange nicht abgerechnet)
    expect(assignAppointmentStage({ ...base, status: "scheduled" }))
      .toEqual({ kind: "stage", stage: "offen" });
    expect(assignAppointmentStage({ ...base, status: "documenting" }))
      .toEqual({ kind: "stage", stage: "offen" });
    // completed ohne Unterschrift → dokumentiert
    expect(assignAppointmentStage({ ...base, status: "completed" }))
      .toEqual({ kind: "stage", stage: "dokumentiert" });
    // completed mit direkter Unterschrift → unterschrieben (beide Zahler-Typen)
    expect(assignAppointmentStage({ ...base, status: "completed", hasDirectSignature: true }))
      .toEqual({ kind: "stage", stage: "unterschrieben" });
    // Task #1874 — Selbstzahler: employee_signed LN genügt → unterschrieben
    expect(assignAppointmentStage({ ...base, status: "completed", billingType: "selbstzahler", hasEmployeeSignedServiceRecord: true }))
      .toEqual({ kind: "stage", stage: "unterschrieben" });
    // Task #1874 — Pflegekasse: employee_signed LN allein → Side „Wartet auf Kundenunterschrift"
    expect(assignAppointmentStage({ ...base, status: "completed", billingType: "pflegekasse_gesetzlich", hasEmployeeSignedServiceRecord: true }))
      .toEqual({ kind: "side", state: "wartet_auf_kundenunterschrift" });
    expect(assignAppointmentStage({ ...base, status: "completed", billingType: "pflegekasse_privat", hasEmployeeSignedServiceRecord: true }))
      .toEqual({ kind: "side", state: "wartet_auf_kundenunterschrift" });
    // Task #1874 — Pflegekasse: completed LN (Kundenunterschrift) → unterschrieben
    expect(assignAppointmentStage({ ...base, status: "completed", billingType: "pflegekasse_gesetzlich", hasCompletedServiceRecord: true }))
      .toEqual({ kind: "stage", stage: "unterschrieben" });
    // abgerechnet → excluded invoiced (€ lebt auf der Rechnung)
    expect(assignAppointmentStage({ ...base, status: "completed", hasDirectSignature: true, isInvoiced: true }))
      .toEqual({ kind: "excluded", reason: "invoiced" });
    // cancelled → excluded cancelled (auch wenn fälschlich „abgerechnet")
    expect(assignAppointmentStage({ ...base, status: "cancelled", isInvoiced: true }))
      .toEqual({ kind: "excluded", reason: "cancelled" });
    // no-show / expired → Side-Badges (Vorrang vor isInvoiced)
    expect(assignAppointmentStage({ ...base, status: "customer_no_show", isInvoiced: true }))
      .toEqual({ kind: "side", state: "kunde_nicht_angetroffen" });
    expect(assignAppointmentStage({ ...base, status: "expired_unsigned" }))
      .toEqual({ kind: "side", state: "nicht_abgerechnet" });
  });

  it("assignInvoiceStage bildet jede GUELTIGE (Status × Typ)-Kombination auf genau einen Ausgang ab", () => {
    for (const status of INVOICE_STATUSES) {
      for (const invoiceType of INVOICE_TYPES) {
        // `abgeschlossen` ist Storno-Dokumenten vorbehalten. Die Kombination
        // mit einem anderen Typ ist kein Anzeigefall, sondern ein Datenfehler —
        // sie wird unten eigens geprueft.
        if (status === "abgeschlossen" && invoiceType !== "stornorechnung") continue;
        assertWellFormed(assignInvoiceStage({ status, invoiceType }));
      }
    }
  });

  it("ein unmoeglicher Zustand wirft, statt still eingeordnet zu werden", () => {
    // Das ist der Kern des Umbaus: der frueher „konservative" `default`-Zweig
    // hat `teilweise_bezahlt` bei seiner Einfuehrung unbemerkt auf
    // `rechnung_erstellt` geschickt — der Betrag zaehlte im Cockpit-Board neben
    // den Entwuerfen. Unbekanntes MUSS auffallen.
    expect(() => assignInvoiceStage({ status: "abgeschlossen", invoiceType: "rechnung" }))
      .toThrow(/Storno-Dokumenten vorbehalten/);
    expect(() => assignInvoiceStage({
      status: "avis_erhalten" as never,
      invoiceType: "rechnung",
    })).toThrow(/unbekannter Wert/);
  });

  it("Rechnungs-Mapping: Status→Stufe, Storno→Side, Storno-Dokument→eigener Side", () => {
    expect(assignInvoiceStage({ status: "entwurf", invoiceType: "rechnung" }))
      .toEqual({ kind: "stage", stage: "rechnung_erstellt" });
    expect(assignInvoiceStage({ status: "versendet", invoiceType: "rechnung" }))
      .toEqual({ kind: "stage", stage: "versendet" });
    expect(assignInvoiceStage({ status: "bezahlt", invoiceType: "rechnung" }))
      .toEqual({ kind: "stage", stage: "bezahlt" });
    // storniert → Side. Der TYP spielt dafuer keine Rolle mehr.
    expect(assignInvoiceStage({ status: "storniert", invoiceType: "rechnung" }))
      .toEqual({ kind: "side", state: "storniert" });
    // Ein Storno-DOKUMENT ist ein eigener Side-Zustand — nicht „storniert“.
    // Eine stornierte RECHNUNG und das STORNO-DOKUMENT dazu sind zwei
    // verschiedene Dinge, und die Trennung traegt die EUR-Ausschluss-Regel.
    expect(assignInvoiceStage({ status: "abgeschlossen", invoiceType: "stornorechnung" }))
      .toEqual({ kind: "side", state: "storno_dokument" });
  });

  it("summarizePipelineCents zählt jeden € genau einmal; excluded trägt nichts bei", () => {
    const summary = summarizePipelineCents([
      { assignment: { kind: "stage", stage: "offen" }, cents: 1000 },
      { assignment: { kind: "stage", stage: "offen" }, cents: 500 },
      { assignment: { kind: "stage", stage: "bezahlt" }, cents: 2000 },
      { assignment: { kind: "side", state: "storniert" }, cents: 9999 },
      { assignment: { kind: "excluded", reason: "invoiced" }, cents: 123456 },
      { assignment: { kind: "excluded", reason: "cancelled" }, cents: 777 },
    ]);
    expect(summary.stageCents.offen).toBe(1500);
    expect(summary.stageCents.bezahlt).toBe(2000);
    expect(summary.stageTotalCents).toBe(3500);
    expect(summary.sideCents.storniert).toBe(9999);
    expect(summary.sideTotalCents).toBe(9999);
    expect(summary.grandTotalCents).toBe(3500 + 9999);
    // excluded-€ (invoiced/cancelled) tauchen in keiner Summe auf
    expect(summary.grandTotalCents).not.toBe(3500 + 9999 + 123456 + 777);
  });

  // Task #1879 — Erwarteter Umsatz = Σ Stufen + „Wartet auf Kundenunterschrift".
  // Storniert / Kunde nicht angetroffen / Nicht abgerechnet bleiben ausgeschlossen.
  it("expectedRevenueTotalCents zählt wartet_auf_kundenunterschrift, nicht storniert/no-show/nicht-abgerechnet", () => {
    const summary = summarizePipelineCents([
      { assignment: { kind: "stage", stage: "offen" }, cents: 1000 },
      { assignment: { kind: "stage", stage: "bezahlt" }, cents: 2000 },
      { assignment: { kind: "side", state: "wartet_auf_kundenunterschrift" }, cents: 570 },
      { assignment: { kind: "side", state: "storniert" }, cents: 9999 },
      { assignment: { kind: "side", state: "kunde_nicht_angetroffen" }, cents: 4444 },
      { assignment: { kind: "side", state: "nicht_abgerechnet" }, cents: 3333 },
    ]);
    // Stufen-Summe (unverändert) schließt alle Side-Zustände aus.
    expect(summary.stageTotalCents).toBe(3000);
    // Erwarteter Umsatz = Stufen + „Wartet auf Kundenunterschrift".
    expect(summary.expectedRevenueTotalCents).toBe(3000 + 570);
    // Storniert/No-Show/Nicht-abgerechnet zählen NICHT mit.
    expect(summary.expectedRevenueTotalCents).not.toBe(summary.grandTotalCents);
    // Ohne „Wartet auf Kundenunterschrift"-Einheiten reproduziert sich die alte
    // Gesamt-Umsatz-Zahl (= reine Stufen-Summe).
    const withoutAwaiting = summarizePipelineCents([
      { assignment: { kind: "stage", stage: "offen" }, cents: 1000 },
      { assignment: { kind: "stage", stage: "bezahlt" }, cents: 2000 },
      { assignment: { kind: "side", state: "storniert" }, cents: 9999 },
    ]);
    expect(withoutAwaiting.expectedRevenueTotalCents).toBe(withoutAwaiting.stageTotalCents);
  });
});

// Task #1412 — Handlungs-Cluster der Rechnungsliste sind eine reine SICHT auf
// die bestehende `assignInvoiceStage`-Zuordnung + den Zahler-Typ. Die Zuordnung
// MUSS total (jede Rechnung landet in genau einem Cluster) und disjunkt sein,
// damit beim Gruppieren keine Rechnung still verschwindet oder doppelt erscheint.
const ALL_BILLING_TYPES = [
  "selbstzahler",
  "privat",
  "pflegekasse_gesetzlich",
  "pflegekasse_privat",
];

const CLUSTER_SET = new Set<string>(INVOICE_ACTION_CLUSTERS);

describe("billing action clusters (total + disjunkt, reine Sicht)", () => {
  it("assignInvoiceActionCluster bildet jede (Status × Typ × Zahler)-Kombination auf genau einen Cluster ab", () => {
    for (const status of INVOICE_STATUSES) {
      for (const invoiceType of INVOICE_TYPES) {
        for (const billingType of ALL_BILLING_TYPES) {
          // #1897: `hasBoundPayment` ist eine weitere Achse der Zuordnung — die
          // Totalitaet muss ueber BEIDE Auspraegungen halten, sonst faellt eine
          // gebundene Rechnung durch.
          if (status === "abgeschlossen" && invoiceType !== "stornorechnung") continue;
          for (const hasBoundPayment of [false, true]) {
            const cluster = assignInvoiceActionCluster({ status, invoiceType, billingType, hasBoundPayment });
            expect(CLUSTER_SET.has(cluster)).toBe(true);
          }
        }
      }
    }
  });

  it("Cluster-Mapping respektiert die fachliche Tabelle (komponiert assignInvoiceStage + Zahler-Typ)", () => {
    // Entwurf → noch zu versenden
    expect(assignInvoiceActionCluster({ status: "entwurf", invoiceType: "rechnung", billingType: "selbstzahler" }))
      .toBe("zu_versenden");
    expect(assignInvoiceActionCluster({ status: "entwurf", invoiceType: "rechnung", billingType: "pflegekasse_gesetzlich" }))
      .toBe("zu_versenden");
    // versendet → Zahlung ausstehend, UNABHAENGIG vom Zahler-Typ.
    //
    // Das ist die konkrete Wirkung von „Empfaenger-Unterschied raus aus dem
    // Modell": vorher fiel die Pflegekasse hier auf `avis_ausstehend`, weil der
    // Avis als eigener Wartezustand galt. Er ist eine Zuordnungs-Mechanik —
    // beide warten auf Zahlung.
    for (const billingType of ALL_BILLING_TYPES) {
      expect(
        assignInvoiceActionCluster({ status: "versendet", invoiceType: "rechnung", billingType }),
        `versendet/${billingType}`,
      ).toBe("zahlung_ausstehend");
    }
    // bezahlt → abgeschlossen
    expect(assignInvoiceActionCluster({ status: "bezahlt", invoiceType: "rechnung", billingType: "selbstzahler" }))
      .toBe("abgeschlossen");
    // Eine stornierte RECHNUNG → Storniert-Cluster.
    expect(assignInvoiceActionCluster({ status: "storniert", invoiceType: "rechnung", billingType: "selbstzahler" }))
      .toBe("storniert");
    // Ein STORNO-DOKUMENT → „abgeschlossen“. Es ist fertig, nicht storniert —
    // dieselbe Aussage wie bei einer bezahlten Rechnung.
    expect(assignInvoiceActionCluster({ status: "abgeschlossen", invoiceType: "stornorechnung", billingType: "pflegekasse_gesetzlich" }))
      .toBe("abgeschlossen");
  });

  // ---------------------------------------------------------------- #1897 ---
  it("gebundene Zahlung schlaegt den Wartelauf — beide Zahler-Typen", () => {
    for (const billingType of ALL_BILLING_TYPES) {
      // Nur noch EINE Warte-Stufe: `avis_erhalten` ist entfallen.
      for (const status of ["versendet"] as const) {
        expect(
          assignInvoiceActionCluster({ status, invoiceType: "rechnung", billingType, hasBoundPayment: true }),
          `${status}/${billingType} mit gebundener Zahlung`,
        ).toBe("zahlung_zugeordnet_pruefung");
      }
    }
  });

  it("`hasBoundPayment` ist optional und false-default (weggelassen == false)", () => {
    // ACHTUNG, was dieser Fall NICHT beweist: dass die Zuordnung ohne Flag
    // dieselbe ist wie vor #1897. `false` gegen `undefined` zu vergleichen ist
    // dafuer tautologisch — beide laufen durch denselben Zweig. Die Aussage
    // „unveraendert" traegt allein die Tabelle darunter.
    for (const status of INVOICE_STATUSES) {
      for (const invoiceType of INVOICE_TYPES) {
        for (const billingType of ALL_BILLING_TYPES) {
          if (status === "abgeschlossen" && invoiceType !== "stornorechnung") continue;
          const withFlag = assignInvoiceActionCluster({ status, invoiceType, billingType, hasBoundPayment: false });
          const withoutFlag = assignInvoiceActionCluster({ status, invoiceType, billingType });
          expect(withFlag, `${status}/${invoiceType}/${billingType}`).toBe(withoutFlag);
        }
      }
    }
  });

  it("ohne Bindung gilt die Zuordnung als Tabelle festgenagelt", () => {
    // Die vollstaendige Abbildung ohne Zahlungsbindung, Zeile fuer Zeile.
    const OHNE_BINDUNG: Record<string, InvoiceActionCluster> = {
      entwurf: "zu_versenden",
      versendet: "zahlung_ausstehend",
      bezahlt: "abgeschlossen",
      storniert: "storniert",
    };
    for (const [status, expected] of Object.entries(OHNE_BINDUNG)) {
      expect(
        assignInvoiceActionCluster({ status, invoiceType: "rechnung", billingType: "selbstzahler" }),
        `${status} ohne Bindung`,
      ).toBe(expected);
    }
    // Die Pflegekasse folgt jetzt derselben Zeile — kein eigener Abzweig mehr.
    expect(assignInvoiceActionCluster({ status: "versendet", invoiceType: "rechnung", billingType: "pflegekasse_gesetzlich" }))
      .toBe("zahlung_ausstehend");
  });

  it("Storno schlaegt die Zahlungsbindung (eine stornierte Rechnung ist kein Pruef-Fall)", () => {
    expect(assignInvoiceActionCluster({ status: "storniert", invoiceType: "rechnung", billingType: "selbstzahler", hasBoundPayment: true }))
      .toBe("storniert");
    // Ein Storno-Dokument ebenfalls nicht — es ist fertig.
    expect(assignInvoiceActionCluster({ status: "abgeschlossen", invoiceType: "stornorechnung", billingType: "selbstzahler", hasBoundPayment: true }))
      .toBe("abgeschlossen");
  });

  it("nur der Warte-Cluster altert (geteilte Regel fuer Cockpit UND Liste)", () => {
    // Vorher waren es ZWEI (`avis_ausstehend` + `zahlung_ausstehend`). Der
    // Avis-Cluster ist mit dem Empfaenger-Unterschied entfallen; die Regel
    // selbst ist unveraendert — altern tut, wer auf Zahlung wartet.
    const aging = INVOICE_ACTION_CLUSTERS.filter(isAgingCluster);
    expect(aging).toEqual(["zahlung_ausstehend"]);
    expect(isAgingCluster("zahlung_zugeordnet_pruefung")).toBe(false);
  });
});
