/**
 * Task #1473 — „Termine End-to-End"-Reader (Abrechnungsseite).
 *
 * EIN Lesepfad, der die Termine eines Monats pro Mitarbeiter:in gruppiert und
 * jedem Termin eine Lebenszyklus-Stufe zuordnet. Er KOMPONIERT bestehende
 * SSoTs statt sie zu duplizieren:
 *  - Termin-zu-Mitarbeiter-Zuordnung: `attributeAppointmentToEmployees`
 *    (`shared/domain/appointment-attribution.ts`).
 *  - Stufe VOR Rechnung: `assignAppointmentStage`
 *    (`shared/domain/billing-pipeline.ts`) — offen / dokumentiert /
 *    „unterschrieben" (im Termine-Vertrag „nachgewiesen").
 *  - Stufe NACH Rechnung: `assignInvoiceStage` über den Rechnungsstatus
 *    (rechnung_erstellt / versendet / avis_erhalten / bezahlt).
 *  - „dokumentiert & unterschrieben": `documentedAndSignedSqlRaw`
 *    (= SQL-Spiegel von `isAppointmentDocumentedAndSigned`).
 *
 * Der Side-State „Kunde nicht angetroffen" (customer_no_show) IST als terminaler
 * Filter-Zustand Teil dieser Liste (Vertrag `shared/api/billing-termine.ts`),
 * trägt aber keinen Geldbetrag. Die übrigen Side-States (storniert,
 * expired_unsigned) bleiben ausgeschlossen.
 *
 * Diese Liste trägt KEINE Geldbeträge (die Geld-Sicht lebt in der Pipeline).
 */
import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { num } from "../statistics/common";
import { documentedAndSignedSqlRaw } from "../../lib/appointment-signed";
import {
  assignAppointmentStage,
  assignInvoiceStage,
} from "@shared/domain/billing-pipeline";
import { attributeAppointmentToEmployees } from "@shared/domain/appointment-attribution";
import type { AppointmentStatus } from "@shared/domain/appointments";
import type {
  BillingTermineResponse,
  BillingTermineAppointment,
  BillingTermineEmployeeGroup,
  BillingTermineStage,
} from "@shared/api/billing-termine";

type Rows = Record<string, unknown>[];

const ALL_STAGES: BillingTermineStage[] = [
  "offen",
  "dokumentiert",
  "nachgewiesen",
  "rechnung_erstellt",
  "versendet",
  "avis_erhalten",
  "bezahlt",
  "kunde_nicht_angetroffen",
];

function emptyCounts(): Record<BillingTermineStage, number> {
  return ALL_STAGES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<BillingTermineStage, number>,
  );
}

const nullableInt = (v: unknown): number | null => (v != null ? num(v) : null);

/**
 * Liest die „Termine End-to-End"-Liste für einen Abrechnungs-Monat.
 *
 * @param billingYear  Abrechnungs-Jahr (z. B. 2026)
 * @param billingMonth Abrechnungs-Monat 1–12
 * @param opts         optionale Filter: Mitarbeiter:in und/oder Pflegekasse
 */
