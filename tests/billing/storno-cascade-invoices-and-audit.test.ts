import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1652 — Regressionsschutz: Rechnungs-Storno über die Route verhält sich
 * identisch, nachdem die Cascade-Storno-Logik aus dem Route-Handler in die
 * SSoT `stornoInvoiceCascade` (server/services/invoice-storno.ts) herausgezogen
 * wurde (damit das GoBD-Reparatur-Skript denselben Pfad nutzt).
 *
 * Die bestehende Suite `storno-cascade-budget-reversal.test.ts` (Task #788)
 * deckt die BUDGET-Reversierung und das Umflaggen der Originale auf `storniert`
 * ab. Sie prüft aber NICHT die beiden anderen sichtbaren Ergebnisse des Storno:
 *
 *   1. dass PRO Topf-Geschwister-Rechnung genau EINE `stornorechnung`
 *      (negierte Beträge, Entwurf-Status, Verweis auf die stornierte Rechnung)
 *      erzeugt wird (billing_run-Cascade), und
 *   2. dass PRO Original ein `invoice_cancelled`-Audit-Eintrag mit der
 *      erwarteten Metadaten-Form geschrieben wird — und OHNE die vom
 *      Reparatur-Skript stammenden Zusatz-Metadaten (`reason`/`batchId`),
 *      damit ein Drift zwischen Route und SSoT auffliegt.
 *
 * Dieser Test schließt genau diese Lücke: würde die SSoT vom früheren
 * Inline-Verhalten abweichen (falsche Storno-Anzahl, fehlende Verlinkung,
 * geänderte Beträge, veränderte/fehlende Audit-Einträge), kippt er.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  invoices as invoicesTable,
  auditLog,
  budgetTransactions,
  type BudgetTransaction,
} from "@shared/schema";
import {
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  apiDelete,
  createTestCustomer,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  runCleanup,
  uniqueId,
} from "../test-utils";
import { billingReferenceMonth, pastWeekdayInBillingMonth } from "../helpers/billing-month";

async function consumptionNetPerPot(customerId: number): Promise<Map<string, number>> {
  const rows: BudgetTransaction[] = await db
    .select()
    .from(budgetTransactions)
    .where(eq(budgetTransactions.customerId, customerId));
  const perPot = new Map<string, number>();
  for (const r of rows) {
    perPot.set(r.budgetType, (perPot.get(r.budgetType) ?? 0) + (Number(r.amountCents ?? 0) || 0));
  }
  return perPot;
}

let customerId: number;
let employeeId: number;
let hwServiceId: number;
let abServiceId: number;
const cleanupApptIds: number[] = [];
const cleanupSrIds: number[] = [];

beforeAll(async () => {
  await getAuthCookie();

  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  const list = services.data;
  hwServiceId = list.find((s) => s.code === "hauswirtschaft")!.id;
  abServiceId = list.find((s) => s.code === "alltagsbegleitung")!.id;

  const cust = await createTestCustomer({
    vorname: "T1652-Storno-Invoices",
    nachname: `Audit-${uniqueId()}`,
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_privat",
    acceptsPrivatePayment: true,
  });
  customerId = cust.id as number;

  const emp = await createTestEmployee({ nachnamePrefix: "BS_T1652" });
  employeeId = emp.id;

  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: employeeId,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);
});

afterAll(async () => {
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
  }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
  await runCleanup();
});

