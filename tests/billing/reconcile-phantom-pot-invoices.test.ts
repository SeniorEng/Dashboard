/**
 * Task #1024 / #1026 — End-to-End-Verifikation des Phantom-Topf-Rechnungs-
 * Reconcile (`reconcilePhantomPotInvoices`, Task #1016).
 *
 * Task #1016 lieferte das Aufräum-Skript samt reinen Unit-Tests für die
 * *Erkennung* (`isPotEntirelyReversed`). Der scharfe *Storno-Pfad* (`--apply`)
 * war bislang nur durch Code-Lesen abgedeckt. Dieser Integrationstest seedet
 * den realen Egon-Uhlig-Fall in eine ephemere DB und prüft den vollständigen
 * Korrektur-Lauf:
 *
 *   - Ein Termin verbraucht LIVE §45b (nicht storniert) UND §45a, wobei der
 *     §45a-Anteil vollständig storniert (netto null) ist.
 *   - Für beide Töpfe wurde je eine pot-spezifische Split-Rechnung ausgestellt
 *     (gemeinsame `billingRunId`). Die §45a-Rechnung ist damit eine Phantom-
 *     Topf-Rechnung.
 *
 * Der Test ist über die ART des §45a-Stornos PARAMETRISIERT (Task #1026):
 *
 *   - `linkReversal: true`  — verknüpfter Reversal (`reversedTransactionId`
 *     gesetzt). Das ist der „saubere" Storno-Pfad.
 *   - `linkReversal: false` — der eigentliche Import-Bug: eine VERWAISTE
 *     Reversal-Zeile mit `reversed_transaction_id = NULL`, deren EINZIGE
 *     Verknüpfung die Freitext-Notiz "Storno von Transaktion #<id>" ist. Der
 *     Partial-Unique-Index übersieht diese Waisen, und die Storno-Erkennung im
 *     Apply-Pfad muss sich allein auf die NOTE-basierte Auflösung
 *     (`parseStornoReference` via `collectReversedConsumptionIds`) verlassen.
 *     Eine Regression in dieser NOTE-Erkennung würde sonst unbemerkt bleiben.
 *
 * Verifiziert (für BEIDE Varianten identisch):
 *   1. Trockenlauf (`apply:false`) findet GENAU die §45a-Rechnung und schreibt
 *      NICHTS (keine Stornorechnung, kein Status-Wechsel, kein Audit).
 *   2. Scharflauf (`apply:true`) erzeugt eine negierte Stornorechnung, setzt die
 *      §45a-Originalrechnung auf `storniert`, schreibt einen
 *      `invoice_cancelled`-Audit-Eintrag — UND lässt die lebende §45b-
 *      Geschwister-Rechnung sowie deren `budget_transactions` unangetastet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetTransactions,
  invoices as invoicesTable,
  invoiceLineItems,
  auditLog,
  users,
} from "@shared/schema";
import { reconcilePhantomPotInvoices } from "../../server/scripts/reconcile-phantom-pot-invoices";
import { createInvoiceTx, getNextInvoiceNumberTx } from "../../server/storage/billing-storage";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  runCleanup,
  uniqueId,
} from "../test-utils";

const YEAR = 2026;
const MONTH = 4;
const APPT_DATE = `${YEAR}-0${MONTH}-15`;

const LIVE_45B_CENTS = 3000; // lebende §45b-Konsumption → §45b-Rechnung gross
const REVERSED_45A_CENTS = 2000; // stornierte §45a-Konsumption → Phantom-§45a-Rechnung gross

interface StornoVariant {
  label: string;
  /**
   * true  → §45a-Storno als VERKNÜPFTE Reversal-Zeile (`reversedTransactionId`).
   * false → §45a-Storno als VERWAISTE NULL-Link-Zeile, erkennbar NUR über die
   *         Notiz "Storno von Transaktion #<id>" (der reale Import-Bug, #1026).
   */
  linkReversal: boolean;
}

const VARIANTS: StornoVariant[] = [
  { label: "verknüpfter Reversal (reversedTransactionId gesetzt)", linkReversal: true },
  { label: "NULL-Link Note-Storno (Import-Bug-Muster, Task #1026)", linkReversal: false },
];