export async function readBillingTermine(
  billingYear: number,
  billingMonth: number,
  opts: { employeeId?: number; insuranceProviderId?: number } = {},
): Promise<BillingTermineResponse> {
  const { employeeId, insuranceProviderId } = opts;

  const insFilter = insuranceProviderId !== undefined
    ? sql`AND a.customer_id IN (
        SELECT cih.customer_id FROM customer_insurance_history cih
        WHERE cih.valid_to IS NULL AND cih.insurance_provider_id = ${insuranceProviderId}
      )`
    : sql``;

  // Termin-Status-Whitelist: aktive Stufen + „Kunde nicht angetroffen"
  // (customer_no_show, terminaler Filter-Zustand). cancelled bleibt aus der
  // Liste; expired_unsigned ist ein abgeleiteter, nicht persistierter Status.
  const rows = await db.execute(sql`
    SELECT
      a.id AS id,
      a.date::date::text AS date,
      a.scheduled_start AS scheduled_start,
      a.status AS status,
      a.assigned_employee_id AS assigned_employee_id,
      a.performed_by_employee_id AS performed_by_employee_id,
      a.customer_id AS customer_id,
      c.name AS customer_name,
      c.primary_employee_id AS primary_employee_id,
      c.backup_employee_id AS backup_employee_id,
      c.backup_employee_id_2 AS backup_employee_id_2,
      svc.label AS service_label,
      inv.invoice_id AS invoice_id,
      inv.invoice_status AS invoice_status,
      inv.invoice_type AS invoice_type,
      ${documentedAndSignedSqlRaw("a")} AS documented_and_signed
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN LATERAL (
      SELECT s.name AS label
      FROM appointment_services asvc
      JOIN services s ON s.id = asvc.service_id
      WHERE asvc.appointment_id = a.id
      ORDER BY
        CASE WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN 0 ELSE 1 END,
        COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes, 0) DESC NULLS LAST
      LIMIT 1
    ) svc ON true
    LEFT JOIN LATERAL (
      SELECT i.id AS invoice_id, i.status AS invoice_status, i.invoice_type AS invoice_type
      FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
      WHERE li.appointment_id = a.id
        AND i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
      ORDER BY i.id DESC
      LIMIT 1
    ) inv ON true
    WHERE a.deleted_at IS NULL
      AND a.status IN ('scheduled','documenting','completed','customer_no_show')
      AND EXTRACT(YEAR FROM a.date::date) = ${billingYear}
      AND EXTRACT(MONTH FROM a.date::date) = ${billingMonth}
      ${insFilter}
  `);

  const groups = new Map<number, BillingTermineEmployeeGroup>();
  const ensureGroup = (id: number): BillingTermineEmployeeGroup => {
    let g = groups.get(id);
    if (!g) {
      g = { employeeId: id, employeeName: "", appointments: [], countsByStage: emptyCounts() };
      groups.set(id, g);
    }
    return g;
  };

  for (const raw of rows.rows as Rows) {
    const status = String(raw.status) as AppointmentStatus;
    const invoiceId = nullableInt(raw.invoice_id);
    const isInvoiced = invoiceId != null;

    // Stufe folgt der Pipeline-SSoT `assignAppointmentStage`: terminale
    // Side-Zustände (Kunde nicht angetroffen) haben Vorrang vor „abgerechnet?",
    // danach greift der Rechnungsstatus, sonst die Termin-Stufe.
    const apptAssignment = assignAppointmentStage({
      status,
      documentedAndSigned: raw.documented_and_signed === true,
      isInvoiced,
    });
    let stage: BillingTermineStage | null = null;
    if (apptAssignment.kind === "side") {
      // Von den Side-Zuständen ist nur „Kunde nicht angetroffen" in der Liste
      // filterbar (storniert/expired_unsigned bleiben ausgeschlossen).
      if (apptAssignment.state === "kunde_nicht_angetroffen") {
        stage = "kunde_nicht_angetroffen";
      }
    } else if (apptAssignment.kind === "excluded" && apptAssignment.reason === "invoiced") {
      const invAssignment = assignInvoiceStage({
        status: String(raw.invoice_status),
        invoiceType: String(raw.invoice_type),
      });
      // Späte Stufen (rechnung_erstellt/versendet/avis_erhalten/bezahlt) sind
      // namensgleich mit den Termine-Stufen; Side („storniert") ist hier durch
      // den Join bereits ausgeschlossen.
      if (invAssignment.kind === "stage") {
        stage = invAssignment.stage as BillingTermineStage;
      }
    } else if (apptAssignment.kind === "stage") {
      // Pipeline „unterschrieben" === Termine-Vertrag „nachgewiesen".
      stage = apptAssignment.stage === "unterschrieben"
        ? "nachgewiesen"
        : (apptAssignment.stage as BillingTermineStage);
    }
    if (!stage) continue; // cancelled / expired_unsigned gehören nicht in die Liste.

    const attributed = attributeAppointmentToEmployees(
      {
        status,
        assignedEmployeeId: nullableInt(raw.assigned_employee_id),
        performedByEmployeeId: nullableInt(raw.performed_by_employee_id),
      },
      {
        primaryEmployeeId: nullableInt(raw.primary_employee_id),
        backupEmployeeId: nullableInt(raw.backup_employee_id),
        backupEmployeeId2: nullableInt(raw.backup_employee_id_2),
      },
    );
    const targetIds = employeeId !== undefined
      ? attributed.filter((id) => id === employeeId)
      : attributed;
    if (targetIds.length === 0) continue;

    const appt: BillingTermineAppointment = {
      appointmentId: num(raw.id),
      date: String(raw.date),
      time: String(raw.scheduled_start ?? "").slice(0, 5),
      customerId: num(raw.customer_id),
      customerName: String(raw.customer_name ?? ""),
      serviceLabel: String(raw.service_label ?? ""),
      stage,
      ...(invoiceId != null ? { invoiceId } : {}),
    };

    for (const id of targetIds) {
      const g = ensureGroup(id);
      g.appointments.push(appt);
      g.countsByStage[stage] += 1;
    }
  }

  // Mitarbeiter-Namen nachladen.
  const empIds = Array.from(groups.keys());
  if (empIds.length > 0) {
    const nameRes = await db.execute(sql`
      SELECT id, display_name FROM users
      WHERE id IN (${sql.join(empIds.map((id) => sql`${id}`), sql`, `)})
    `);
    const names = new Map<number, string>();
    for (const row of nameRes.rows as Rows) {
      names.set(num(row.id), String(row.display_name ?? ""));
    }
    for (const [id, g] of groups) {
      g.employeeName = names.get(id) ?? "";
    }
  }

  const employees = Array.from(groups.values())
    .map((g) => {
      // Termine absteigend nach Datum (dann Zeit).
      g.appointments.sort((a, b) =>
        a.date !== b.date ? (a.date < b.date ? 1 : -1) : (a.time < b.time ? 1 : -1),
      );
      return g;
    })
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  return { billingYear, billingMonth, employees };
}
