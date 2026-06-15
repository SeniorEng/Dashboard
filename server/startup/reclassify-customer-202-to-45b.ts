import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../lib/db";
import {
  budgetTransactions,
  customers,
  insuranceProviders,
  users,
} from "@shared/schema";
import { addCareLevelHistory } from "../storage/customer-mgmt/care-level";
import { addCustomerInsurance } from "../storage/customer-mgmt/insurance";
import { upsertBudgetTypeSettings } from "../storage/budget/preferences-storage";
import { rebookAppointmentConsumption } from "../storage/budget/km-rebook";
import { auditService } from "../services/audit";
import { log } from "../lib/log";
import type { BudgetMigrationSummary } from "./budget-migration-runner";

/**
 * Task #1296 — Einmalige Produktiv-Datenkorrektur für Kunde #202
 * („Bauer, Ullrich").
 *
 * Hintergrund: Der Kunde wurde versehentlich als `selbstzahler` angelegt, ist
 * aber tatsächlich ein privater Pflegekassen-Patient (ARAG) mit Pflegegrad 4
 * und damit zum §45b-Entlastungsbetrag (131 €/Monat) berechtigt. Seine bereits
 * abgeschlossenen Termine haben ihre Kosten in den ungekappten PRIVAT-Topf
 * gebucht statt in §45b. Diese Migration korrigiert das einmalig:
 *
 *   1. Stammdaten: `billing_type = pflegekasse_privat`, Pflegegrad 4 (über die
 *      Pflegegrad-Historie, valid_from 01.01.2026 — daraus leitet der §45b-Anker
 *      ab), `accepts_private_payment = true` (damit ein Monat mit Verbrauch über
 *      131 € in den Privat-Überlauf kaskadiert statt hart zu blockieren),
 *      `rechnung_an_kunde = true` (Kostenerstattung, Default für private
 *      Pflegekasse) und ARAG als Pflegekasse.
 *   2. NUR den §45b-Topf aktivieren (Anker 01.01.2026); §45a und §39/§42a bleiben
 *      aus. §45b akkumuliert die statutorischen 131 €/Monat für 2026 automatisch.
 *   3. Den bestehenden Verbrauch der abgeschlossenen Termine aus dem Privat-Topf
 *      zurückbuchen und über die Kaskade in §45b neu buchen (Storno + Neu über
 *      `rebookAppointmentConsumption({force:true})`). Summen bleiben erhalten —
 *      es wird kein Geld erzeugt oder vernichtet; ein Monatsüberschuss über 131 €
 *      kaskadiert in den Privat-Überlauf (erlaubt/erwartet).
 *
 * Sicherheit:
 *   - Identitäts-Guard: greift NUR für id=202 UND Name enthält „Bauer"+„Ullrich"
 *     UND aktuellem `billing_type = 'selbstzahler'`. Andernfalls No-Op → sicher
 *     in Dev/Test (Kunde existiert dort nicht) und idempotent in Prod (nach dem
 *     Lauf ist `billing_type != 'selbstzahler'`, zusätzlich greift der
 *     Migrations-Ledger).
 *   - Läuft im Guarded-Wrapper: eine Transaktion, GoBD-Bypass, Conservation-
 *     Pre-/Post-Check (Rollback bei JEDER neuen Topf-Überziehung), Ledger-Insert
 *     (exactly-once).
 */
const CUSTOMER_ID = 202;
const CARE_LEVEL_VALID_FROM = "2026-01-01";
const REBOOK_TRIGGER = "appointment_reclassify:customer_202_to_45b";
const INSURANCE_NOTE =
  "Reklassifizierung #202: ARAG (privat) hinterlegt. Versichertennummer ist " +
  "manuell nachzutragen.";

