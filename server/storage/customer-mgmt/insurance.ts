import {
  type InsuranceProvider,
  type InsertInsuranceProvider,
  type CustomerInsuranceHistory,
  type InsertCustomerInsurance,
  insuranceProviders,
  customerInsuranceHistory,
  customerBudgetRecipients,
} from "@shared/schema";
import { eq, and, isNull, desc, count, notExists, sql } from "drizzle-orm";
import { todayISO } from "@shared/utils/datetime";
import { db, type DbOrTx } from "../../lib/db";

const insuranceHistoryWithProviderSelect = {
  id: customerInsuranceHistory.id,
  customerId: customerInsuranceHistory.customerId,
  insuranceProviderId: customerInsuranceHistory.insuranceProviderId,
  versichertennummer: customerInsuranceHistory.versichertennummer,
  validFrom: customerInsuranceHistory.validFrom,
  validTo: customerInsuranceHistory.validTo,
  notes: customerInsuranceHistory.notes,
  createdAt: customerInsuranceHistory.createdAt,
  createdByUserId: customerInsuranceHistory.createdByUserId,
  provider: {
    id: insuranceProviders.id,
    name: insuranceProviders.name,
    ikNummer: insuranceProviders.ikNummer,
    isPrivate: insuranceProviders.isPrivate,
    strasse: insuranceProviders.strasse,
    hausnummer: insuranceProviders.hausnummer,
    plz: insuranceProviders.plz,
    stadt: insuranceProviders.stadt,
    telefon: insuranceProviders.telefon,
    email: insuranceProviders.email,
    fax: insuranceProviders.fax,
    kimAdresse: insuranceProviders.kimAdresse,
    ansprechpartner: insuranceProviders.ansprechpartner,
    datenannahmeIk: insuranceProviders.datenannahmeIk,
    empfaenger: insuranceProviders.empfaenger,
    empfaengerZeile2: insuranceProviders.empfaengerZeile2,
    emailInvoiceEnabled: insuranceProviders.emailInvoiceEnabled,
    emailVerhinderungspflege: insuranceProviders.emailVerhinderungspflege,
    zahlungsbedingungen: insuranceProviders.zahlungsbedingungen,
    zahlungsart: insuranceProviders.zahlungsart,
    isActive: insuranceProviders.isActive,
    anschrift: insuranceProviders.anschrift,
    plzOrt: insuranceProviders.plzOrt,
    createdAt: insuranceProviders.createdAt,
  },
};

export type InsuranceProviderWithUsage = InsuranceProvider & { isUsed: boolean };

// Liefert alle (bzw. nur aktive) Pflegekassen inkl. abgeleitetem `isUsed`-Flag.
// `isUsed` ist die Negation der einen SSoT `isUnusedInsuranceProvider()` und
// versorgt die Admin-Verwaltung (Badge "Unbenutzt" + Lösch-Gate). Die
// Auswahl-Picker ignorieren das Feld einfach.
export async function getInsuranceProviders(activeOnly = true): Promise<InsuranceProviderWithUsage[]> {
  const rows = await db
    .select({
      row: insuranceProviders,
      isUsed: sql<boolean>`NOT (${isUnusedInsuranceProvider()!})`,
    })
    .from(insuranceProviders)
    .where(activeOnly ? eq(insuranceProviders.isActive, true) : undefined);
  return rows.map((r) => ({ ...r.row, isUsed: Boolean(r.isUsed) }));
}

export async function getInsuranceProvider(id: number): Promise<InsuranceProvider | undefined> {
  const result = await db.select().from(insuranceProviders).where(eq(insuranceProviders.id, id));
  return result[0];
}

export async function getInsuranceProviderByIK(ikNummer: string): Promise<InsuranceProvider | undefined> {
  const result = await db.select().from(insuranceProviders).where(eq(insuranceProviders.ikNummer, ikNummer));
  return result[0];
}

export async function createInsuranceProvider(data: InsertInsuranceProvider): Promise<InsuranceProvider> {
  const result = await db.insert(insuranceProviders).values(data).returning();
  return result[0];
}

export async function updateInsuranceProvider(id: number, data: Partial<InsertInsuranceProvider>): Promise<InsuranceProvider | undefined> {
  const result = await db.update(insuranceProviders).set(data).where(eq(insuranceProviders.id, id)).returning();
  return result[0];
}

