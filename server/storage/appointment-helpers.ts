import {
  type Appointment,
  customers,
  appointments,
  users,
  prospects,
} from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { sql as sqlBuilder, type SQL } from "drizzle-orm";

/**
 * SQL-Fragment "Termine, die ein Mitarbeiter sehen darf".
 *
 * Ein Termin ist sichtbar, wenn:
 *  - er dem Mitarbeiter direkt zugewiesen ist (`assignedEmployeeId`), ODER
 *  - er nicht zugewiesen ist UND der Mitarbeiter Primär- oder Vertretungs-
 *    Mitarbeiter (1 oder 2) des Kunden ist.
 *
 * Vorausgesetzt: die `customers`-Tabelle ist gejoint (innerJoin oder
 * leftJoin). Bei leftJoin liefert NULL = userId konsistent FALSE, sodass
 * das Verhalten identisch bleibt.
 */
export function employeeVisibleAppointmentsFilter(userId: number): SQL {
  return sqlBuilder`(
    ${appointments.assignedEmployeeId} = ${userId}
    OR (${appointments.assignedEmployeeId} IS NULL AND (${customers.primaryEmployeeId} = ${userId} OR ${customers.backupEmployeeId} = ${userId} OR ${customers.backupEmployeeId2} = ${userId}))
  )`;
}

/**
 * SQL-Fragment "Termine, an denen ein Mitarbeiter (geplant oder tatsächlich)
 * gearbeitet hat" – für Pausen- und Arbeitszeit-Berechnungen.
 *
 * Ein Termin zählt, wenn der Mitarbeiter ihm zugewiesen ist ODER ihn
 * tatsächlich durchgeführt hat.
 */
export function employeeWorkedAppointmentsFilter(userId: number): SQL {
  return sqlBuilder`(${appointments.assignedEmployeeId} = ${userId} OR ${appointments.performedByEmployeeId} = ${userId})`;
}

const assignedEmployee = sqlBuilder`(SELECT display_name FROM users WHERE users.id = ${appointments.assignedEmployeeId})`.as("assigned_employee_name");

// Derived from appointment_services + services.lohnart_kategorie. Returns the
// human-readable label that the frontend (`getCardServiceInfoFromAppointment`,
// employee-time-card, day-detail-panel) historically read from the now-deprecated
// `appointments.service_type` column.
const derivedServiceType = sqlBuilder<string | null>`(
  SELECT CASE
    WHEN BOOL_OR(s.lohnart_kategorie = 'hauswirtschaft')
     AND BOOL_OR(s.lohnart_kategorie = 'alltagsbegleitung')
      THEN 'Hauswirtschaft & Alltagsbegleitung'
    WHEN BOOL_OR(s.lohnart_kategorie = 'hauswirtschaft') THEN 'Hauswirtschaft'
    WHEN BOOL_OR(s.lohnart_kategorie = 'alltagsbegleitung') THEN 'Alltagsbegleitung'
    ELSE NULL
  END
  FROM appointment_services asvc
  JOIN services s ON s.id = asvc.service_id
  WHERE asvc.appointment_id = ${appointments.id}
)`.as("service_type");

