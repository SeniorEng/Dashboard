import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as XLSX from "xlsx";
import {
  getAuthCookie,
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  runCleanup,
  createTestCustomer,
} from "./test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;

async function apiDeleteRaw(path: string): Promise<{ status: number; data: any }> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: { Cookie: cookieHeader, "x-csrf-token": auth.csrfToken },
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function uploadExcelPreview(buffer: Buffer): Promise<{ status: number; data: any }> {
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const form = new FormData();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  form.append("file", blob, "import.xlsx");
  const res = await fetch(`${BASE_URL}/api/admin/import-appointments/preview`, {
    method: "POST",
    headers: { Cookie: cookieHeader, "x-csrf-token": auth.csrfToken },
    body: form,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function buildExcelBuffer(rows: Array<Record<string, string | number>>): Buffer {
  const headers = [
    "Kunde", "Datum", "Start", "Ende", "Stunden", "Kilometer",
    "Senioren Engel", "Art", "Budget",
    "Pflegekasse Name", "IK", "Versichertennummer", "Pflegegrad",
  ];
  const data: any[][] = [headers];
  for (const r of rows) {
    data.push(headers.map((h) => r[h] ?? ""));
  }
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

describe("Task #116 — Carryover wird auch für rückwirkende Importmonate gesehen", () => {
  let customerId: number;

  beforeAll(async () => {
    const created = await createTestCustomer({
      vorname: "Marvin",
      nachname: `ImportTrim-${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    customerId = created.id as number;

    await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
  });

  it("INT-116.1 – initial-budget mit Carryover setzt validFrom auf Jahresanfang, nicht auf budgetStartDate", async () => {
    const now = new Date();
    const year = now.getFullYear();
    const budgetStartDate = `${year}-06-01`;

    const initRes = await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentYearAmountCents: 50000,
      carryoverAmountCents: 12500,
      budgetStartDate,
    });
    expect([200, 201]).toContain(initRes.status);

    const allocRes = await apiGet<any[]>(`/api/budget/${customerId}/allocations?year=${year - 1}`);
    expect(allocRes.status).toBe(200);

    const carryover = (allocRes.data ?? []).find(
      (a: any) => a.source === "carryover" && a.budgetType === "entlastungsbetrag_45b",
    );
    expect(carryover).toBeDefined();
    expect(carryover.validFrom).toBe(`${year}-01-01`);
    expect(carryover.validFrom).not.toBe(budgetStartDate);
    expect(carryover.expiresAt).toBe(`${year}-06-30`);
  });

  it("INT-116.2 – Import-Vorschau kürzt NICHT, wenn monatlicher Cap + Carryover ausreicht", async () => {
    // Frischer Kunde für isolierte Budget-Topf-Berechnung.
    const created = await createTestCustomer({
      vorname: "Bertha",
      nachname: `NoTrim-${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    const cid = created.id as number;

    await apiPatch(`/api/admin/customers/${cid}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    // §45b mit monatlichem Cap = 13.100 Cent (131 €) — Standard.
    await apiPut(`/api/budget/${cid}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 13100 },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });

    // Großzügiger Carryover: ohne Cap würde der Import die Vorschau-Verfügbarkeit
    // unbegrenzt sehen. Wichtig ist: der Import muss den Carryover für den
    // Importmonat sehen UND den Monatscap respektieren — beides liefert hier > 60 Min.
    const now = new Date();
    const year = now.getFullYear();
    await apiPost(`/api/budget/${cid}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentYearAmountCents: 0,
      carryoverAmountCents: 50000,
      budgetStartDate: `${year}-12-01`, // bewusst nach dem Importmonat
    });

    // Importzeile: 60 Minuten Alltagsbegleitung im Januar, Kosten ~36-40 € liegen
    // klar unter 131 € Monatscap + 500 € Carryover. Erwartung: kein Trim.
    const importDate = `${year}-01-15`;
    const customerName = `${created.vorname} ${created.nachname}`;
    const employeeName = auth.user.displayName || `${auth.user.vorname ?? ""} ${auth.user.nachname ?? ""}`.trim();

    const buffer = buildExcelBuffer([{
      "Kunde": `${cid}|${created.vorname}|${created.nachname}`,
      "Datum": importDate,
      "Start": 0.375, // 09:00
      "Ende": 0.4375, // 10:30 (Kosmetik; Stunden ist bindend)
      "Stunden": 1.0,
      "Kilometer": 0,
      "Senioren Engel": employeeName,
      "Art": "Alltagsbegleitung",
      "Budget": "Entlastungsleistung",
      "Pflegekasse Name": "AOK",
      "IK": "123456789",
      "Versichertennummer": "X1",
      "Pflegegrad": "3",
    }]);

    const previewRes = await uploadExcelPreview(buffer);
    expect(previewRes.status).toBe(200);
    const rows = previewRes.data?.rows ?? [];
    const ourRow = rows.find((r: any) =>
      r.customerId === cid &&
      String(r.date).startsWith(importDate),
    );
    expect(ourRow).toBeDefined();
    expect(ourRow.errors).toEqual([]);
    // Kernassertion: keine Kürzung — Carryover + Monatscap reichen für 60 Min.
    expect(ourRow.budgetTrimInfo).toBeFalsy();
    expect(ourRow.durationMinutes).toBe(60);

    try { await apiDeleteRaw(`/api/customers/${cid}`); } catch {}
  }, 30000);

  it("INT-116.3 – Reconcile-Skript ist idempotent (zweiter Lauf erzeugt keine zusätzlichen Storni/Buchungen)", async () => {
    const { reconcileCustomer } = await import("../server/scripts/reconcile-trimmed-imports");
    const { db } = await import("../server/lib/db");
    const { budgetTransactions, appointments: apptsTable, appointmentServices, services } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");

    const created = await createTestCustomer({
      vorname: "Idem",
      nachname: `Reconcile-${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    const cid = created.id as number;
    await apiPatch(`/api/admin/customers/${cid}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    // §45b mit Monatscap + Carryover, sodass volle Wiederherstellung möglich ist.
    await apiPut(`/api/budget/${cid}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 13100 },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
    const year = new Date().getFullYear();
    await apiPost(`/api/budget/${cid}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentYearAmountCents: 0,
      carryoverAmountCents: 50000,
      budgetStartDate: `${year}-01-01`,
    });

    // Synthetischen "wrongly-trimmed" Import-Termin direkt einfügen:
    //   Original 60 Min, fälschlich auf 30 gekürzt, Notes-Pattern erforderlich.
    const importDate = `${year}-02-15`;
    const [appt] = await db.insert(apptsTable).values({
      customerId: cid,
      assignedEmployeeId: auth.user.id,
      performedByEmployeeId: auth.user.id,
      appointmentType: "Kundentermin",
      serviceType: "Alltagsbegleitung",
      date: importDate,
      scheduledStart: "09:00",
      scheduledEnd: "10:00",
      durationPromised: 30,
      status: "completed",
      actualStart: "09:00",
      actualEnd: "09:30",
      notes: "Import aus Altdaten — Budget gekürzt: 60 → 30 Min",
      isFahrtdienst: false,
      travelKilometers: 0,
      customerKilometers: 0,
    }).returning();

    const [abService] = await db.select().from(services).where(eq(services.code, "alltagsbegleitung")).limit(1);
    expect(abService).toBeDefined();

    await db.insert(appointmentServices).values({
      appointmentId: appt.id,
      serviceId: abService.id,
      plannedDurationMinutes: 30,
      actualDurationMinutes: 30,
    });

    // Synthetische gekürzte Consumption-Buchung für die 30 Min.
    await db.insert(budgetTransactions).values({
      customerId: cid,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: importDate,
      transactionType: "consumption",
      amountCents: 1800, // ~30 Min Alltagsbegleitung — exakter Betrag irrelevant für Idempotenz
      appointmentId: appt.id,
      notes: "Synth Import-Buchung (Test)",
    });

    // Lauf 1 — soll wiederherstellen.
    const run1 = await reconcileCustomer(cid, true);
    expect(run1.restored).toBe(1);

    const txAfter1 = await db.select().from(budgetTransactions).where(eq(budgetTransactions.customerId, cid));
    const reversals1 = txAfter1.filter(t => t.transactionType === "reversal");
    const consumptions1 = txAfter1.filter(t => t.transactionType === "consumption");
    expect(reversals1.length).toBeGreaterThanOrEqual(1);

    const [apptAfter1] = await db.select().from(apptsTable).where(eq(apptsTable.id, appt.id)).limit(1);
    expect(apptAfter1.durationPromised).toBe(60);
    expect(apptAfter1.notes).toContain("Reconciled #116");

    // Lauf 2 — muss No-Op sein (Marker schließt Kandidaten aus).
    const run2 = await reconcileCustomer(cid, true);
    expect(run2.restored).toBe(0);
    expect(run2.insufficient).toBe(0);

    const txAfter2 = await db.select().from(budgetTransactions).where(eq(budgetTransactions.customerId, cid));
    const reversals2 = txAfter2.filter(t => t.transactionType === "reversal");
    const consumptions2 = txAfter2.filter(t => t.transactionType === "consumption");
    expect(reversals2.length).toBe(reversals1.length);
    expect(consumptions2.length).toBe(consumptions1.length);

    try { await apiDeleteRaw(`/api/customers/${cid}`); } catch {}
  }, 30000);

  afterAll(async () => {
    try { await apiDeleteRaw(`/api/customers/${customerId}`); } catch {}
  });
});
