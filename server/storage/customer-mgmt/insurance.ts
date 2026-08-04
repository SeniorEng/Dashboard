import {
  type InsuranceProvider,
  type InsertInsuranceProvider,
  type CustomerInsuranceHistory,
  type InsertCustomerInsurance,
  insuranceProviders,
  customerInsuranceHistory,
  customerBudgetRecipients,
  customerContracts,
} from "@shared/schema";
import { eq, and, isNull, or, lte, gte, desc, count, notExists, sql } from "drizzle-orm";
import { todayISO } from "@shared/utils/datetime";
import {
  dayBeforeISO,
  firstInsuranceAnchorISO,
  isMonthStartISO,
  validateInsuranceWindow,
  validateInsuranceWindows,
  type InsuranceWindow,
} from "@shared/domain/insurance-period";
import { db, type DbOrTx } from "../../lib/db";
import { badRequest, notFound } from "../../lib/errors";

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

/**
 * Task #1893 — DER Stichtags-Resolver für die Kostenträger-Zuordnung.
 *
 * Liefert zu (Kunde × Stichtag) genau die Zuordnung, deren Gültigkeitsfenster
 * den Stichtag umschließt. ERSETZT das direkte `valid_to IS NULL`-Lesen in
 * allen Abrechnungs-/Versandpfaden (`getInsuranceData`, Kassen-Default in
 * `resolveBudgetRecipient`, `loadInsuranceForSend`) — dort ist „aktuell" das
 * falsche Kriterium, weil eine im Juli erstellte Juni-Rechnung den im Juni
 * gültigen Kostenträger adressieren muss.
 *
 * Prädikat: `validFrom <= asOf AND (validTo IS NULL OR validTo >= asOf)`
 * (beide Grenzen inklusiv). `orderBy(desc(validFrom))` ist die Sicherung gegen
 * historische Altdaten mit überlappenden Fenstern — bei sauberen Daten kann das
 * Prädikat ohnehin nur eine Zeile treffen (siehe `validateInsuranceWindows`).
 */
export async function resolveCustomerInsuranceAt(
  customerId: number,
  asOfISO: string,
  executor: DbOrTx = db,
): Promise<(CustomerInsuranceHistory & { provider: InsuranceProvider }) | undefined> {
  const result = await executor
    .select(insuranceHistoryWithProviderSelect)
    .from(customerInsuranceHistory)
    .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
    .where(and(
      eq(customerInsuranceHistory.customerId, customerId),
      lte(customerInsuranceHistory.validFrom, asOfISO),
      or(
        isNull(customerInsuranceHistory.validTo),
        gte(customerInsuranceHistory.validTo, asOfISO),
      ),
    ))
    .orderBy(desc(customerInsuranceHistory.validFrom))
    .limit(1);

  if (result.length === 0) return undefined;
  return { ...result[0], provider: result[0].provider };
}

/**
 * „Aktuelle Kasse" für STAMMDATEN-Ansichten (Kundenakte, Dokument-Platzhalter).
 * Bewusst `heute` als Stichtag — für Abrechnung/Versand ist das FALSCH, dort
 * gehört {@link resolveCustomerInsuranceAt} mit dem Periodenende hin.
 * Auf den Resolver zurückgeführt, damit es nur EIN Fenster-Prädikat gibt.
 */