describe.each(VARIANTS)(
  "reconcilePhantomPotInvoices — End-to-End · §45a-Storno: $label",
  ({ linkReversal }) => {
    let customerId: number;
    let employeeId: number;
    let abServiceId: number;
    let appointmentId: number;
    let superadminId: number;

    let invoice45aId: number; // Phantom-Topf-Rechnung (§45a, vollständig storniert)
    let invoice45bId: number; // lebende Geschwister-Rechnung (§45b)
    let live45bTxnId: number; // §45b consumption budget_transaction

    const cleanupApptIds: number[] = [];

    async function createAppt(scheduledStart: string, scheduledEnd: string): Promise<number> {
      const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId,
        date: APPT_DATE,
        scheduledStart,
        scheduledEnd,
        notes: `Phantom-Reconcile-${uniqueId()}`,
        assignedEmployeeId: employeeId,
        services: [{ serviceId: abServiceId, durationMinutes: 30 }],
      });
      expect(res.status, `create appt: ${JSON.stringify(res.data)}`).toBe(201);
      cleanupApptIds.push(res.data.id);
      return res.data.id;
    }

    async function countCustomerInvoices(): Promise<number> {
      const rows = await db
        .select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(eq(invoicesTable.customerId, customerId));
      return rows.length;
    }

    async function countCancelAudits(): Promise<number> {
      const rows = await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.action, "invoice_cancelled"), eq(auditLog.entityId, invoice45aId)));
      return rows.length;
    }

    async function snapshotCustomerLedger() {
      return db
        .select({
          id: budgetTransactions.id,
          budgetType: budgetTransactions.budgetType,
          transactionType: budgetTransactions.transactionType,
          amountCents: budgetTransactions.amountCents,
        })
        .from(budgetTransactions)
        .where(eq(budgetTransactions.customerId, customerId))
        .orderBy(budgetTransactions.id);
    }

    beforeAll(async () => {
      const auth = await getAuthCookie();

      // Echten Superadmin auflösen (Audit-Attribution wie im scharfen Lauf).
      const [admin] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.isSuperAdmin, true))
        .limit(1);
      superadminId = admin?.id ?? auth.user.id;

      const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
      abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;

      const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
        vorname: "Phantom",
        nachname: `Reconcile-${uniqueId()}`,
        geburtsdatum: "1941-03-08",
        email: `phantom-${uniqueId()}@test.local`,
        strasse: "Phantomweg",
        nr: "16",
        plz: "01067",
        stadt: "Dresden",
        telefon: "+4917600000002",
        pflegegrad: 3,
        pflegegradSeit: "2024-01-01",
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
      });
      expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
      customerId = custRes.data.id;

      const emp = await createTestEmployee({ vorname: "Erik", nachnamePrefix: "Phantom_Integ" });
      employeeId = emp.id;
      const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
        primaryEmployeeId: employeeId,
        backupEmployeeId: null,
        backupEmployeeId2: null,
      });
      expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

      appointmentId = await createAppt("13:00", "13:30");

      // --- Synthetischer Ledger (INSERT ist der normale Pfad; Immutabilitäts-
      // Trigger greifen nur bei UPDATE/DELETE). ---

      // LIVE §45b-Konsumption (bleibt bestehen).
      const [liveTxn] = await db
        .insert(budgetTransactions)
        .values({
          customerId,
          budgetType: "entlastungsbetrag_45b",
          transactionDate: APPT_DATE,
          transactionType: "consumption",
          amountCents: -LIVE_45B_CENTS,
          appointmentId,
          notes: "Phantom-Test: live §45b",
        })
        .returning({ id: budgetTransactions.id });
      live45bTxnId = liveTxn.id;

      // §45a-Konsumption → vollständig storniert (netto null) → Phantom-Topf.
      const [orig45a] = await db
        .insert(budgetTransactions)
        .values({
          customerId,
          budgetType: "umwandlung_45a",
          transactionDate: APPT_DATE,
          transactionType: "consumption",
          amountCents: -REVERSED_45A_CENTS,
          appointmentId,
          notes: "Phantom-Test: §45a (wird storniert)",
        })
        .returning({ id: budgetTransactions.id });

      // Storno-Variante: verknüpft (reversedTransactionId) ODER verwaist
      // (NULL-Link, NUR über die Notiz auflösbar — der reale Import-Bug, #1026).
      // Die Notiz "Storno von Transaktion #<id>" ist in BEIDEN Varianten
      // gesetzt; einzig `reversedTransactionId` unterscheidet sie.
      await db.insert(budgetTransactions).values({
        customerId,
        budgetType: "umwandlung_45a",
        transactionDate: APPT_DATE,
        transactionType: "reversal",
        amountCents: REVERSED_45A_CENTS,
        appointmentId,
        reversedTransactionId: linkReversal ? orig45a.id : null,
        notes: `Storno von Transaktion #${orig45a.id}`,
      });

      // --- Zwei ausgestellte Split-Rechnungen (gemeinsamer Abrechnungslauf). ---
      const billingRunId = (globalThis.crypto?.randomUUID?.() ?? `run-${uniqueId()}`);

      const baseInvoice = (gross: number, budgetType: string) => ({
        customerId,
        billingType: "pflegekasse_gesetzlich",
        invoiceType: "rechnung",
        billingMonth: MONTH,
        billingYear: YEAR,
        recipientName: "Pflegekasse Test",
        recipientAddress: "Kassenweg 1, 01067 Dresden",
        customerName: "Phantom Reconcile",
        pflegegrad: 3,
        netAmountCents: gross,
        vatAmountCents: 0,
        grossAmountCents: gross,
        vatRate: 0,
        status: "versendet",
        budgetType,
        billingRunId,
      });

      const lineItem = (gross: number) => ({
        appointmentId,
        appointmentDate: APPT_DATE,
        serviceDescription: "Alltagsbegleitung",
        serviceCode: "alltagsbegleitung",
        durationMinutes: 30,
        unitPriceCents: gross,
        totalCents: gross,
        employeeName: "Erik",
      });

      const seeded = await db.transaction(async (tx) => {
        const num45a = await getNextInvoiceNumberTx(tx, YEAR);
        const inv45a = await createInvoiceTx(
          tx,
          { ...baseInvoice(REVERSED_45A_CENTS, "umwandlung_45a"), invoiceNumber: num45a },
          [lineItem(REVERSED_45A_CENTS)],
          superadminId,
        );
        const num45b = await getNextInvoiceNumberTx(tx, YEAR);
        const inv45b = await createInvoiceTx(
          tx,
          { ...baseInvoice(LIVE_45B_CENTS, "entlastungsbetrag_45b"), invoiceNumber: num45b },
          [lineItem(LIVE_45B_CENTS)],
          superadminId,
        );
        return { inv45a, inv45b };
      });
      invoice45aId = seeded.inv45a.id;
      invoice45bId = seeded.inv45b.id;
    }, 120_000);

    afterAll(async () => {
      for (const id of cleanupApptIds) {
        try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
      }
      await cleanupCustomer(customerId);
      await deactivateTestEmployee(employeeId);
      await runCleanup();
    });

    it("Trockenlauf findet die §45a-Phantom-Rechnung, schreibt aber nichts", async () => {
      const invoicesBefore = await countCustomerInvoices();
      const auditsBefore = await countCancelAudits();
      const ledgerBefore = await snapshotCustomerLedger();

      const summary = await reconcilePhantomPotInvoices({
        apply: false,
        customerIds: [customerId],
      });

      // Genau die §45a-Rechnung ist Phantom; §45b (lebend) NICHT.
      expect(summary.findings).toHaveLength(1);
      expect(summary.findings[0].invoiceId).toBe(invoice45aId);
      expect(summary.findings[0].potKey).toBe("umwandlung_45a");
      expect(summary.findings[0].reversedConsumptionCents).toBe(REVERSED_45A_CENTS);
      expect(summary.stornoedCount).toBe(0);

      // Trockenlauf: keinerlei Schreibwirkung.
      expect(await countCustomerInvoices()).toBe(invoicesBefore);
      expect(await countCancelAudits()).toBe(auditsBefore);
      expect(await snapshotCustomerLedger()).toEqual(ledgerBefore);

      const [orig45a] = await db
        .select({ status: invoicesTable.status })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, invoice45aId));
      expect(orig45a.status).toBe("versendet");
    }, 120_000);

    it("Scharflauf storniert die §45a-Rechnung GoBD-konform und lässt §45b unberührt", async () => {
      const ledgerBefore = await snapshotCustomerLedger();
      const REASON = "Phantom-Topf-Rechnung Egon-Uhlig (Task #1026 E2E-Verifikation)";

      const summary = await reconcilePhantomPotInvoices({
        apply: true,
        customerIds: [customerId],
        userId: superadminId,
        reason: REASON,
      });
      expect(summary.findings).toHaveLength(1);
      expect(summary.stornoedCount).toBe(1);

      // 1. Negierte Stornorechnung referenziert die §45a-Originalrechnung.
      const stornos = await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.stornierteRechnungId, invoice45aId));
      expect(stornos).toHaveLength(1);
      const storno = stornos[0];
      expect(storno.invoiceType).toBe("stornorechnung");
      expect(storno.grossAmountCents).toBe(-REVERSED_45A_CENTS);
      expect(storno.netAmountCents).toBe(-REVERSED_45A_CENTS);
      expect(storno.budgetType).toBe("umwandlung_45a");

      const stornoItems = await db
        .select({ totalCents: invoiceLineItems.totalCents })
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, storno.id));
      expect(stornoItems).toHaveLength(1);
      expect(stornoItems[0].totalCents).toBe(-REVERSED_45A_CENTS);

      // 2. §45a-Originalrechnung steht auf `storniert`.
      const [orig45a] = await db
        .select({ status: invoicesTable.status })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, invoice45aId));
      expect(orig45a.status).toBe("storniert");

      // 3. `invoice_cancelled`-Audit-Eintrag mit Begründung + Task-Marker.
      const audits = await db
        .select({ metadata: auditLog.metadata, entityType: auditLog.entityType, userId: auditLog.userId })
        .from(auditLog)
        .where(and(eq(auditLog.action, "invoice_cancelled"), eq(auditLog.entityId, invoice45aId)));
      expect(audits).toHaveLength(1);
      expect(audits[0].entityType).toBe("invoice");
      expect(audits[0].userId).toBe(superadminId);
      const meta = audits[0].metadata as Record<string, unknown>;
      expect(meta.task).toBe("#1016");
      expect(meta.reason).toBe(REASON);
      expect(meta.phantomPot).toBe(true);
      expect(meta.budgetType).toBe("umwandlung_45a");

      // 4. Lebende §45b-Geschwister-Rechnung UNANGETASTET.
      const [inv45b] = await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, invoice45bId));
      expect(inv45b.status).toBe("versendet");
      expect(inv45b.budgetType).toBe("entlastungsbetrag_45b");

      // Keine Stornorechnung zeigt auf die §45b-Rechnung.
      const stornosAgainst45b = await db
        .select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(eq(invoicesTable.stornierteRechnungId, invoice45bId));
      expect(stornosAgainst45b).toHaveLength(0);

      // 5. Budget-Ledger des Kunden vollständig unverändert (Storno ist rein
      //    dokument-seitig — KEINE Budget-Reversierung).
      expect(await snapshotCustomerLedger()).toEqual(ledgerBefore);
      const live45b = ledgerBefore.find((r) => r.id === live45bTxnId);
      expect(live45b).toMatchObject({
        budgetType: "entlastungsbetrag_45b",
        transactionType: "consumption",
        amountCents: -LIVE_45B_CENTS,
      });
    }, 120_000);

    it("Doppel-Reconcile findet die bereits stornierte §45a-Rechnung nicht erneut", async () => {
      const summary = await reconcilePhantomPotInvoices({
        apply: false,
        customerIds: [customerId],
      });
      expect(summary.findings.some((f) => f.invoiceId === invoice45aId)).toBe(false);
    }, 120_000);
  },
);
