// K1 Cross-Customer Race-Test: Zwei parallele billing/generate-Aufrufe für
// unterschiedliche Customers im selben Monat dürfen nie zur selben
// Rechnungsnummer führen. Sicherung läuft über `pg_advisory_xact_lock` in
// `getNextInvoiceNumberTx` (server/storage/billing-storage.ts).

import { describe, it, expect, afterAll } from "vitest";
import { apiPost, apiDelete, uniqueId } from "../test-utils";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { runInParallel } from "../helpers/race";
import { db } from "../../server/lib/db";
import { invoices } from "../../shared/schema";
import { and, eq, inArray } from "drizzle-orm";

interface InvoiceLite {
  id: number;
  invoiceNumber: string;
  customerId: number;
}

interface GenerateResponse {
  splitInvoices?: boolean;
  invoices?: InvoiceLite[];
  id?: number;
  invoiceNumber?: string;
  customerId?: number;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shiftToWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}

function previousMonthWeekday(dayHint: number): { date: string; year: number; month: number } {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, dayHint);
  shiftToWeekday(d);
  return { date: ymd(d), year: d.getFullYear(), month: d.getMonth() + 1 };
}

interface PreparedCustomer {
  scenario: BudgetScenarioHandle;
  customerId: number;
  serviceRecordId: number;
  year: number;
  month: number;
}

async function prepareCustomer(
  tag: string,
  slot: { date: string; year: number; month: number; time: string },
): Promise<PreparedCustomer> {
  const scenario = await setupBudgetScenario({
    customerNamePrefix: `RACE-K1-${tag}`,
    pflegegrad: 2,
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
    types: [
      { type: "entlastungsbetrag_45b", enabled: false, priority: 1 },
    ],
    appointments: [
      {
        date: slot.date,
        scheduledStart: slot.time,
        services: [{ code: "hauswirtschaft", durationMinutes: 30 }],
        document: true,
        notes: `RACE-K1-${tag}-${uniqueId()}`,
        actualStart: slot.time,
        travelKilometers: 0,
        customerKilometers: 0,
      },
    ],
  });

  const srRes = await apiPost<{ id: number }>("/api/service-records", {
    customerId: scenario.customerId,
    employeeId: scenario.employeeId,
    year: slot.year,
    month: slot.month,
  });
  if (srRes.status !== 201) {
    throw new Error(
      `prepareCustomer(${tag}): service-record create failed: ${srRes.status} ${JSON.stringify(srRes.data)}`,
    );
  }
  const srId = srRes.data.id;
  for (const signerType of ["employee", "customer"] as const) {
    const signRes = await apiPost(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    if (signRes.status !== 200) {
      throw new Error(
        `prepareCustomer(${tag}): sign ${signerType} failed: ${signRes.status} ${JSON.stringify(signRes.data)}`,
      );
    }
  }

  return {
    scenario,
    customerId: scenario.customerId,
    serviceRecordId: srId,
    year: slot.year,
    month: slot.month,
  };
}

const cleanupInvoiceIds: number[] = [];
const cleanupServiceRecordIds: number[] = [];
const scenariosToCleanup: BudgetScenarioHandle[] = [];

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    try { await apiDelete(`/api/billing/${id}`); } catch { /* ignore */ }
  }
  for (const id of cleanupServiceRecordIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch { /* ignore */ }
  }
  for (const scenario of scenariosToCleanup) {
    try { await scenario.cleanup(); } catch { /* ignore */ }
  }
});

