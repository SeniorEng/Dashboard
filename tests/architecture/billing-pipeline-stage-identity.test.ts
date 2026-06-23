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
  assignAppointmentStage,
  assignInvoiceStage,
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
      for (const documentedAndSigned of [false, true]) {
        for (const isInvoiced of [false, true]) {
          const input: AppointmentPipelineInput = { status, documentedAndSigned, isInvoiced };
          const result = assignAppointmentStage(input);
          assertWellFormed(result);
        }
      }
    }
  });

  it("Termin-Mapping respektiert die fachliche Tabelle", () => {
    // scheduled/documenting → offen (unabhängig von Signatur, solange nicht abgerechnet)
    expect(assignAppointmentStage({ status: "scheduled", documentedAndSigned: false, isInvoiced: false }))
      .toEqual({ kind: "stage", stage: "offen" });
    expect(assignAppointmentStage({ status: "documenting", documentedAndSigned: false, isInvoiced: false }))
      .toEqual({ kind: "stage", stage: "offen" });
    // completed ohne Unterschrift → dokumentiert
    expect(assignAppointmentStage({ status: "completed", documentedAndSigned: false, isInvoiced: false }))
      .toEqual({ kind: "stage", stage: "dokumentiert" });
    // completed mit Unterschrift → unterschrieben
    expect(assignAppointmentStage({ status: "completed", documentedAndSigned: true, isInvoiced: false }))
      .toEqual({ kind: "stage", stage: "unterschrieben" });
    // abgerechnet → excluded invoiced (€ lebt auf der Rechnung)
    expect(assignAppointmentStage({ status: "completed", documentedAndSigned: true, isInvoiced: true }))
      .toEqual({ kind: "excluded", reason: "invoiced" });
    // cancelled → excluded cancelled (auch wenn fälschlich „abgerechnet")
    expect(assignAppointmentStage({ status: "cancelled", documentedAndSigned: false, isInvoiced: true }))
      .toEqual({ kind: "excluded", reason: "cancelled" });
    // no-show / expired → Side-Badges (Vorrang vor isInvoiced)
    expect(assignAppointmentStage({ status: "customer_no_show", documentedAndSigned: false, isInvoiced: true }))
      .toEqual({ kind: "side", state: "kunde_nicht_angetroffen" });
    expect(assignAppointmentStage({ status: "expired_unsigned", documentedAndSigned: false, isInvoiced: false }))
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
});
