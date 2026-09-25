import {
  type CustomerCareLevelHistory,
  type InsertCareLevelHistory,
  type CustomerNeedsAssessment,
  type InsertNeedsAssessment,
  customerCareLevelHistory,
  customerNeedsAssessments,
  customers,
} from "@shared/schema";
import { eq, and, isNull, desc, asc, lte, gte, or } from "drizzle-orm";
import { parseLocalDate, formatDateISO, todayISO, addDays } from "@shared/utils/datetime";
import { db, type DbOrTx } from "../../lib/db";
import { badRequest, notFound } from "../../lib/errors";
import { vorgaengerZumWiederaufleben } from "@shared/domain/pflegegrad-historie";

/**
 * Nur Einträge, die NICHT als Fehleintrag entfernt sind (Ticket
 * 6hcgffPJWm57p72p). Jeder Leser, der eine Aussage über den Pflegegrad trifft
 * (Stichtag, Anker, aktueller Eintrag), filtert hierüber — ein entfernter
 * Eintrag zählt für kein Datum. Nur die Verlaufs-Anzeige
 * (`getCustomerCareLevelHistory`) liefert ihn mit Markierung aus.
 */
export function nichtEntfernt() {
  return isNull(customerCareLevelHistory.entferntAm);
}

export async function getCustomerCareLevelHistory(customerId: number): Promise<CustomerCareLevelHistory[]> {
  return await db
    .select()
    .from(customerCareLevelHistory)
    .where(eq(customerCareLevelHistory.customerId, customerId))
    .orderBy(desc(customerCareLevelHistory.validFrom));
}

/**
 * Task #856/#1214 — Frühester Pflegegrad-Beginn des Kunden aus der
 * historisierten Pflegegrad-Historie (`customer_care_level_history`). SSoT für
 * den §45b/§45a/§39-Auto-Allokations-Anker (Runtime, kein persistiertes
 * Start-Datum). Dient als Anker, wenn (noch) keine bestehenden Allokationen
 * vorliegen — so profitieren auch Bestandskunden ohne gespeichertes Startdatum
 * vom Pflegegrad-Anker. Rückgabe `null`, wenn keine Pflegegrad-Historie
 * existiert. `executor` erlaubt das Lesen innerhalb einer Transaktion.
 */
export async function getEarliestCareLevelStart(
  customerId: number,
  executor: Pick<typeof db, "select"> = db,
): Promise<string | null> {
  const rows = await executor
    .select({ validFrom: customerCareLevelHistory.validFrom })
    .from(customerCareLevelHistory)
    .where(and(eq(customerCareLevelHistory.customerId, customerId), nichtEntfernt()))
    .orderBy(asc(customerCareLevelHistory.validFrom))
    .limit(1);
  return rows[0]?.validFrom ?? null;
}

/**
 * Pflegegrad ZUM STICHTAG — SSoT fuer jede Aussage, die sich auf ein Datum
 * bezieht.
 *
 * ── Warum das gebraucht wird (Replit #1916, Gate 2) ────────────────────
 * `customers.pflegegrad` traegt den AKTUELLEN Grad. Wer damit eine Aussage
 * ueber einen Termin im naechsten Monat trifft, liest „heute" statt „as-of" —
 * die Falle, vor der CLAUDE.md warnt und die in diesem Repo bereits dreimal
 * aufgetreten ist.
 *
 * Konkret: Alriks Satz „Kein Ausweichbudget verfuegbar." haengt an Pflegegrad
 * 1. Wird der Kunde zum 01.10. hochgestuft und ein Oktober-Termin angelegt,
 * stuende der Satz falsch da — **und er ist ausdruecklich keine
 * Fehlermeldung, sondern eine Aussage ueber Leistungsansprueche**, die eine
 * Mitarbeiterin gegenueber dem Kunden vertritt.
 *
 * `null`, wenn zum Stichtag keine Historienzeile gilt. Der Aufrufer
 * entscheidet, was das heisst — hier wird NICHT still auf den aktuellen Grad
 * zurueckgefallen.
 */