describe("Task #1652 — Cascade-Storno erzeugt Storno-Rechnungen + Audit identisch zur früheren Inline-Logik", () => {
  it("PATCH storno+cascadeRun: eine stornorechnung je Topf-Geschwister, Originale storniert, Budget zurückgebucht, invoice_cancelled je Original", async () => {
    const apptDate = pastWeekdayInBillingMonth();
    const { year, month } = billingReferenceMonth();

    // §45b knapp → Cascade nach §45a → Multi-Topf-Split-Rechnung.
    await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 1000,
      carryoverAmountCents: 0,
      budgetStartDate: apptDate,
    });
    await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "umwandlung_45a",
      currentMonthAmountCents: 59880,
      carryoverAmountCents: 0,
      budgetStartDate: apptDate,
    });

    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 59880, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    // 1) Langer Termin → Konsumtion > §45b-Restbestand → Cascade §45a.
    const services = [
      { serviceId: hwServiceId, durationMinutes: 240 },
      { serviceId: abServiceId, durationMinutes: 60 },
    ];
    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: apptDate,
      scheduledStart: "08:00",
      scheduledEnd: "13:00",
      notes: `T1652-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services,
    });
    expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
    const appointmentId = apptRes.data.id;
    cleanupApptIds.push(appointmentId);

    const docRes = await apiPost(`/api/appointments/${appointmentId}/document`, {
      actualStart: "08:00",
      travelOriginType: "home",
      travelKilometers: 18,
      customerKilometers: 7,
      services: services.map((s) => ({
        serviceId: s.serviceId,
        actualDurationMinutes: s.durationMinutes,
        details: "T1652-Doc",
      })),
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    // 2) Leistungsnachweis erstellen + doppelt signieren (Pflegekasse-Gate).
    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId,
      employeeId,
      year,
      month,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType,
        signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    // 3) Rechnung generieren → Multi-Topf-Split mit gemeinsamer billingRunId.
    const genRes = await apiPost<{ splitInvoices?: boolean; invoices?: Array<{ id: number; billingRunId: string | null; budgetType: string | null }> }>(
      "/api/billing/generate",
      { customerId, billingMonth: month, billingYear: year },
    );
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    expect(genRes.data.splitInvoices, "Mehr-Topf-Lauf muss splitInvoices=true liefern").toBe(true);
    const generated = genRes.data.invoices ?? [];
    expect(generated.length, "Split muss >1 Rechnung erzeugen").toBeGreaterThanOrEqual(2);
    const billingRunId = generated[0].billingRunId;
    expect(billingRunId, "billingRunId muss gesetzt sein").toBeTruthy();

    // Original-Rechnungen des Laufs (frisch aus der DB) — vor dem Storno.
    const originalsBefore = await db
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.customerId, customerId),
          eq(invoicesTable.billingRunId, billingRunId!),
          eq(invoicesTable.invoiceType, "rechnung"),
        ),
      );
    expect(originalsBefore.length, "Es müssen ≥2 Original-Topf-Rechnungen existieren").toBeGreaterThanOrEqual(2);
    const originalIds = originalsBefore.map((o) => o.id);

    // Sanity: vor Storno keine Storno-Rechnungen für den Kunden.
    const stornosBefore = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.customerId, customerId),
          eq(invoicesTable.invoiceType, "stornorechnung"),
        ),
      );
    expect(stornosBefore.length, "vor Storno darf es keine stornorechnung geben").toBe(0);

    // Consumption-Netto je Topf vor Storno (muss != 0 sein → es wurde verbraucht).
    const netBefore = await consumptionNetPerPot(customerId);
    expect([...netBefore.values()].some((v) => v !== 0), "vor Storno muss Verbrauch != 0 sein").toBe(true);

    // 4) EINE Split-Rechnung stornieren mit Cascade über die Geschwister.
    const stornoTarget = generated[0];
    const stornoRes = await apiPatch<{ id: number; status: string; invoiceType: string }>(
      `/api/billing/${stornoTarget.id}/status`,
      { status: "storniert", cascadeRun: true },
    );
    expect(stornoRes.status, `storno cascade: ${JSON.stringify(stornoRes.data)}`).toBe(200);
    // Response = die aktualisierte Original-(Haupt-)Rechnung.
    expect(stornoRes.data.id).toBe(stornoTarget.id);
    expect(stornoRes.data.status).toBe("storniert");
    expect(stornoRes.data.invoiceType).toBe("rechnung");

    // --- Assertion A: alle Original-Rechnungen des Laufs sind storniert. ---
    const originalsAfter = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status })
      .from(invoicesTable)
      .where(inArray(invoicesTable.id, originalIds));
    for (const inv of originalsAfter) {
      expect(inv.status, `Original ${inv.id} muss 'storniert' sein`).toBe("storniert");
    }

    // --- Assertion B: genau EINE stornorechnung je Topf-Geschwister. ---
    const stornosAfter = await db
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.customerId, customerId),
          eq(invoicesTable.invoiceType, "stornorechnung"),
        ),
      );
    expect(
      stornosAfter.length,
      "Anzahl Storno-Rechnungen muss der Anzahl Original-Topf-Rechnungen entsprechen",
    ).toBe(originalsBefore.length);

    // Jede Stornorechnung: Entwurf-Status, korrekte Verlinkung auf die
    // stornierte (Ziel-)Rechnung und negierte Beträge — exakt wie die frühere
    // Inline-Logik. Die extrahierte `stornoData` übernimmt bewusst KEINEN
    // `budgetType`/`billingRunId` (Storno-Rechnungen sind topf-neutral),
    // daher wird je Original über die (net,vat,gross)-Tripel-Multimenge
    // gematcht statt über den Topf.
    const originalTriples = originalsBefore.map(
      (o) => `${o.netAmountCents}|${o.vatAmountCents}|${o.grossAmountCents}`,
    );
    for (const st of stornosAfter) {
      // Storno-Dokumente entstehen FERTIG, nicht als Entwurf (Status-Umbau,
      // `docs/rechnungsstatus-zielmodell.md`): sie spiegeln einen bereits
      // gestellten Beleg und bewegen sich danach nicht mehr.
      expect(st.status, `Storno ${st.id} muss fertig entstehen`).toBe("abgeschlossen");
      // Behavior-Quirk der SSoT (bewusst festgeschrieben): ALLE Storno-
      // Geschwister referenzieren die PATCH-Ziel-Rechnung (rootInvoiceId),
      // nicht ihr jeweiliges eigenes Original.
      expect(st.stornierteRechnungId, `Storno ${st.id} muss auf die Ziel-Rechnung zeigen`).toBe(stornoTarget.id);
      // Alle Läufer teilen billingType/Monat/Jahr — Storno spiegelt sie.
      expect(st.billingType).toBe(originalsBefore[0].billingType);
      expect(st.billingMonth).toBe(originalsBefore[0].billingMonth);
      expect(st.billingYear).toBe(originalsBefore[0].billingYear);
      // Das negierte Tripel muss zu genau einem noch offenen Original passen.
      const negTriple = `${-st.netAmountCents}|${-st.vatAmountCents}|${-st.grossAmountCents}`;
      const idx = originalTriples.indexOf(negTriple);
      expect(idx, `Storno ${st.id} hat kein passendes negiertes Original-Tripel`).toBeGreaterThanOrEqual(0);
      originalTriples.splice(idx, 1); // 1:1-Zuordnung erzwingen
    }
    expect(originalTriples.length, "jede Original-Rechnung muss genau eine Storno-Rechnung haben").toBe(0);
    // Σ-Garantie: Storno-Summe = negierte Original-Summe.
    const sumOrig = originalsBefore.reduce((s, o) => s + o.grossAmountCents, 0);
    const sumStorno = stornosAfter.reduce((s, o) => s + o.grossAmountCents, 0);
    expect(sumStorno).toBe(-sumOrig);

    // --- Assertion C: Budget-Konsumtion je Topf zurückgebucht (netto 0). ---
    const netAfter = await consumptionNetPerPot(customerId);
    for (const pot of netBefore.keys()) {
      expect(netAfter.get(pot), `Topf ${pot} muss nach Storno netto 0 sein`).toBe(0);
    }

    // --- Assertion D: ein invoice_cancelled-Audit je Original. ---
    const auditRows = await db
      .select({
        entityId: auditLog.entityId,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "invoice_cancelled"),
          eq(auditLog.entityType, "invoice"),
          inArray(auditLog.entityId, originalIds),
        ),
      );
    // Genau ein Eintrag je Original.
    expect(auditRows.length).toBe(originalIds.length);
    const auditedIds = new Set(auditRows.map((r) => r.entityId));
    for (const oid of originalIds) {
      expect(auditedIds.has(oid), `invoice_cancelled fehlt für Original ${oid}`).toBe(true);
    }
    for (const r of auditRows) {
      const md = (r.metadata ?? {}) as Record<string, unknown>;
      expect(md.newStatus).toBe("storniert");
      expect(md.customerId).toBe(customerId);
      expect(typeof md.stornoInvoiceNumber).toBe("string");
      expect(typeof md.stornoInvoiceId).toBe("number");
      // Split-Lauf → billingRunId ist in den Metadaten.
      expect(md.billingRunId).toBe(billingRunId);
      // Der Route-Pfad übergibt KEINE auditMetadataExtra (im Gegensatz zum
      // Reparatur-Skript) → reason/batchId dürfen NICHT auftauchen. Bricht,
      // falls die Route versehentlich Skript-Metadaten durchreicht.
      expect(md).not.toHaveProperty("reason");
      expect(md).not.toHaveProperty("batchId");
    }
  }, 180_000);
});
