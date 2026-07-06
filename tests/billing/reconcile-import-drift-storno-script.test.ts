import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1656 — Skript-Pfad-Regression für die Import-Drift-Reparatur
 * (`server/scripts/reconcile-billed-appointment-import-drift.ts`, Task #1651).
 *
 * Task #1652 hat NUR den ROUTE-Pfad (`PATCH /api/billing/:id/status`) über die
 * gemeinsame SSoT `stornoInvoiceCascade` abgedeckt. Dieser Test treibt statt der
 * Route die exportierte `reconcile(args)`-Funktion des Reparatur-Skripts direkt
 * gegen ein eingespieltes Drift-Szenario und prüft die vier Sicherheits-
 * garantien, die den scharfen Lauf ausmachen:
 *
 *   1. NUR die beabsichtigte(n) Rechnung(en) werden storniert (Kontroll-Kunde
 *      mit eigener Rechnung bleibt unangetastet).
 *   2. PRO Topf-Geschwister-Rechnung genau EINE `stornorechnung`.
 *   3. Budget-Konsumtion wird zurückgebucht (reversal-Buchungen entstehen).
 *   4. JEDER `invoice_cancelled`-Audit-Eintrag trägt die skript-spezifischen
 *      Zusatz-Metadaten (`reason`/`batchId`/`task`) — genau die Felder, die der
 *      Route-Pfad bewusst NICHT setzt (siehe Gegenprobe in
 *      `storno-cascade-invoices-and-audit.test.ts`).
 *
 * Zusätzlich: Trockenlauf (`apply:false`) darf NICHTS mutieren.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  invoices as invoicesTable,
  auditLog,
  budgetTransactions,
  monthlyServiceRecords,
} from "@shared/schema";
import { reconcile } from "../../server/scripts/reconcile-billed-appointment-import-drift";
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

/** Vergangener Werktag im aktuellen Monat (Termin muss abrechenbar sein). */
function weekdayInCurrentMonth(): string {
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  for (let offset = 0; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  for (let offset = 1; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}

/**
 * Ein vollständig abgerechneter Termin (Pflegekasse). `split:true` erzwingt über
 * einen knappen §45b-Topf eine Cascade nach §45a → Multi-Topf-Split-Rechnung;
 * `split:false` bucht einen einzelnen §45b-Topf → eine Rechnung.
 */
async function seedBilledAppointment(opts: {
  customerId: number;
  employeeId: number;
  apptDate: string;
  hwServiceId: number;
  abServiceId: number;
  split: boolean;
}): Promise<{ appointmentId: number; serviceRecordId: number }> {
  const { customerId, employeeId, apptDate, hwServiceId, abServiceId, split } = opts;
  const dt = new Date(apptDate);
  const year = dt.getFullYear();
  const month = dt.getMonth() + 1;

  if (split) {
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
  } else {
    // §45b großzügig → einzelner Topf → eine Rechnung.
    await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 60000,
      carryoverAmountCents: 0,
      budgetStartDate: apptDate,
    });
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);
  }

  const services = split
    ? [
        { serviceId: hwServiceId, durationMinutes: 240 },
        { serviceId: abServiceId, durationMinutes: 60 },
      ]
    : [{ serviceId: hwServiceId, durationMinutes: 60 }];
  // Der Kontroll-Termin (split=false) nutzt DENSELBEN Mitarbeiter wie der Ziel-
  // Termin — daher ein anderes Zeitfenster, sonst 409 „Terminüberschneidung".
  const scheduledStart = split ? "08:00" : "14:00";
  const scheduledEnd = split ? "13:00" : "15:00";
  const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId,
    date: apptDate,
    scheduledStart,
    scheduledEnd,
    notes: `T1656-${uniqueId()}`,
    assignedEmployeeId: employeeId,
    services,
  });
  expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
  const appointmentId = apptRes.data.id;

  const docRes = await apiPost(`/api/appointments/${appointmentId}/document`, {
    actualStart: scheduledStart,
    travelOriginType: "home",
    travelKilometers: 18,
    customerKilometers: 7,
    services: services.map((s) => ({
      serviceId: s.serviceId,
      actualDurationMinutes: s.durationMinutes,
      details: "T1656-Doc",
    })),
  });
  expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

  const srRes = await apiPost<{ id: number }>("/api/service-records", {
    customerId,
    employeeId,
    year,
    month,
  });
  expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
  }

  const genRes = await apiPost<{ splitInvoices?: boolean; invoices?: Array<{ id: number }> }>(
    "/api/billing/generate",
    { customerId, billingMonth: month, billingYear: year },
  );
  expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
  if (split) {
    expect(genRes.data.splitInvoices, "Mehr-Topf-Lauf muss splitInvoices=true liefern").toBe(true);
  }

  return { appointmentId, serviceRecordId: srRes.data.id };
}