export async function getCareLevelAt(
  customerId: number,
  asOfDate: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<number | null> {
  const rows = await executor
    .select({ pflegegrad: customerCareLevelHistory.pflegegrad })
    .from(customerCareLevelHistory)
    .where(and(
      eq(customerCareLevelHistory.customerId, customerId),
      nichtEntfernt(),
      lte(customerCareLevelHistory.validFrom, asOfDate),
      or(
        isNull(customerCareLevelHistory.validTo),
        gte(customerCareLevelHistory.validTo, asOfDate),
      ),
    ))
    // Bei ueberlappenden Zeilen gewinnt die spaetere — dieselbe Wahl wie
    // `getCustomerCurrentCareLevel` (dort `desc(validFrom)`).
    .orderBy(desc(customerCareLevelHistory.validFrom))
    .limit(1);
  return rows[0]?.pflegegrad ?? null;
}

export async function getCustomerCurrentCareLevel(customerId: number): Promise<CustomerCareLevelHistory | undefined> {
  const result = await db
    .select()
    .from(customerCareLevelHistory)
    .where(and(
      eq(customerCareLevelHistory.customerId, customerId),
      nichtEntfernt(),
      isNull(customerCareLevelHistory.validTo)
    ))
    .limit(1);
  return result[0];
}

export async function addCareLevelHistory(data: InsertCareLevelHistory, userId?: number, tx?: DbOrTx): Promise<CustomerCareLevelHistory> {
  const executor = tx ?? db;
  // K2: validFrom kommt als YYYY-MM-DD-String — parseLocalDate hält die
  // lokale TZ. dayBeforeDate ist eine Kopie des resultierenden Date-Objekts
  // (kein erneutes String-Parsing!), daher ist `new Date(validFromDate)` hier
  // bewusst korrekt — wir klonen ein Date, kein Parsing eines Strings.
  const validFromDate = parseLocalDate(data.validFrom);
  const dayBeforeDate = new Date(validFromDate.getTime());
  dayBeforeDate.setDate(dayBeforeDate.getDate() - 1);
  const dayBeforeValidFrom = formatDateISO(dayBeforeDate);

  const currentEntries = await executor
    .select()
    .from(customerCareLevelHistory)
    .where(and(
      eq(customerCareLevelHistory.customerId, data.customerId),
      nichtEntfernt(),
      isNull(customerCareLevelHistory.validTo)
    ));

  for (const entry of currentEntries) {
    const entryFrom = parseLocalDate(entry.validFrom);
    if (entryFrom >= validFromDate) {
      await executor
        .update(customerCareLevelHistory)
        .set({ validTo: data.validFrom })
        .where(eq(customerCareLevelHistory.id, entry.id));
    } else {
      await executor
        .update(customerCareLevelHistory)
        .set({ validTo: dayBeforeValidFrom })
        .where(eq(customerCareLevelHistory.id, entry.id));
    }
  }

  const result = await executor.insert(customerCareLevelHistory).values({
    ...data,
    createdByUserId: userId,
  }).returning();

  await executor
    .update(customers)
    .set({ pflegegrad: data.pflegegrad, updatedAt: new Date() })
    .where(eq(customers.id, data.customerId));

  return result[0];
}

/**
 * Stammdaten `customers.pflegegrad` aus der Historie nachziehen: der Grad, der
 * HEUTE gilt, sonst NULL. „Heute" ist hier richtig — die Spalte ist per
 * Definition der aktuelle Grad; jede Aussage zu einem Datum liest die
 * Historie (`getCareLevelAt`).
 */
async function stammdatenNachziehen(customerId: number, executor: DbOrTx): Promise<number | null> {
  const heute = await getCareLevelAt(customerId, todayISO(), executor);
  await executor
    .update(customers)
    .set({ pflegegrad: heute, updatedAt: new Date() })
    .where(eq(customers.id, customerId));
  return heute;
}

/**
 * „Als Fehleintrag entfernen" (Entscheidung Alrik, 25.09.2026): der Eintrag war
 * NIE richtig. Er wird markiert (nicht gelöscht; Grund Pflicht, Audit beim
 * Aufrufer) und zählt danach für kein Datum mehr — auch rückwirkend. Die
 * Stammdaten werden im selben Zug auf den heute geltenden Grad gesetzt, ohne
 * weiteren Eintrag also auf „kein Pflegegrad".
 */
export async function pflegegradAlsFehleintragEntfernen(
  params: { customerId: number; historyId: number; grund: string; userId: number; vorigenWiederOeffnen?: boolean },
  executor: DbOrTx,
): Promise<{ eintrag: CustomerCareLevelHistory; pflegegradHeute: number | null; wiederGeoeffnet: CustomerCareLevelHistory | null }> {
  const [eintrag] = await executor
    .select()
    .from(customerCareLevelHistory)
    .where(and(
      eq(customerCareLevelHistory.id, params.historyId),
      eq(customerCareLevelHistory.customerId, params.customerId),
    ))
    .for("update");
  if (!eintrag) throw notFound("Pflegegrad-Eintrag nicht gefunden");
  if (eintrag.entferntAm != null) throw badRequest("Dieser Pflegegrad-Eintrag ist bereits als Fehleintrag entfernt.");
  // Kandidat VOR dem Markieren bestimmen — auf der gesperrten Historie des
  // Kunden, mit derselben Funktion, die der Dialog im Client zeigt.
  let wiederGeoeffnet: CustomerCareLevelHistory | null = null;
  if (params.vorigenWiederOeffnen) {
    const historie = await executor
      .select()
      .from(customerCareLevelHistory)
      .where(eq(customerCareLevelHistory.customerId, params.customerId))
      .for("update");
    const kandidat = vorgaengerZumWiederaufleben(historie, eintrag.id);
    if (!kandidat) {
      throw badRequest("Es gibt keinen vorigen Pflegegrad, der direkt vor diesem Eintrag endet — nichts wieder zu öffnen.");
    }
    [wiederGeoeffnet] = await executor
      .update(customerCareLevelHistory)
      .set({ validTo: kandidat.neuesEnde })
      .where(eq(customerCareLevelHistory.id, kandidat.eintrag.id))
      .returning();
  }
  const [markiert] = await executor
    .update(customerCareLevelHistory)
    .set({ entferntAm: new Date(), entferntGrund: params.grund, entferntVonUserId: params.userId })
    .where(eq(customerCareLevelHistory.id, eintrag.id))
    .returning();
  const pflegegradHeute = await stammdatenNachziehen(params.customerId, executor);
  return { eintrag: markiert, pflegegradHeute, wiederGeoeffnet };
}

/**
 * „Ab Datum beenden" für echte Enden (Entscheidung Alrik, 25.09.2026): ab
 * `abDatum` gilt kein Pflegegrad mehr; der laufende Eintrag endet am Vortag.
 * Beginnt der laufende Eintrag erst am oder nach `abDatum`, gäbe es keinen
 * gültigen Tag — das ist kein Ende, sondern ein Irrtum: dann „als Fehleintrag
 * entfernen". Stammdaten wie oben.
 */
export async function pflegegradBeenden(
  params: { customerId: number; abDatum: string },
  executor: DbOrTx,
): Promise<{ eintrag: CustomerCareLevelHistory; pflegegradHeute: number | null }> {
  const offene = await executor
    .select()
    .from(customerCareLevelHistory)
    .where(and(
      eq(customerCareLevelHistory.customerId, params.customerId),
      nichtEntfernt(),
      isNull(customerCareLevelHistory.validTo),
    ))
    .for("update");
  if (offene.length === 0) throw badRequest("Es gibt keinen laufenden Pflegegrad, der beendet werden könnte.");
  if (offene.length > 1) {
    throw badRequest("Es gibt mehrere laufende Pflegegrad-Einträge. Bitte zuerst den falschen als Fehleintrag entfernen.");
  }
  const [offen] = offene;
  if (offen.validFrom >= params.abDatum) {
    throw badRequest(
      "Der laufende Pflegegrad beginnt erst am oder nach diesem Datum — es gäbe keinen gültigen Tag. " +
      "War der Eintrag ein Irrtum, bitte „als Fehleintrag entfernen“.",
    );
  }
  const [beendet] = await executor
    .update(customerCareLevelHistory)
    .set({ validTo: addDays(params.abDatum, -1) })
    .where(eq(customerCareLevelHistory.id, offen.id))
    .returning();
  const pflegegradHeute = await stammdatenNachziehen(params.customerId, executor);
  return { eintrag: beendet, pflegegradHeute };
}

export async function getCustomerNeedsAssessment(customerId: number, tx?: DbOrTx): Promise<CustomerNeedsAssessment | undefined> {
  const executor = tx ?? db;
  const result = await executor
    .select()
    .from(customerNeedsAssessments)
    .where(eq(customerNeedsAssessments.customerId, customerId))
    .orderBy(desc(customerNeedsAssessments.assessmentDate))
    .limit(1);
  return result[0];
}

export async function createNeedsAssessment(data: InsertNeedsAssessment, userId?: number): Promise<CustomerNeedsAssessment> {
  const result = await db.insert(customerNeedsAssessments).values({
    ...data,
    createdByUserId: userId,
  }).returning();
  return result[0];
}

export async function updateNeedsAssessment(customerId: number, data: Partial<{
  serviceHaushaltHilfe: boolean;
  serviceMahlzeiten: boolean;
  serviceReinigung: boolean;
  serviceWaeschePflege: boolean;
  serviceEinkauf: boolean;
  serviceTagesablauf: boolean;
  serviceAlltagsverrichtungen: boolean;
  serviceTerminbegleitung: boolean;
  serviceBotengaenge: boolean;
  serviceGrundpflege: boolean;
  serviceFreizeitbegleitung: boolean;
  serviceDemenzbetreuung: boolean;
  serviceGesellschaft: boolean;
  serviceSozialeKontakte: boolean;
  serviceFreizeitgestaltung: boolean;
  serviceKreativ: boolean;
  sonstigeLeistungen: string | null;
}>, tx?: DbOrTx): Promise<CustomerNeedsAssessment | undefined> {
  const executor = tx ?? db;
  const existing = await getCustomerNeedsAssessment(customerId, tx);
  if (!existing) return undefined;

  const result = await executor.update(customerNeedsAssessments)
    .set(data)
    .where(eq(customerNeedsAssessments.id, existing.id))
    .returning();
  return result[0];
}
