import { inArray } from "drizzle-orm";
import { db } from "../lib/db";
import { customers as customersTable } from "@shared/schema";
import { AppError } from "../lib/errors";
import { log } from "../lib/log";
import {
  getClusterAmountAppointmentsByCustomer,
  getUnbilledSignedAppointmentFactsByCustomer,
  buildLineItemsFromAppointments,
} from "./invoice-data";
import { buildInvoiceDraft, computeDocumentedGrossCents } from "./invoice-calc";

/**
 * **IST- und PLAN-Betrag je Kunde** (Task #1905) — herausgelöst aus
 * `GET /billing/eligible-customers`.
 *
 * ── Warum getrennt ──────────────────────────────────────────────────────
 * Die Berechnung ruft `buildInvoiceDraft` PRO KUNDE — die vollständige
 * Rechnungsberechnung, mit rund 15–25 DB-Runden je Kunde. Sie hing bisher am
 * Listen-Endpunkt und lief damit bei JEDEM Öffnen des Abrechnungs-Tabs für
 * ALLE Kunden des Monats, bevor die Liste überhaupt erschien.
 *
 * Gemessen (Gate-1 zu 6hJRF6h8): die Pipeline-Aggregation daneben braucht bei
 * ~1.300 Monatsterminen 45 ms und ist nicht das Problem. Die N Drafts sind es:
 * bei 111 Kunden sind das grob 2.000 Runden, gegen eine netzgebundene DB also
 * Sekunden bis Minuten — und sie blockierten die Liste, die selbst
 * mengenbasiert und billig ist.
 *
 * Jetzt lädt sie der Client, wenn eine Gruppe geöffnet wird (Variante B): ein
 * Batch-Aufruf je Gruppe statt N Einzelrufe, und der erste Load der Liste ist
 * unabhängig von der Kundenzahl.
 *
 * ── Was hier NICHT anders ist ───────────────────────────────────────────
 * Die Rechenwege sind unverändert übernommen: IST aus `buildInvoiceDraft`
 * (dieselbe SSoT wie `/billing/preview` und die echte Erstellung) plus dem
 * REST über denselben Zeilen-Bauer; PLAN konservativ ohne spekulativen
 * Privat-Aufschlag. Ein `null` heißt weiterhin „nicht berechenbar" und wird
 * nicht zu 0 geglättet — eine 0 in einer Geld-Spalte liest sich wie „nichts
 * offen" und wäre eine stille Falschaussage.
 */

export interface CustomerAmounts {
  /** Dokumentierte, noch nicht abgerechnete Arbeit. `null` = nicht berechenbar. */
  actualAmountCents: number | null;
  /** Offene, noch nicht geleistete Termine — PROGNOSE, reine Anzeige (GoBD). */
  plannedAmountCents: number | null;
}

/**
 * Begrenzt parallel, damit ein Batch den DB-Pool (`max: 20`) nicht leerräumt.
 * Unverändert aus dem Listen-Endpunkt übernommen.
 */
const AMOUNT_CONCURRENCY = 8;

export async function computeCustomerAmounts(
  customerIds: number[],
  opts: { year: number; month: number; dateFrom?: string; dateTo?: string },
): Promise<Map<number, CustomerAmounts>> {
  const ergebnis = new Map<number, CustomerAmounts>();
  if (customerIds.length === 0) return ergebnis;

  const { year, month, dateFrom, dateTo } = opts;

  // Die vier Eingaben, die der Listen-Endpunkt vorher schon berechnet hatte.
  // Sie sind alle aus der ID-Menge ableitbar — deshalb ist diese Funktion
  // eigenständig aufrufbar und braucht keinen Kontext von dort.
  const [clusterAppts, unbilledFacts, kundenZeilen] = await Promise.all([
    getClusterAmountAppointmentsByCustomer(customerIds, year, month, { dateFrom, dateTo }),
    getUnbilledSignedAppointmentFactsByCustomer(customerIds, year, month),
    db
      .select({
        id: customersTable.id,
        billingType: customersTable.billingType,
        acceptsPrivatePayment: customersTable.acceptsPrivatePayment,
      })
      .from(customersTable)
      .where(inArray(customersTable.id, customerIds)),
  ]);

  const billingTypeById = new Map(kundenZeilen.map((c) => [c.id, c.billingType]));
  const acceptsPrivateById = new Map(
    kundenZeilen.map((c) => [c.id, c.acceptsPrivatePayment ?? false]),
  );

  for (let i = 0; i < customerIds.length; i += AMOUNT_CONCURRENCY) {
    const chunk = customerIds.slice(i, i + AMOUNT_CONCURRENCY);
    await Promise.all(
      chunk.map(async (id) => {
        // Ein aufgelöster Zahler-Typ für BEIDE Betrags-Pfade — vorher nutzte der
        // IST-Pfad `?? "selbstzahler"` (nullish) und der PLAN-Pfad den rohen
        // Wert, `buildInvoiceDraft` wiederum `|| "selbstzahler"` (falsy). Heute
        // folgenlos, bei einem leeren String wären die Pfade auseinandergelaufen.
        const billingType = billingTypeById.get(id) || "selbstzahler";
        const sets = clusterAppts.get(id);

        // Ein fachlicher Fehler (400) beim Rechnen eines EINZELNEN Kunden macht
        // dessen Betrag „nicht berechenbar" — er darf nicht den ganzen Batch
        // leeren. Technische Fehler (DB, Programmierfehler) fliegen weiter: sie
        // sind eine Störung und sollen als solche auffallen, statt sich als
        // Katalog-Problem zu tarnen.
        const billableOrNull = async <T>(compute: () => Promise<T>): Promise<T | null> => {
          try {
            return await compute();
          } catch (err) {
            if (err instanceof AppError && err.statusCode === 400) {
              log(
                `customer-amounts Betrag nicht berechenbar customer=${id} month=${month}/${year}: ${err.message}`,
                "billing",
              );
              return null;
            }
            throw err;
          }
        };

        let draftApptIds: number[] = [];
        let actualCents = 0;
        let draftFailed = false;
        if ((unbilledFacts.get(id)?.unbilledAppointmentCount ?? 0) > 0) {
          const draft = await billableOrNull(() =>
            buildInvoiceDraft({
              customerId: id,
              billingMonth: month,
              billingYear: year,
              dateFrom,
              dateTo,
              mode: "preview",
            }),
          );
          if (draft === null) {
            draftFailed = true;
          } else {
            draftApptIds = draft.apptIds;
            actualCents = draft.grossAmountCents;
          }
        }

        const draftSet = new Set(draftApptIds);
        const restIds = (sets?.documentedUnbilledIds ?? []).filter((a) => !draftSet.has(a));
        const openIds = sets?.openIds ?? [];

        const [restCents, plannedCents] = await Promise.all([
          draftFailed
            ? Promise.resolve(null)
            : billableOrNull(() =>
                computeDocumentedGrossCents({
                  customerId: id,
                  appointmentIds: restIds,
                  billingType,
                  acceptsPrivatePayment: acceptsPrivateById.get(id),
                }),
              ),
          openIds.length === 0
            ? Promise.resolve(0)
            : billableOrNull(() =>
                buildLineItemsFromAppointments(openIds, id, billingType).then(
                  (r) => r.totalNetCents + r.totalVatCents,
                ),
              ),
        ]);

        ergebnis.set(id, {
          actualAmountCents: draftFailed || restCents === null ? null : actualCents + restCents,
          plannedAmountCents: plannedCents,
        });
      }),
    );
  }

  return ergebnis;
}