export const appointmentWithCustomerSelectFields = {
  id: appointments.id,
  customerId: appointments.customerId,
  prospectId: appointments.prospectId,
  createdByUserId: appointments.createdByUserId,
  assignedEmployeeId: appointments.assignedEmployeeId,
  appointmentType: appointments.appointmentType,
  serviceType: derivedServiceType,
  date: appointments.date,
  scheduledStart: appointments.scheduledStart,
  scheduledEnd: appointments.scheduledEnd,
  durationPromised: appointments.durationPromised,
  status: appointments.status,
  actualStart: appointments.actualStart,
  actualEnd: appointments.actualEnd,
  travelOriginType: appointments.travelOriginType,
  travelFromAppointmentId: appointments.travelFromAppointmentId,
  travelKilometers: appointments.travelKilometers,
  travelMinutes: appointments.travelMinutes,
  customerKilometers: appointments.customerKilometers,
  notes: appointments.notes,
  signatureData: appointments.signatureData,
  signatureHash: appointments.signatureHash,
  signedAt: appointments.signedAt,
  signedByUserId: appointments.signedByUserId,
  deletedAt: appointments.deletedAt,
  createdAt: appointments.createdAt,
  performedByEmployeeId: appointments.performedByEmployeeId,
  seriesId: appointments.seriesId,
  isSeriesException: appointments.isSeriesException,
  isFahrtdienst: appointments.isFahrtdienst,
  doctorName: appointments.doctorName,
  doctorAppointmentTime: appointments.doctorAppointmentTime,
  doctorStrasse: appointments.doctorStrasse,
  doctorNr: appointments.doctorNr,
  doctorPlz: appointments.doctorPlz,
  doctorStadt: appointments.doctorStadt,
  doctorLatitude: appointments.doctorLatitude,
  doctorLongitude: appointments.doctorLongitude,
  estimatedTravelMinutes: appointments.estimatedTravelMinutes,
  travelBufferMinutes: appointments.travelBufferMinutes,
  assignedEmployeeName: assignedEmployee,
  customer: {
    id: customers.id,
    name: customers.name,
    vorname: customers.vorname,
    nachname: customers.nachname,
    email: customers.email,
    festnetz: customers.festnetz,
    telefon: customers.telefon,
    geburtsdatum: customers.geburtsdatum,
    address: customers.address,
    strasse: customers.strasse,
    nr: customers.nr,
    plz: customers.plz,
    stadt: customers.stadt,
    pflegegrad: customers.pflegegrad,
    primaryEmployeeId: customers.primaryEmployeeId,
    backupEmployeeId: customers.backupEmployeeId,
    backupEmployeeId2: customers.backupEmployeeId2,
    createdAt: customers.createdAt,
    updatedAt: customers.updatedAt,
    createdByUserId: customers.createdByUserId,
    status: customers.status,
    latitude: customers.latitude,
    longitude: customers.longitude,
  },
  prospect: {
    id: prospects.id,
    vorname: prospects.vorname,
    nachname: prospects.nachname,
    telefon: prospects.telefon,
    email: prospects.email,
    strasse: prospects.strasse,
    nr: prospects.nr,
    plz: prospects.plz,
    stadt: prospects.stadt,
    pflegegrad: prospects.pflegegrad,
  }
};

type AppointmentQueryRow = typeof appointmentWithCustomerSelectFields extends infer T
  ? { [K in keyof T]: T[K] extends { $inferSelect: infer S } ? S : unknown }
  : never;

