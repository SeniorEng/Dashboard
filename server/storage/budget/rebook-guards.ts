/**
 * Task #1785 — Schutzgitter für Budget-Umwidmung (Umbuchung).
 *
 * Zwei Guards, die JEDER Umbuchungs-Pfad (Einzel-, Monats-/Bulk- und der
 * Kürzungs-Ablauf) VOR jeder Mutation durchlaufen muss — als
 * Defense-in-Depth in der Storage-Schicht, damit keine Route sie umgehen kann:
 *
 *  1. Monatsabschluss: Berührt eine Umbuchung Termine in einem für den
 *     verantwortlichen Mitarbeiter bereits abgeschlossenen Monat, ist sie nur
 *     noch der Geschäftsführung (Superadmin) erlaubt. Spiegelt exakt die
 *     Termin-Policy (`shared/policies/appointments.ts`) und dieselbe
 *     Verantwortlichkeits-Ableitung wie der Monatsabschluss selbst
 *     (`COALESCE(performedBy, assigned, primaryEmployee)`).
 *
 *  2. Bereits gestellte Rechnung: Hängt der umzubuchende Verbrauch an einer
 *     AKTIVEN, gestellten (nicht-Entwurf, nicht-stornierten) Rechnung, ist die
 *     DIREKTE Umbuchung gesperrt — der korrekte Weg ist Storno + Neuausstellung
 *     (#1785 Kürzungs-Ablauf). Da jener Ablauf zuerst storniert, ist der
 *     Verbrauch danach an keine aktive Rechnung mehr gebunden und passiert
 *     diese Prüfung von selbst (`allowIssuedInvoices` bleibt daher i. d. R.
 *     ungenutzt; es existiert nur als expliziter Notausgang).
 */

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  appointments,
  customers,
  invoices as invoicesTable,
  invoiceLineItems,
} from "@shared/schema";
import { db, type DbOrTx } from "../../lib/db";
import { AppError } from "../../lib/errors";
import { isMonthClosed } from "../time-tracking/month-closing";
import { appointmentsRepo } from "../../repos";
import { activeInvoiceCondition } from "../../lib/appointment-invoiced";

export interface RebookActor {
  userId: number;
  isSuperAdmin: boolean;
}

export interface RebookGuardOptions {
  /**
   * Überspringt die „bereits gestellte Rechnung"-Prüfung. Ausschließlich für
   * den Kürzungs-Ablauf (#1785 P4) gedacht, der die Rechnung in DERSELBEN
   * Transaktion zuerst storniert. Standard: false (harter Block).
   */
  allowIssuedInvoices?: boolean;
}

/** Umbuchung berührt einen abgeschlossenen Monat und der Akteur ist kein Superadmin. */
export class RebookMonthClosedError extends AppError {
  readonly affectedAppointmentIds: number[];
  constructor(affectedAppointmentIds: number[]) {
    super(
      403,
      "MONTH_CLOSED",
      `Der Monat ist bereits abgeschlossen. Umbuchungen in diesem Zeitraum sind nur noch durch die Geschäftsführung möglich (betroffen: ${affectedAppointmentIds.length} Termin${affectedAppointmentIds.length === 1 ? "" : "e"}).`,
      "MONTH_CLOSED",
    );
    this.name = "RebookMonthClosedError";
    this.affectedAppointmentIds = affectedAppointmentIds;
  }
}

/** Umbuchung berührt Verbrauch, der an einer aktiven, gestellten Rechnung hängt. */
export class RebookIssuedInvoiceError extends AppError {
  readonly affectedAppointmentIds: number[];
  constructor(affectedAppointmentIds: number[]) {
    super(
      409,
      "ISSUED_INVOICE",
      `Für ${affectedAppointmentIds.length} dieser Termine wurde bereits eine Rechnung gestellt. Eine direkte Umbuchung ist nicht möglich — bitte stornieren Sie die betroffene Rechnung und stellen Sie sie neu aus.`,
      "ISSUED_INVOICE",
    );
    this.name = "RebookIssuedInvoiceError";
    this.affectedAppointmentIds = affectedAppointmentIds;
  }
}

/**
 * Blocker-Status einer geplanten Umbuchung — die REINE Ableitung (wirft nicht).
 * Sowohl der ausführende Pfad (`assertRebookAllowed`) als auch die Vorschau
 * lesen ihren Zustand hieraus — keine zweite, parallele Prüfung.
 */
export interface RebookBlockerStatus {
  /** Monat für den/die verantwortliche:n Mitarbeiter:in abgeschlossen (nur relevant für Nicht-Superadmins). */
  monthClosed: boolean;
  monthClosedAppointmentIds: number[];
  /** Verbrauch hängt an einer aktiven, gestellten (nicht-Entwurf, nicht-stornierten) Rechnung. */
  issuedInvoice: boolean;
  issuedInvoiceAppointmentIds: number[];
}

