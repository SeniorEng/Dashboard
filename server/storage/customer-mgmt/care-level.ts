import {
  type CustomerCareLevelHistory,
  type InsertCareLevelHistory,
  type CustomerNeedsAssessment,
  type InsertNeedsAssessment,
  customerCareLevelHistory,
  customerNeedsAssessments,
  customers,
} from "@shared/schema";
import { eq, and, isNull, desc, asc } from "drizzle-orm";
import { parseLocalDate, formatDateISO } from "@shared/utils/datetime";
import { db, type DbOrTx } from "../../lib/db";

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
    .where(eq(customerCareLevelHistory.customerId, customerId))
    .orderBy(asc(customerCareLevelHistory.validFrom))
    .limit(1);
  return rows[0]?.validFrom ?? null;
}

export async function getCustomerCurrentCareLevel(customerId: number): Promise<CustomerCareLevelHistory | undefined> {
  const result = await db
    .select()
    .from(customerCareLevelHistory)
    .where(and(
      eq(customerCareLevelHistory.customerId, customerId),
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