async function activeRechnungIds(customerId: number): Promise<number[]> {
  const rows = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.customerId, customerId), eq(invoicesTable.invoiceType, "rechnung")));
  return rows.map((r) => r.id);
}

let driftCustomerId: number;
let controlCustomerId: number;
let employeeId: number;
let hwServiceId: number;
let abServiceId: number;
let superadminId: number;

beforeAll(async () => {
  const auth = await getAuthCookie();
  superadminId = auth.user.id;

  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;

  const emp = await createTestEmployee({ nachnamePrefix: "RCN_T1656" });
  employeeId = emp.id;

  const drift = await createTestCustomer({
    vorname: "T1656-Drift",
    nachname: `Recon-${uniqueId()}`,
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_privat",
    acceptsPrivatePayment: true,
  });
  driftCustomerId = drift.id as number;

  const control = await createTestCustomer({
    vorname: "T1656-Control",
    nachname: `Recon-${uniqueId()}`,
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_privat",
    acceptsPrivatePayment: true,
  });
  controlCustomerId = control.id as number;

  for (const cid of [driftCustomerId, controlCustomerId]) {
    const assignRes = await apiPatch(`/api/admin/customers/${cid}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign ${cid}: ${JSON.stringify(assignRes.data)}`).toBe(200);
  }
});

afterAll(async () => {
  await cleanupCustomer(driftCustomerId);
  await cleanupCustomer(controlCustomerId);
  await deactivateTestEmployee(employeeId);
  await runCleanup();
});

