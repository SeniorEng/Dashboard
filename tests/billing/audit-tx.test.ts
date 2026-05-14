/**
 * Task #444 — Transaktions-bewusster Audit-Wrapper (Pilot Billing)
 *
 * Verifiziert für jede mutierende Billing-Route:
 *   1. Genau ein audit_log-Eintrag pro Mutation mit passender entity_id.
 *   2. Bei künstlich erzwungenem Audit-Fehler (Header x-test-inject-fault:
 *      audit_log) wird die Mutation gerollback — d.h. KEIN audit_log und
 *      KEINE persistente Status-/Insert-Wirkung.
 *
 * Fault-Injection ist nur in NODE_ENV=test aktiv (server/lib/test-fault-injector).
 *
 * Coverage:
 *   - POST /api/billing/generate       → invoice_created
 *   - PATCH /api/billing/:id/status    → invoice_cancelled (Storno)
 *
 * Für POST /api/billing/:id/send und POST /api/billing/send-batch wäre eine
 * Integrationsabdeckung sehr teuer (echte PDF/Email-Pipeline). Die generische
 * Rollback-Garantie des Wrappers wird daher zusätzlich auf Wrapper-Ebene
 * über `tests/with-audit-rollback.test.ts` direkt gegen die DB validiert —
 * /send und /send-batch nutzen exakt denselben `withAudit`-Mechanismus mit
 * `readTestFaults(req)`, sodass die Rollback-Semantik dort identisch greift.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  runCleanup,
} from "../test-utils";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { db } from "../../server/lib/db";
import { sql } from "drizzle-orm";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

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
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}

async function countAuditEntries(action: string, entityId: number): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM audit_log
    WHERE action = ${action}
      AND entity_type = 'invoice'
      AND entity_id = ${entityId}
  `);
  return (res.rows[0] as { count: number }).count;
}

async function apiPostWithFault<T = unknown>(
  path: string,
  body: unknown,
  fault: string,
): Promise<{ status: number; data: T }> {
  const auth = await getAuthCookie();
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
      "x-test-inject-fault": fault,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

async function apiPatchWithFault<T = unknown>(
  path: string,
  body: unknown,
  fault: string,
): Promise<{ status: number; data: T }> {
  const auth = await getAuthCookie();
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
      "x-test-inject-fault": fault,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

let scenarioA: BudgetScenarioHandle;
let scenarioB: BudgetScenarioHandle;
const cleanupSrIds: number[] = [];
let createdInvoiceIdA = 0;
let createdInvoiceIdB = 0;

async function createSignedSr(scenario: BudgetScenarioHandle): Promise<{ year: number; month: number }> {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const srRes = await apiPost<any>("/api/service-records", {
    customerId: scenario.customerId,
    employeeId: scenario.employeeId,
    year,
    month,
  });
  expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
  cleanupSrIds.push(srRes.data.id);
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost<any>(`/api/service-records/${srRes.data.id}/sign`, {
      signerType,
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(sig.status).toBe(200);
  }
  return { year, month };
}

beforeAll(async () => {
  await getAuthCookie();
  const apptDate = weekdayInCurrentMonth();
  const baseSpec = {
    pflegegrad: 3 as const,
    billingType: "selbstzahler" as const,
    acceptsPrivatePayment: false,
    types: [
      { type: "entlastungsbetrag_45b" as const, priority: 1, enabled: true, monthlyLimitCents: null },
      { type: "umwandlung_45a" as const, priority: 2, enabled: false, monthlyLimitCents: null },
      { type: "ersatzpflege_39_42a" as const, priority: 3, enabled: false, yearlyLimitCents: null },
    ],
    appointments: [
      {
        date: apptDate,
        scheduledStart: "01:00",
        services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
        document: true,
        actualStart: "01:00",
      },
    ],
  };
  scenarioA = await setupBudgetScenario({ ...baseSpec, customerNamePrefix: "Auto_T444A" });
  scenarioB = await setupBudgetScenario({ ...baseSpec, customerNamePrefix: "Auto_T444B" });
});

afterAll(async () => {
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  if (scenarioA) await scenarioA.cleanup();
  if (scenarioB) await scenarioB.cleanup();
  await runCleanup();
});

describe("Task #444 — Audit-Wrapper für Billing", () => {
  it("invoice_created: genau ein audit_log-Eintrag pro generierter Rechnung", async () => {
    const { year, month } = await createSignedSr(scenarioA);

    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId: scenarioA.customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);

    const invoices: any[] = genRes.data?.splitInvoices ? genRes.data.invoices : [genRes.data];
    expect(invoices.length).toBeGreaterThan(0);
    for (const inv of invoices) {
      const count = await countAuditEntries("invoice_created", inv.id);
      expect(count, `Genau ein invoice_created-Audit für Rechnung ${inv.id}`).toBe(1);
    }
    createdInvoiceIdA = invoices[0].id;
  });

  it("fault audit_log → /generate rollback: keine Rechnung, kein Audit", async () => {
    const { year, month } = await createSignedSr(scenarioB);

    const beforeRows = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM invoices WHERE customer_id = ${scenarioB.customerId}
    `);
    const beforeInvoiceCount = (beforeRows.rows[0] as { count: number }).count;

    const faultRes = await apiPostWithFault<any>(
      "/api/billing/generate",
      {
        customerId: scenarioB.customerId,
        billingMonth: month,
        billingYear: year,
      },
      "audit_log",
    );
    expect(faultRes.status, `fault generate: ${JSON.stringify(faultRes.data)}`).toBeGreaterThanOrEqual(500);

    const afterRows = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM invoices WHERE customer_id = ${scenarioB.customerId}
    `);
    const afterInvoiceCount = (afterRows.rows[0] as { count: number }).count;
    expect(
      afterInvoiceCount,
      "Bei Audit-Fehler darf KEINE Rechnung committet sein (Tx-Rollback)",
    ).toBe(beforeInvoiceCount);

    // Recovery — regulärer Aufruf MUSS funktionieren.
    const okRes = await apiPost<any>("/api/billing/generate", {
      customerId: scenarioB.customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(okRes.status, `recovery generate: ${JSON.stringify(okRes.data)}`).toBe(200);
    const invoices: any[] = okRes.data?.splitInvoices ? okRes.data.invoices : [okRes.data];
    for (const inv of invoices) {
      const count = await countAuditEntries("invoice_created", inv.id);
      expect(count).toBe(1);
    }
    createdInvoiceIdB = invoices[0].id;
  });

  it("fault audit_log → /:id/status storno rollback: kein Status-Wechsel, kein Audit", async () => {
    expect(createdInvoiceIdA, "Rechnung aus Test 1 muss vorliegen").toBeGreaterThan(0);

    // Snapshot Status.
    const before = await apiGet<any>(`/api/billing/${createdInvoiceIdA}`);
    expect(before.status).toBe(200);
    expect(before.data.status).toBe("entwurf");

    const faultRes = await apiPatchWithFault<any>(
      `/api/billing/${createdInvoiceIdA}/status`,
      { status: "storniert" },
      "audit_log",
    );
    expect(faultRes.status).toBeGreaterThanOrEqual(500);

    const after = await apiGet<any>(`/api/billing/${createdInvoiceIdA}`);
    expect(after.status).toBe(200);
    expect(
      after.data.status,
      "Bei Audit-Fehler darf der Status nicht auf 'storniert' wechseln",
    ).toBe("entwurf");

    const cancelCount = await countAuditEntries("invoice_cancelled", createdInvoiceIdA);
    expect(cancelCount, "Bei Audit-Fehler darf KEIN invoice_cancelled-Audit existieren").toBe(0);
  });

  it("invoice_cancelled: erfolgreicher Storno schreibt genau einen audit_log-Eintrag", async () => {
    expect(createdInvoiceIdA).toBeGreaterThan(0);
    const stornoRes = await apiPatch<any>(`/api/billing/${createdInvoiceIdA}/status`, {
      status: "storniert",
    });
    expect(stornoRes.status, `storno: ${JSON.stringify(stornoRes.data)}`).toBe(200);

    const cancelCount = await countAuditEntries("invoice_cancelled", createdInvoiceIdA);
    expect(cancelCount, "Genau ein invoice_cancelled-Audit für stornierte Rechnung").toBe(1);
  });

  it("invoice_status_changed: Nicht-Storno-Übergang (entwurf → versendet) schreibt genau einen Audit", async () => {
    expect(createdInvoiceIdB, "Recovery-Rechnung aus Test 2 muss vorliegen").toBeGreaterThan(0);

    const patchRes = await apiPatch<any>(`/api/billing/${createdInvoiceIdB}/status`, {
      status: "versendet",
    });
    expect(patchRes.status, `status patch: ${JSON.stringify(patchRes.data)}`).toBe(200);
    expect(patchRes.data.status).toBe("versendet");

    const count = await countAuditEntries("invoice_status_changed", createdInvoiceIdB);
    expect(count, "Genau ein invoice_status_changed-Audit pro Nicht-Storno-Übergang").toBe(1);
  });

  it("fault audit_log → Nicht-Storno-Statuswechsel rollback: kein Wechsel, kein Audit", async () => {
    expect(createdInvoiceIdB).toBeGreaterThan(0);
    // createdInvoiceIdB ist nach vorherigem Test in 'versendet' → erlaubt nun
    // 'bezahlt' oder 'storniert'. Wir testen den 'bezahlt'-Übergang mit Fault.
    const before = await apiGet<any>(`/api/billing/${createdInvoiceIdB}`);
    expect(before.status).toBe(200);
    expect(before.data.status).toBe("versendet");
    const beforeAudit = await countAuditEntries("invoice_status_changed", createdInvoiceIdB);

    const faultRes = await apiPatchWithFault<any>(
      `/api/billing/${createdInvoiceIdB}/status`,
      { status: "bezahlt" },
      "audit_log",
    );
    expect(faultRes.status).toBeGreaterThanOrEqual(500);

    const after = await apiGet<any>(`/api/billing/${createdInvoiceIdB}`);
    expect(after.status).toBe(200);
    expect(
      after.data.status,
      "Bei Audit-Fehler darf der Status nicht auf 'bezahlt' wechseln",
    ).toBe("versendet");
    const afterAudit = await countAuditEntries("invoice_status_changed", createdInvoiceIdB);
    expect(afterAudit, "Kein neuer invoice_status_changed-Audit bei Rollback").toBe(beforeAudit);
  });
});