export async function getActiveCustomerCountForProvider(providerId: number): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(customerInsuranceHistory)
    .where(and(
      eq(customerInsuranceHistory.insuranceProviderId, providerId),
      isNull(customerInsuranceHistory.validTo)
    ));
  return Number(result[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Unused-Pflegekassen-Cleanup (Task #1000): Eine Pflegekasse gilt als "unbenutzt",
// wenn sie WEDER in customer_insurance_history (aktuell oder historisch) noch über
// customer_budget_recipients (Rechnungs-Empfänger-Override, der den Abrechnungs-/
// Rechnungslauf an die Kasse bindet) referenziert wird. Die Tabelle `invoices`
// hält nur einen denormalisierten `insurance_provider_name` (Text, keine ID),
// die ID-Referenz für Rechnungen läuft über customer_budget_recipients.
// Solche unbenutzten Zeilen stammen aus dem EDIFACT-Massenimport / PKV-Seed und
// blähen nur die Auswahl auf. Referenzierte Zeilen bleiben IMMER erhalten (GoBD;
// es gibt kein ON DELETE CASCADE auf insurance_providers, ein Löschen würde
// ohnehin am FK scheitern).
// ---------------------------------------------------------------------------
export const isUnusedInsuranceProvider = () =>
  and(
    notExists(
      db
        .select({ one: sql`1` })
        .from(customerInsuranceHistory)
        .where(eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id)),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(customerBudgetRecipients)
        .where(eq(customerBudgetRecipients.insuranceProviderId, insuranceProviders.id)),
    ),
  );

export interface UnusedInsuranceProviderStats {
  total: number;
  private: number;
  statutory: number;
}

export async function getUnusedInsuranceProviderStats(): Promise<UnusedInsuranceProviderStats> {
  const rows = await db
    .select({ isPrivate: insuranceProviders.isPrivate })
    .from(insuranceProviders)
    .where(isUnusedInsuranceProvider());
  const total = rows.length;
  const priv = rows.filter((r) => r.isPrivate).length;
  return { total, private: priv, statutory: total - priv };
}

/**
 * Löscht die aktuell unbenutzten Pflegekassen über den bereitgestellten
 * Executor (db ODER tx). Das DELETE matched NUR Zeilen, die zum Lösch-Zeitpunkt
 * unreferenziert sind. Beim Aufruf mit einer Transaktion (z. B. der einmalige
 * Prod-Startup-Cleanup) wird Auswertung+Löschung Teil der umschließenden
 * Transaktion — es wird KEINE eigene/innere Transaktion geöffnet.
 */
export async function deleteUnusedInsuranceProvidersWithin(
  exec: DbOrTx,
): Promise<UnusedInsuranceProviderStats & { deletedIds: number[] }> {
  const deleted = await exec
    .delete(insuranceProviders)
    .where(isUnusedInsuranceProvider())
    .returning({ id: insuranceProviders.id, isPrivate: insuranceProviders.isPrivate });
  const deletedIds = deleted.map((r) => r.id);
  const priv = deleted.filter((r) => r.isPrivate).length;
  return {
    total: deleted.length,
    private: priv,
    statutory: deleted.length - priv,
    deletedIds,
  };
}

export async function deleteUnusedInsuranceProviders(): Promise<UnusedInsuranceProviderStats & { deletedIds: number[] }> {
  // Innerhalb EINER Transaktion neu auswerten und löschen: das DELETE matched nur
  // Zeilen, die zum Lösch-Zeitpunkt unreferenziert sind (Schutz gegen Race-
  // Conditions mit gleichzeitigen Zuweisungen/Rechnungen).
  return await db.transaction((tx) => deleteUnusedInsuranceProvidersWithin(tx));
}

export type DeleteInsuranceProviderResult =
  | { status: "deleted"; provider: InsuranceProvider }
  | { status: "not_found" }
  | { status: "in_use" };

/**
 * Löscht EINE Pflegekasse per ID — aber NUR, wenn sie zum Lösch-Zeitpunkt
 * unbenutzt ist (gleiche SSoT `isUnusedInsuranceProvider()` wie der Bulk-
 * Cleanup). Die Auswertung+Löschung läuft in EINER Transaktion (Race-Schutz):
 * Das DELETE matched die Zeile nur, solange keine Zuweisung/Rechnung existiert.
 */
export async function deleteInsuranceProviderIfUnused(id: number): Promise<DeleteInsuranceProviderResult> {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(insuranceProviders)
      .where(eq(insuranceProviders.id, id));
    if (!existing) return { status: "not_found" };

    const deleted = await tx
      .delete(insuranceProviders)
      .where(and(eq(insuranceProviders.id, id), isUnusedInsuranceProvider()))
      .returning();
    if (deleted.length === 0) return { status: "in_use" };

    return { status: "deleted", provider: deleted[0] };
  });
}

export async function getCustomerCurrentInsurance(customerId: number): Promise<(CustomerInsuranceHistory & { provider: InsuranceProvider }) | undefined> {
  const result = await db
    .select(insuranceHistoryWithProviderSelect)
    .from(customerInsuranceHistory)
    .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
    .where(and(
      eq(customerInsuranceHistory.customerId, customerId),
      isNull(customerInsuranceHistory.validTo)
    ))
    .limit(1);
  
  if (result.length === 0) return undefined;
  return { ...result[0], provider: result[0].provider };
}

export async function getCustomerInsuranceHistory(customerId: number): Promise<(CustomerInsuranceHistory & { provider: InsuranceProvider })[]> {
  const result = await db
    .select(insuranceHistoryWithProviderSelect)
    .from(customerInsuranceHistory)
    .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
    .where(eq(customerInsuranceHistory.customerId, customerId))
    .orderBy(desc(customerInsuranceHistory.validFrom));
  
  return result.map(r => ({ ...r, provider: r.provider }));
}

export async function addCustomerInsurance(data: InsertCustomerInsurance, userId?: number, tx?: DbOrTx): Promise<CustomerInsuranceHistory> {
  const executor = tx ?? db;
  const today = todayISO();

  await executor
    .update(customerInsuranceHistory)
    .set({ validTo: today })
    .where(and(
      eq(customerInsuranceHistory.customerId, data.customerId),
      isNull(customerInsuranceHistory.validTo)
    ));

  const result = await executor.insert(customerInsuranceHistory).values({
    ...data,
    createdByUserId: userId,
  }).returning();

  return result[0];
}