/**
 * SSoT für „welche Blocker greifen für diese Umbuchung?". Ermittelt BEIDE
 * Blocker-Status (Monatsabschluss + bereits gestellte Rechnung) für die
 * gegebenen Termine, ohne zu werfen. `null`/`undefined`-IDs werden ignoriert.
 *
 * Der Superadmin-Bypass des Monatsabschlusses wird abgebildet: für einen
 * Superadmin ist `monthClosed` immer `false` (leere Liste) — exakt wie im
 * ausführenden Pfad. Der „bereits abgerechnet"-Block gilt rollenunabhängig.
 */
export async function evaluateRebookBlockers(
  appointmentIds: Array<number | null | undefined>,
  actor: RebookActor,
  txClient: DbOrTx = db,
): Promise<RebookBlockerStatus> {
  const ids = Array.from(
    new Set(appointmentIds.filter((id): id is number => id != null)),
  );
  const empty: RebookBlockerStatus = {
    monthClosed: false,
    monthClosedAppointmentIds: [],
    issuedInvoice: false,
    issuedInvoiceAppointmentIds: [],
  };
  if (ids.length === 0) return empty;

  // (1) Monatsabschluss — Superadmin umgeht ihn, daher gar nicht erst prüfen.
  const monthClosedAppointmentIds: number[] = [];
  if (!actor.isSuperAdmin) {
    const rows = await appointmentsRepo
      .selectColumnsFrom({
        id: appointments.id,
        date: appointments.date,
        responsibleEmployeeId: sql<number | null>`COALESCE(${appointments.performedByEmployeeId}, ${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`,
      }, txClient)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(inArray(appointments.id, ids));

    const closedCache = new Map<string, boolean>();
    for (const row of rows) {
      if (row.responsibleEmployeeId == null) continue;
      const dateStr = typeof row.date === "string" ? row.date : String(row.date);
      const key = `${row.responsibleEmployeeId}:${dateStr.slice(0, 7)}`;
      let closed = closedCache.get(key);
      if (closed === undefined) {
        closed = await isMonthClosed(row.responsibleEmployeeId, dateStr);
        closedCache.set(key, closed);
      }
      if (closed) monthClosedAppointmentIds.push(row.id);
    }
  }

  // (2) Bereits GESTELLTE Rechnung = aktive Rechnung (SSoT
  //     `activeInvoiceCondition`, server/lib/appointment-invoiced.ts) UND
  //     kein Entwurf. Der Entwurfs-Ausschluss ist der Zusatz-Scope DIESES
  //     Guards und steht deshalb hier sichtbar daneben — Entwürfe zählen
  //     überall sonst als abgerechnet, für die Umbuchung aber nicht.
  const issuedRows = await txClient
    .select({ appointmentId: invoiceLineItems.appointmentId })
    .from(invoiceLineItems)
    .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
    .where(
      and(
        inArray(invoiceLineItems.appointmentId, ids),
        activeInvoiceCondition(),
        ne(invoicesTable.status, "entwurf"),
      ),
    );
  const issuedInvoiceAppointmentIds = Array.from(
    new Set(
      issuedRows
        .map((r) => r.appointmentId)
        .filter((id): id is number => id != null),
    ),
  );

  return {
    monthClosed: monthClosedAppointmentIds.length > 0,
    monthClosedAppointmentIds,
    issuedInvoice: issuedInvoiceAppointmentIds.length > 0,
    issuedInvoiceAppointmentIds,
  };
}

/**
 * Wirft, wenn die Umbuchung der Verbrauchsbuchungen zu `appointmentIds` durch
 * einen der beiden Guards blockiert ist. `null`/`undefined`-IDs (z. B.
 * manuelle Anpassungen ohne Termin) werden ignoriert.
 *
 * Liest den Blocker-Status aus der gemeinsamen `evaluateRebookBlockers`-SSoT —
 * dieselbe Ableitung, die auch die Vorschau nutzt.
 *
 * @param appointmentIds Termine, deren Verbrauch umgebucht werden soll.
 * @param actor          Akteur (für den Superadmin-Bypass des Monatsabschlusses).
 * @param txClient       Optionaler Tx-/DB-Client (Guard läuft im selben Snapshot
 *                       wie die nachfolgende Mutation).
 * @param options        `allowIssuedInvoices` nur für den Storno-zuerst-Ablauf.
 */
export async function assertRebookAllowed(
  appointmentIds: Array<number | null | undefined>,
  actor: RebookActor,
  txClient: DbOrTx = db,
  options: RebookGuardOptions = {},
): Promise<void> {
  const status = await evaluateRebookBlockers(appointmentIds, actor, txClient);

  // (1) Monatsabschluss — nur Superadmin darf über einen abgeschlossenen Monat.
  if (status.monthClosed) {
    throw new RebookMonthClosedError(status.monthClosedAppointmentIds);
  }

  // (2) Bereits gestellte (nicht-Entwurf, nicht-stornierte) Rechnung.
  if (!options.allowIssuedInvoices && status.issuedInvoice) {
    throw new RebookIssuedInvoiceError(status.issuedInvoiceAppointmentIds);
  }
}