export function mapAppointmentRow(row: AppointmentQueryRow & Record<string, unknown>): AppointmentWithCustomer {
  return {
    id: row.id as number,
    customerId: row.customerId as number | null,
    prospectId: row.prospectId as number | null,
    createdByUserId: row.createdByUserId as number | null,
    assignedEmployeeId: row.assignedEmployeeId as number | null,
    appointmentType: row.appointmentType as string,
    serviceType: row.serviceType as string | null,
    date: row.date as string,
    scheduledStart: row.scheduledStart as string,
    scheduledEnd: row.scheduledEnd as string | null,
    durationPromised: row.durationPromised as number,
    status: row.status as string,
    actualStart: row.actualStart as string | null,
    actualEnd: row.actualEnd as string | null,
    travelOriginType: row.travelOriginType as string | null,
    travelFromAppointmentId: row.travelFromAppointmentId as number | null,
    travelKilometers: row.travelKilometers as number | null,
    travelMinutes: row.travelMinutes as number | null,
    customerKilometers: row.customerKilometers as number | null,
    notes: row.notes as string | null,
    signatureData: (row.signatureData as string | null) ?? null,
    signatureHash: (row.signatureHash as string | null) ?? null,
    signedAt: (row.signedAt as Date | null) ?? null,
    signedByUserId: (row.signedByUserId as number | null) ?? null,
    deletedAt: (row.deletedAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
    performedByEmployeeId: row.performedByEmployeeId as number | null,
    seriesId: (row.seriesId as number | null) ?? null,
    isSeriesException: (row.isSeriesException as boolean | null) ?? false,
    isFahrtdienst: (row.isFahrtdienst as boolean) ?? false,
    doctorName: (row.doctorName as string | null) ?? null,
    doctorAppointmentTime: (row.doctorAppointmentTime as string | null) ?? null,
    doctorStrasse: (row.doctorStrasse as string | null) ?? null,
    doctorNr: (row.doctorNr as string | null) ?? null,
    doctorPlz: (row.doctorPlz as string | null) ?? null,
    doctorStadt: (row.doctorStadt as string | null) ?? null,
    doctorLatitude: (row.doctorLatitude as number | null) ?? null,
    doctorLongitude: (row.doctorLongitude as number | null) ?? null,
    estimatedTravelMinutes: (row.estimatedTravelMinutes as number | null) ?? null,
    travelBufferMinutes: (row.travelBufferMinutes as number | null) ?? null,
    assignedEmployeeName: (row.assignedEmployeeName as string | null) ?? null,
    customer: (row.customer as { id?: number })?.id
      ? row.customer as AppointmentWithCustomer["customer"]
      : (row.prospect as { id?: number })?.id
        ? mapProspectAsCustomer(row.prospect as ProspectRow)
        : null,
  };
}

interface ProspectRow {
  id: number;
  vorname: string;
  nachname: string;
  telefon: string | null;
  email: string | null;
  strasse: string | null;
  nr: string | null;
  plz: string | null;
  stadt: string | null;
  pflegegrad: number | null;
}

/**
 * Maps prospect data into a Customer-shaped object for Erstberatung appointments.
 * Contact fields (name, telefon, email, address) come from the prospect.
 * Non-contact fields (billing, status, pets, etc.) use synthetic defaults
 * and should NOT be treated as real customer attributes.
 */
function mapProspectAsCustomer(p: ProspectRow): AppointmentWithCustomer["customer"] {
  const addressParts = [p.strasse, p.nr].filter(Boolean).join(" ");
  const cityParts = [p.plz, p.stadt].filter(Boolean).join(" ");
  const fullAddress = [addressParts, cityParts].filter(Boolean).join(", ");
  return {
    id: p.id,
    name: `${p.vorname} ${p.nachname}`,
    vorname: p.vorname,
    nachname: p.nachname,
    email: p.email,
    festnetz: null,
    telefon: p.telefon,
    geburtsdatum: null,
    address: fullAddress || "",
    strasse: p.strasse,
    nr: p.nr,
    plz: p.plz,
    stadt: p.stadt,
    pflegegrad: p.pflegegrad,
    beihilfeBerechtigt: false,
    rechnungAnKunde: false,
    primaryEmployeeId: null,
    backupEmployeeId: null,
    backupEmployeeId2: null,
    vorerkrankungen: null,
    haustierVorhanden: false,
    haustierDetails: null,
    status: "erstberatung",
    inaktivAb: null,
    personenbefoerderungGewuenscht: false,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
    documentDeliveryMethod: "email",
    deactivationReason: null,
    deactivationNote: null,
    mergedIntoCustomerId: null,
    convertedFromProspectId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdByUserId: null,
    deletedAt: null,
    isAnonymized: false,
    anonymizedAt: null,
    latitude: null,
    longitude: null,
    receivesMonthlyInvoice: false,
    setupSignaturesPending: false,
    setupDocumentsPending: false,
    setupBudgetsPending: false,
    setupDeliveryPending: false,
    setupPendingPayloads: null,
  };
}