export async function getCustomerCurrentInsurance(customerId: number): Promise<(CustomerInsuranceHistory & { provider: InsuranceProvider }) | undefined> {
  return resolveCustomerInsuranceAt(customerId, todayISO());
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

/** Alle Gültigkeitsfenster eines Kunden — Basis der Überlappungs-/Lückenprüfung. */
async function loadInsuranceWindows(
  customerId: number,
  executor: DbOrTx,
): Promise<(InsuranceWindow & { id: number })[]> {
  const rows = await executor
    .select({
      id: customerInsuranceHistory.id,
      validFrom: customerInsuranceHistory.validFrom,
      validTo: customerInsuranceHistory.validTo,
    })
    .from(customerInsuranceHistory)
    .where(eq(customerInsuranceHistory.customerId, customerId));
  return rows;
}

/**
 * Task #1893 — Kassenwechsel NUR zum Monatsersten.
 *
 * `validFrom` MUSS der 1. eines Monats sein; die Vorgängerzeile wird lückenlos
 * und überlappungsfrei am Tag DAVOR geschlossen (= letzter Tag des Vormonats).
 * ERSETZT das frühere `validTo = todayISO()`, das am Wechseltag zwei gleichzeitig
 * gültige Zeilen erzeugte (beide erfüllten das Stichtags-Prädikat, `.limit(1)`
 * entschied zufällig).
 *
 * @throws {AppError} 400 mit deutscher Meldung bei unzulässigem Fenster.
 */
export interface AddCustomerInsuranceOptions {
  /**
   * Vertragsbeginn, falls dem Aufrufer bekannt. Der Wizard MUSS ihn mitgeben:
   * dort wird die Versicherung VOR dem Vertrag geschrieben
   * (`customer-creation-helpers.ts`), der Nachschlag unten fände also nichts.
   */
  contractStartISO?: string | null;
}

/**
 * Erstzuordnung = der Kunde hat noch KEINE Zeile in `customer_insurance_history`.
 *
 * Eindeutig, weil die Tabelle keinen Soft-Delete kennt (kein `deleted_at`,
 * `shared/schema/insurance.ts`) und es im Server keinen Lösch-Pfad auf sie gibt
 * — geprüft. Eine „unsichtbare" Vorgängerzeile, die eine Erstzuordnung
 * vortäuschen könnte, kann es damit nicht geben. Bekäme die Tabelle je einen
 * Soft-Delete, MUSS diese Prüfung mitziehen, sonst normalisiert sie einen
 * echten Wechsel still.
 */
async function loadContractStartISO(
  customerId: number,
  executor: DbOrTx,
): Promise<string | null> {
  const rows = await executor
    .select({ contractStart: customerContracts.contractStart })
    .from(customerContracts)
    .where(eq(customerContracts.customerId, customerId))
    .orderBy(customerContracts.contractStart)
    .limit(1);
  return rows[0]?.contractStart ?? null;
}

export async function addCustomerInsurance(
  data: InsertCustomerInsurance,
  userId?: number,
  tx?: DbOrTx,
  options?: AddCustomerInsuranceOptions,
): Promise<CustomerInsuranceHistory> {
  const executor = tx ?? db;

  // Task #1898 — Erstzuordnung VOR jeder Mutation feststellen. Nach dem
  // Vorgänger-Update unten wäre die Menge nicht mehr aussagekräftig.
  const existingBefore = await loadInsuranceWindows(data.customerId, executor);
  const isFirstAssignment = existingBefore.length === 0;

  let validFrom = data.validFrom;
  if (isFirstAssignment && typeof validFrom === "string" && !isMonthStartISO(validFrom)) {
    const contractStart =
      options?.contractStartISO ?? (await loadContractStartISO(data.customerId, executor));
    validFrom = firstInsuranceAnchorISO(contractStart, todayISO());
  }
  // Jede WEITERE Zuordnung ist ein Wechsel und bleibt hart auf den
  // Monatsersten begrenzt — hier wird nichts umgeschrieben.

  const windowError = validateInsuranceWindow({ validFrom, validTo: data.validTo ?? null });
  if (windowError) throw badRequest(windowError);

  const closesAt = dayBeforeISO(validFrom);

  // Vorgänger lückenlos am Tag vor dem neuen `validFrom` schließen. Nur offene
  // Fenster, die VOR dem neuen Start begonnen haben — ein bereits geschlossenes
  // oder später beginnendes Fenster wird nie stillschweigend umgeschrieben.
  await executor
    .update(customerInsuranceHistory)
    .set({ validTo: closesAt })
    .where(and(
      eq(customerInsuranceHistory.customerId, data.customerId),
      isNull(customerInsuranceHistory.validTo),
      lte(customerInsuranceHistory.validFrom, closesAt),
    ));

  const existing = await loadInsuranceWindows(data.customerId, executor);
  const setError = validateInsuranceWindows([
    ...existing,
    { validFrom, validTo: data.validTo ?? null },
  ]);
  if (setError) throw badRequest(setError);

  // `validFrom` statt `data.validFrom`: die persistierte Zeile trägt das
  // normalisierte Datum — und damit auch das Audit, das die zurückgegebene
  // Zeile protokolliert (`routes/admin/customers/details.ts`).
  const result = await executor.insert(customerInsuranceHistory).values({
    ...data,
    validFrom,
    createdByUserId: userId,
  }).returning();

  return result[0];
}

export interface UpdateCustomerInsurancePatch {
  validFrom?: string;
  validTo?: string | null;
  versichertennummer?: string;
}

/**
 * Task #1893 — Korrektur einer BESTEHENDEN Zuordnung (Gültig-ab/-bis/
 * Versichertennummer). Validiert die resultierende Fenster-Menge des Kunden
 * als Ganzes: 01.-Erzwingung, keine Überlappung, keine Lücke, kein Rückwärts.
 *
 * @throws {AppError} 404 wenn die Zeile nicht existiert, 400 bei unzulässigem Fenster.
 */
export async function updateCustomerInsurance(
  insuranceId: number,
  patch: UpdateCustomerInsurancePatch,
  tx?: DbOrTx,
): Promise<CustomerInsuranceHistory> {
  const executor = tx ?? db;

  const currentRows = await executor
    .select()
    .from(customerInsuranceHistory)
    .where(eq(customerInsuranceHistory.id, insuranceId))
    .limit(1);
  const current = currentRows[0];
  if (!current) throw notFound("Versicherungs-Zuordnung nicht gefunden");

  const nextValidFrom = patch.validFrom ?? current.validFrom;
  const nextValidTo = patch.validTo !== undefined ? patch.validTo : current.validTo;

  const others = (await loadInsuranceWindows(current.customerId, executor))
    .filter((w) => w.id !== insuranceId);
  const setError = validateInsuranceWindows([
    ...others,
    { id: insuranceId, validFrom: nextValidFrom, validTo: nextValidTo },
  ]);
  if (setError) throw badRequest(setError);

  const updated = await executor
    .update(customerInsuranceHistory)
    .set({
      validFrom: nextValidFrom,
      validTo: nextValidTo,
      ...(patch.versichertennummer !== undefined ? { versichertennummer: patch.versichertennummer } : {}),
    })
    .where(eq(customerInsuranceHistory.id, insuranceId))
    .returning();

  return updated[0];
}
