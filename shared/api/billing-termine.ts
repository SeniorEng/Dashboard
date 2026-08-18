/**
 * Task #1473 — API-Vertrag der „Termine End-to-End"-Liste (Abrechnungsseite).
 *
 * Antwort von `GET /api/billing/termine`. Pro Mitarbeiter:in eine aufklappbare
 * Gruppe mit den Terminen des Monats; die Termin-zu-Mitarbeiter-Zuordnung folgt
 * der bestehenden SSoT (`shared/domain/appointment-attribution.ts`). Die
 * Lebenszyklus-Stufe eines Termins folgt der Pipeline-SSoT
 * (`shared/domain/billing-pipeline.ts`): vor Rechnung über `assignAppointmentStage`
 * (offen/dokumentiert/nachgewiesen), nach Rechnung über den Rechnungsstatus
 * (rechnung_erstellt/versendet/avis_erhalten/bezahlt). Der Side-State
 * „Kunde nicht angetroffen" (customer_no_show) IST als terminaler Filter-Zustand
 * Teil dieser Liste (trägt aber weiterhin KEINEN Geldbetrag — die €-Sicht bleibt
 * die Pipeline), damit entgangene Termine analysiert werden können. Die übrigen
 * Side-States (storniert, expired_unsigned) sind NICHT Teil dieser Liste; sie
 * erscheinen nur als Pipeline-Chips.
 *
 * Diese Liste trägt KEINE Geldbeträge (die Geld-Sicht lebt in der Pipeline);
 * eine Termin-Zeile zeigt nur Datum/Zeit, Kunde, Leistung und Stufe.
 */

/** Lebenszyklus-Stufe eines Termins in der Termine-Liste (Chips-Filter). */
export type BillingTermineStage =
  | "offen"
  | "dokumentiert"
  | "nachgewiesen"
  | "rechnung_erstellt"
  | "versendet"
  | "bezahlt"
  // Terminaler Side-Zustand, in der Liste nur als Filter sichtbar (kein Geldbetrag).
  | "kunde_nicht_angetroffen";

export interface BillingTermineAppointment {
  appointmentId: number;
  /** ISO yyyy-mm-dd. */
  date: string;
  /** HH:MM (lokale Anzeige). */
  time: string;
  customerId: number;
  customerName: string;
  /** Kurzlabel der Hauptleistung (z. B. „Hauswirtschaft", „Alltagsbegleitung"). */
  serviceLabel: string;
  stage: BillingTermineStage;
  /** Nur gesetzt, wenn der Termin bereits in einer Rechnung enthalten ist. */
  invoiceId?: number;
}

export interface BillingTermineEmployeeGroup {
  employeeId: number;
  employeeName: string;
  /** Termine, absteigend nach Datum. */
  appointments: BillingTermineAppointment[];
  /** Anzahl Termine je Stufe (für die Gruppen-Kopfzeile / Chips). */
  countsByStage: Record<BillingTermineStage, number>;
}

export interface BillingTermineResponse {
  billingYear: number;
  billingMonth: number;
  employees: BillingTermineEmployeeGroup[];
}
