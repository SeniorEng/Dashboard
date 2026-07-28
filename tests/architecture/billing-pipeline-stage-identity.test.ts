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

  it("assignInvoiceStage bildet jede (Status × Typ)-Kombination auf genau einen Ausgang ab", () => {
    for (const status of INVOICE_STATUSES) {
      for (const invoiceType of INVOICE_TYPES) {
        assertWellFormed(assignInvoiceStage({ status, invoiceType }));
      }
    }
  });

  it("Rechnungs-Mapping: Status→Stufe, Storno/Gutschrift→Side", () => {
    expect(assignInvoiceStage({ status: "entwurf", invoiceType: "rechnung" }))
      .toEqual({ kind: "stage", stage: "rechnung_erstellt" });
    expect(assignInvoiceStage({ status: "versendet", invoiceType: "rechnung" }))
      .toEqual({ kind: "stage", stage: "versendet" });
    expect(assignInvoiceStage({ status: "avis_erhalten", invoiceType: "rechnung" }))
      .toEqual({ kind: "stage", stage: "avis_erhalten" });
    expect(assignInvoiceStage({ status: "bezahlt", invoiceType: "rechnung" }))
      .toEqual({ kind: "stage", stage: "bezahlt" });
    // storniert (egal welcher Typ) → Side
    expect(assignInvoiceStage({ status: "storniert", invoiceType: "rechnung" }))
      .toEqual({ kind: "side", state: "storniert" });
    // Gutschrift → Side, auch wenn der Status noch „versendet" ist
    expect(assignInvoiceStage({ status: "versendet", invoiceType: "stornorechnung" }))
      .toEqual({ kind: "side", state: "storniert" });
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
          const cluster = assignInvoiceActionCluster({ status, invoiceType, billingType });
          expect(CLUSTER_SET.has(cluster)).toBe(true);
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
    // versendet: Pflegekasse → Avis ausstehend, Selbstzahler/Privat → Zahlung ausstehend
    expect(assignInvoiceActionCluster({ status: "versendet", invoiceType: "rechnung", billingType: "pflegekasse_gesetzlich" }))
      .toBe("avis_ausstehend");
    expect(assignInvoiceActionCluster({ status: "versendet", invoiceType: "rechnung", billingType: "pflegekasse_privat" }))
      .toBe("avis_ausstehend");
    expect(assignInvoiceActionCluster({ status: "versendet", invoiceType: "rechnung", billingType: "selbstzahler" }))
      .toBe("zahlung_ausstehend");
    expect(assignInvoiceActionCluster({ status: "versendet", invoiceType: "rechnung", billingType: "privat" }))
      .toBe("zahlung_ausstehend");
    // avis_erhalten (immer Pflegekasse) → Zahlung ausstehend
    expect(assignInvoiceActionCluster({ status: "avis_erhalten", invoiceType: "rechnung", billingType: "pflegekasse_gesetzlich" }))
      .toBe("zahlung_ausstehend");
    // bezahlt → abgeschlossen
    expect(assignInvoiceActionCluster({ status: "bezahlt", invoiceType: "rechnung", billingType: "selbstzahler" }))
      .toBe("abgeschlossen");
    // storniert / Gutschrift → eigener Storniert-Cluster (Totalität)
    expect(assignInvoiceActionCluster({ status: "storniert", invoiceType: "rechnung", billingType: "selbstzahler" }))
      .toBe("storniert");
    expect(assignInvoiceActionCluster({ status: "versendet", invoiceType: "stornorechnung", billingType: "pflegekasse_gesetzlich" }))
      .toBe("storniert");
  });
});