describe("K1: Cross-Customer Race auf Rechnungsnummern", () => {
  it("K1.1 — zwei parallele POST /api/billing/generate für unterschiedliche Customers im selben Monat erhalten zwei unterschiedliche, persistierte Rechnungsnummern", async () => {
    // Beide Customers liegen im selben Vormonat (gleiches billingYear/Month),
    // damit beide gegen dasselbe `invoice_number_<year>` Advisory-Lock laufen.
    const slotA = { ...previousMonthWeekday(10), time: "09:00" };
    const slotB = { ...previousMonthWeekday(15), time: "10:00" };
    // Sicherheits-Check: Beide Termine müssen im selben Monat/Jahr liegen.
    expect(slotA.year, "Slots müssen im selben Vormonat-Jahr liegen").toBe(slotB.year);
    expect(slotA.month, "Slots müssen im selben Vormonat-Monat liegen").toBe(slotB.month);

    const prepA = await prepareCustomer("A", slotA);
    cleanupServiceRecordIds.push(prepA.serviceRecordId);
    scenariosToCleanup.push(prepA.scenario);

    const prepB = await prepareCustomer("B", slotB);
    cleanupServiceRecordIds.push(prepB.serviceRecordId);
    scenariosToCleanup.push(prepB.scenario);

    const billingYear = prepA.year;
    const billingMonth = prepA.month;

    type GenResult = { status: number; data: GenerateResponse | InvoiceLite };
    const settled = await runInParallel<GenResult>([
      () =>
        apiPost<GenerateResponse | InvoiceLite>("/api/billing/generate", {
          customerId: prepA.customerId,
          billingMonth,
          billingYear,
        }),
      () =>
        apiPost<GenerateResponse | InvoiceLite>("/api/billing/generate", {
          customerId: prepB.customerId,
          billingMonth,
          billingYear,
        }),
    ]);

    // Assertion 1: beide fulfilled (HTTP 200/201), keine 5xx.
    for (let i = 0; i < settled.length; i++) {
      expect(settled[i].status, `Call #${i} muss fulfillen`).toBe("fulfilled");
    }
    const responses = settled
      .filter((r): r is PromiseFulfilledResult<GenResult> => r.status === "fulfilled")
      .map((r) => r.value);
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      expect(
        r.status === 200 || r.status === 201,
        `Call #${i} muss 200/201 liefern, war ${r.status}: ${JSON.stringify(r.data)}`,
      ).toBe(true);
    }

    function pickInvoice(data: GenerateResponse | InvoiceLite): InvoiceLite {
      const gd = data as GenerateResponse;
      if (gd.splitInvoices && gd.invoices && gd.invoices.length > 0) {
        // Bei Splits sammeln wir alle für Cleanup, nehmen aber die erste
        // für den Nummer-Vergleich (Cross-Customer-Aspekt bleibt valide,
        // da keine zwei Customer dieselbe Nummer bekommen dürfen).
        for (const extra of gd.invoices.slice(1)) cleanupInvoiceIds.push(extra.id);
        return gd.invoices[0];
      }
      return data as InvoiceLite;
    }

    const invA = pickInvoice(responses[0].data);
    const invB = pickInvoice(responses[1].data);
    cleanupInvoiceIds.push(invA.id, invB.id);

    // Assertion 2: Die beiden Rechnungsnummern unterscheiden sich.
    expect(
      invA.invoiceNumber,
      `Cross-Customer-Race: invoiceNumber A muss ≠ invoiceNumber B sein (A=${invA.invoiceNumber}, B=${invB.invoiceNumber})`,
    ).not.toBe(invB.invoiceNumber);

    // Assertion 3: DB-Check — exakt 2 Rows mit diesen Nummern im selben Jahr.
    const dbRows = await db
      .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(
        and(
          eq(invoices.billingYear, billingYear),
          inArray(invoices.invoiceNumber, [invA.invoiceNumber, invB.invoiceNumber]),
        ),
      );
    expect(
      dbRows.length,
      `Erwarte exakt 2 persistierte Rechnungen mit Nummern [${invA.invoiceNumber}, ${invB.invoiceNumber}] in Jahr ${billingYear}, fand: ${JSON.stringify(dbRows)}`,
    ).toBe(2);
    const persistedNumbers = new Set(dbRows.map((r) => r.invoiceNumber));
    expect(persistedNumbers.size, "Beide DB-Rows müssen verschiedene Nummern haben").toBe(2);
  }, 120_000);
});