export async function reclassifyCustomer202To45b(
  tx: Tx,
): Promise<BudgetMigrationSummary> {
  // 1. Identitäts-Guard ---------------------------------------------------
  const [cust] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, CUSTOMER_ID))
    .limit(1);

  if (!cust) {
    return { changed: 0, note: "Kunde #202 nicht vorhanden (Dev/Test No-Op)" };
  }
  if (cust.deletedAt) {
    return { changed: 0, note: "Kunde #202 ist gelöscht — No-Op" };
  }
  if (cust.billingType !== "selbstzahler") {
    return {
      changed: 0,
      note: `Kunde #202 ist nicht (mehr) selbstzahler (billing_type=${cust.billingType}) — bereits migriert, No-Op`,
    };
  }
  const nameLc = (cust.name ?? "").toLowerCase();
  if (!nameLc.includes("bauer") || !nameLc.includes("ullrich")) {
    return {
      changed: 0,
      note: `Kunde #202 Name passt nicht ("${cust.name}") — No-Op (Sicherheits-Guard)`,
    };
  }

  // 2. Pflicht-Audit-Akteur (ältester Superadmin, Fallback ältester Admin)
  const [superActor] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let actorId: number | null = superActor?.id ?? null;
  if (actorId == null) {
    const [adminActor] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    actorId = adminActor?.id ?? null;
  }
  if (actorId == null) {
    log(
      "Reclassify-Customer-202 übersprungen: kein Super-/Admin-Akteur für Audit-Log.",
      "startup",
    );
    return { changed: 0, note: "kein Audit-Akteur" };
  }
  const auditActorId = actorId;

  log(
    `Reclassify-Customer-202: Kunde #202 ("${cust.name}") wird von selbstzahler auf ` +
      "pflegekasse_privat (§45b) umgestellt.",
    "startup",
  );

  // 3. Stammdaten korrigieren -------------------------------------------
  await tx
    .update(customers)
    .set({
      billingType: "pflegekasse_privat",
      acceptsPrivatePayment: true,
      rechnungAnKunde: true,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, CUSTOMER_ID));

  // Pflegegrad 4 ab 01.01.2026 (setzt auch customers.pflegegrad). Der §45b-Anker
  // leitet sich aus dieser Historie ab.
  await addCareLevelHistory(
    {
      customerId: CUSTOMER_ID,
      pflegegrad: 4,
      validFrom: CARE_LEVEL_VALID_FROM,
    },
    auditActorId,
    tx,
  );

  // ARAG als Pflegekasse: bestehenden Provider finden (case-insensitiv) oder
  // anlegen (privat). Keine fabrizierte Versichertennummer — leeres Feld +
  // Notiz, das manuell nachzutragen ist.
  let [arag] = await tx
    .select({ id: insuranceProviders.id })
    .from(insuranceProviders)
    .where(sql`lower(${insuranceProviders.name}) = 'arag'`)
    .limit(1);
  if (!arag) {
    [arag] = await tx
      .insert(insuranceProviders)
      .values({
        name: "ARAG",
        empfaenger: "ARAG",
        isPrivate: true,
        isActive: true,
      })
      .returning({ id: insuranceProviders.id });
  }
  await addCustomerInsurance(
    {
      customerId: CUSTOMER_ID,
      insuranceProviderId: arag.id,
      versichertennummer: "",
      validFrom: CARE_LEVEL_VALID_FROM,
      notes: INSURANCE_NOTE,
    },
    auditActorId,
    tx,
  );

  await auditService.log(
    auditActorId,
    "customer_updated",
    "customer",
    CUSTOMER_ID,
    {
      source: "reclassify-customer-202-to-45b",
      reason:
        "Einmalige Datenkorrektur: selbstzahler → pflegekasse_privat (ARAG), " +
        "Pflegegrad 4 ab 01.01.2026, §45b aktiviert.",
      changedFields: [
        "billingType",
        "acceptsPrivatePayment",
        "rechnungAnKunde",
        "pflegegrad",
        "insurance",
      ],
      previousBillingType: "selbstzahler",
    },
    undefined,
    tx,
  );

  // 4. NUR §45b aktivieren (Anker 01.01.2026) ---------------------------
  // billing_type ist oben bereits auf pflegekasse_privat gesetzt → der
  // Selbstzahler-Statutory-Guard im SSoT-Schreibpfad lässt §45b zu.
  await upsertBudgetTypeSettings(
    CUSTOMER_ID,
    [
      {
        budgetType: "entlastungsbetrag_45b",
        enabled: true,
        priority: 1,
        monthlyLimitCents: null,
        validFrom: CARE_LEVEL_VALID_FROM,
      },
    ],
    tx,
    auditActorId,
  );

  // 5. Bestehende Privat-Consumption in §45b umbuchen -------------------
  // Alle Termine des Kunden mit lebender Consumption ermitteln (robust statt
  // hartkodierter IDs). `force:true` erzwingt Storno + Neu-Buchung über die
  // Kaskade, obwohl km/Minuten/Datum unverändert sind — nur der Topf wechselt.
  const apptRows = await tx
    .selectDistinct({ appointmentId: budgetTransactions.appointmentId })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.customerId, CUSTOMER_ID),
        eq(budgetTransactions.transactionType, "consumption"),
        sql`${budgetTransactions.appointmentId} IS NOT NULL`,
      ),
    );
  const appointmentIds = apptRows
    .map((r) => r.appointmentId)
    .filter((id): id is number => id != null)
    .sort((a, b) => a - b);

  let rebookedAppointments = 0;
  let reversedRows = 0;
  for (const appointmentId of appointmentIds) {
    const result = await rebookAppointmentConsumption(
      { appointmentId, userId: auditActorId, force: true },
      tx,
    );
    if (!result.rebooked) continue;
    rebookedAppointments++;
    reversedRows += result.reversedTransactionIds.length;

    await auditService.log(
      auditActorId,
      "appointment_km_rebooked",
      "appointment",
      appointmentId,
      {
        customerId: CUSTOMER_ID,
        trigger: REBOOK_TRIGGER,
        source: "reclassify-customer-202-to-45b",
        reason:
          "Umbuchung Privat-Topf → §45b nach Reklassifizierung (Topf-Wechsel, " +
          "keine Mengen-/Datums-Änderung).",
        reversedTransactionIds: result.reversedTransactionIds,
        transactionDate: result.transactionDate,
      },
      undefined,
      tx,
    );
  }

  // 6. Per-Topf-Summen für die Sign-off-Zusammenfassung ----------------
  const potTotals = await tx
    .select({
      budgetType: budgetTransactions.budgetType,
      netCents: sql<number>`COALESCE(SUM(${budgetTransactions.amountCents}), 0)`,
    })
    .from(budgetTransactions)
    .where(eq(budgetTransactions.customerId, CUSTOMER_ID))
    .groupBy(budgetTransactions.budgetType);
  const potSummary = potTotals
    .map((p) => `${p.budgetType}=${Number(p.netCents)}c`)
    .join(", ");

  const note =
    `selbstzahler→pflegekasse_privat, §45b aktiviert, PG4@${CARE_LEVEL_VALID_FROM}; ` +
    `rebookedAppointments=${rebookedAppointments}, reversedRows=${reversedRows}; ` +
    `netto pro Topf: [${potSummary}]`;
  log(`Reclassify-Customer-202 abgeschlossen: ${note}`, "startup");

  return { changed: rebookedAppointments + 1, note };
}