describe("Task #1656 — Reparatur-Skript-Pfad storniert sicher, spiegelt SSoT & trägt Skript-Metadaten", () => {
  it("reconcile(dry-run) mutiert nichts; reconcile(--apply) storniert nur Ziel, Storno je Topf, Budget zurück, Audit mit reason/batchId", async () => {
    const apptDate = weekdayInCurrentMonth();

    // --- 1) Ziel-Kunde: abgerechneter Split-Termin. ---
    const { appointmentId, serviceRecordId } = await seedBilledAppointment({
      customerId: driftCustomerId,
      employeeId,
      apptDate,
      hwServiceId,
      abServiceId,
      split: true,
    });

    const originalsBefore = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.customerId, driftCustomerId), eq(invoicesTable.invoiceType, "rechnung")));
    expect(originalsBefore.length, "Split muss ≥2 Original-Topf-Rechnungen erzeugen").toBeGreaterThanOrEqual(2);
    const originalIds = originalsBefore.map((o) => o.id).sort((a, b) => a - b);

    // --- 2) Kontroll-Kunde: eigener, abgerechneter Termin (darf NIE angefasst
    //        werden — beweist "nur die beabsichtigte Rechnung"). ---
    await seedBilledAppointment({
      customerId: controlCustomerId,
      employeeId,
      apptDate,
      hwServiceId,
      abServiceId,
      split: false,
    });
    const controlIdsBefore = await activeRechnungIds(controlCustomerId);
    expect(controlIdsBefore.length, "Kontroll-Kunde muss ≥1 aktive Rechnung haben").toBeGreaterThanOrEqual(1);

    // --- 3) Drift EINSPIELEN (Signal A): LN-Siegel in die Vergangenheit
    //        zurückdatieren, sodass die (jetzt gebuchte) Konsumtion "nach dem
    //        Siegel" liegt — exakt das Muster, das ein früherer Import erzeugte. ---
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await db
      .update(monthlyServiceRecords)
      .set({ employeeSignedAt: past, customerSignedAt: past })
      .where(eq(monthlyServiceRecords.id, serviceRecordId));

    // --- 4) TROCKENLAUF: erkennt Drift, plant Reparatur, mutiert NICHTS. ---
    const dry = await reconcile({
      apply: false,
      customerIds: [],
      appointmentIds: [appointmentId],
      userId: undefined,
      reason: undefined,
      importLinkedOnly: false,
    });
    expect(dry.flagged.map((f) => f.appointmentId)).toContain(appointmentId);
    expect(dry.plan.length).toBe(1);
    expect([...dry.plan[0].sealedInvoiceIds].sort((a, b) => a - b)).toEqual(originalIds);
    expect(dry.plan[0].signedServiceRecordIds).toContain(serviceRecordId);
    // Keine Schreib-Ergebnisse im Trockenlauf.
    expect(dry.stornoedInvoiceIds).toEqual([]);
    expect(dry.reissuedInvoiceIds).toEqual([]);
    expect(dry.softStornoedServiceRecordIds).toEqual([]);
    expect(dry.batchId).toBeUndefined();

    // Nichts wurde mutiert: Originale aktiv, keine stornorechnung, keine
    // reversal-Buchung, LN nicht soft-gelöscht.
    const originalsAfterDry = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status })
      .from(invoicesTable)
      .where(inArray(invoicesTable.id, originalIds));
    for (const inv of originalsAfterDry) {
      expect(inv.status, `Trockenlauf darf Original ${inv.id} nicht anfassen`).not.toBe("storniert");
    }
    const stornosAfterDry = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.customerId, driftCustomerId), eq(invoicesTable.invoiceType, "stornorechnung")));
    expect(stornosAfterDry.length, "Trockenlauf darf keine stornorechnung erzeugen").toBe(0);
    const reversalsAfterDry = await db
      .select({ id: budgetTransactions.id })
      .from(budgetTransactions)
      .where(and(eq(budgetTransactions.appointmentId, appointmentId), eq(budgetTransactions.transactionType, "reversal")));
    expect(reversalsAfterDry.length, "Trockenlauf darf nicht zurückbuchen").toBe(0);
    const lnAfterDry = await db
      .select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.id, serviceRecordId));
    expect(lnAfterDry[0].deletedAt, "Trockenlauf darf LN nicht soft-stornieren").toBeNull();

    // --- 5) SCHARFER LAUF. ---
    const reason = "Task #1656 automatisierter Skript-Pfad-Regressionstest (Import-Drift-Reparatur)";
    const apply = await reconcile({
      apply: true,
      customerIds: [],
      appointmentIds: [appointmentId],
      userId: superadminId,
      reason,
      importLinkedOnly: false,
    });

    // Garantie 1: NUR beabsichtigte Originale werden angefasst. reconcile meldet
    // in `stornoedInvoiceIds` die direkt aufgelöste Ziel-Rechnung; das Topf-
    // Geschwister wird über die Storno-Cascade mit-storniert (unten per DB
    // geprüft), taucht aber NICHT separat in der Liste auf. Wichtig ist: keine
    // fremde Rechnung landet in der Liste (Teilmenge der Drift-Originale).
    expect(apply.stornoedInvoiceIds.length, "mind. eine Ziel-Rechnung storniert").toBeGreaterThan(0);
    for (const id of apply.stornoedInvoiceIds) {
      expect(originalIds, `nur Drift-Originale dürfen storniert werden (${id})`).toContain(id);
    }
    // ... und in der DB sind BEIDE Topf-Geschwister tatsächlich storniert.
    const originalsAfter = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status })
      .from(invoicesTable)
      .where(inArray(invoicesTable.id, originalIds));
    for (const inv of originalsAfter) {
      expect(inv.status, `Original ${inv.id} muss 'storniert' sein`).toBe("storniert");
    }
    // Kontroll-Kunde unverändert aktiv.
    const controlAfter = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status })
      .from(invoicesTable)
      .where(inArray(invoicesTable.id, controlIdsBefore));
    expect(controlAfter.length).toBe(controlIdsBefore.length);
    for (const inv of controlAfter) {
      expect(inv.status, `Kontroll-Rechnung ${inv.id} darf nicht storniert sein`).not.toBe("storniert");
    }

    // Garantie 2: genau EINE stornorechnung je Original-Topf-Geschwister.
    const stornosAfter = await db
      .select({ id: invoicesTable.id, grossAmountCents: invoicesTable.grossAmountCents })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.customerId, driftCustomerId), eq(invoicesTable.invoiceType, "stornorechnung")));
    expect(stornosAfter.length, "Anzahl Storno-Rechnungen muss Anzahl Original-Töpfe entsprechen").toBe(originalsBefore.length);

    // Garantie 3: Budget-Konsumtion wurde zurückgebucht (reversal-Buchungen).
    const reversalsAfter = await db
      .select({ id: budgetTransactions.id })
      .from(budgetTransactions)
      .where(and(eq(budgetTransactions.appointmentId, appointmentId), eq(budgetTransactions.transactionType, "reversal")));
    expect(reversalsAfter.length, "Storno muss Konsumtion zurückbuchen").toBeGreaterThan(0);

    // Neuausstellung: der frei gewordene Termin wurde neu abgerechnet.
    expect(apply.reissuedInvoiceIds.length, "Monat muss neu ausgestellt werden").toBeGreaterThan(0);
    for (const rid of apply.reissuedInvoiceIds) {
      expect(originalIds).not.toContain(rid); // wirklich NEUE Rechnungen
    }

    // LN soft-storniert + Termin zur Neu-Dokumentation ausgewiesen.
    expect(apply.softStornoedServiceRecordIds).toContain(serviceRecordId);
    expect(apply.lnReDocRequiredAppointmentIds).toContain(appointmentId);
    const lnAfter = await db
      .select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.id, serviceRecordId));
    expect(lnAfter[0].deletedAt, "LN muss soft-storniert sein").not.toBeNull();

    // Garantie 4: JEDER invoice_cancelled-Audit trägt reason/batchId/task —
    // genau die Felder, die der Route-Pfad bewusst NICHT setzt.
    expect(apply.batchId, "scharfer Lauf muss batchId setzen").toBeTruthy();
    const auditRows = await db
      .select({ entityId: auditLog.entityId, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.action, "invoice_cancelled"), eq(auditLog.entityType, "invoice"), inArray(auditLog.entityId, originalIds)));
    expect(auditRows.length, "ein invoice_cancelled je Original").toBe(originalIds.length);
    for (const r of auditRows) {
      const md = (r.metadata ?? {}) as Record<string, unknown>;
      expect(md.newStatus).toBe("storniert");
      expect(md.reason).toBe(reason);
      expect(md.batchId).toBe(apply.batchId);
      expect(md.task).toBe("#1651");
    }

    // Gegenprobe: auch der service_record_deleted-Audit trägt die Skript-Metadaten.
    const srAudit = await db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.action, "service_record_deleted"), eq(auditLog.entityType, "service_record"), eq(auditLog.entityId, serviceRecordId)));
    expect(srAudit.length).toBeGreaterThan(0);
    const srMd = (srAudit[0].metadata ?? {}) as Record<string, unknown>;
    expect(srMd.reason).toBe(reason);
    expect(srMd.batchId).toBe(apply.batchId);
  }, 300_000);
});
