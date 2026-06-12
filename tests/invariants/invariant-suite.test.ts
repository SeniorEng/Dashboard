/**
 * Task #1237 (Phase 0.1) — CI-Integrationstest der read-only Invarianten-Suite.
 *
 * Die Suite läuft gegen die GETEILTE Worker-DB (mehrere Test-Dateien teilen sich
 * eine Wegwerf-DB). Globale `suite.ok`-Aussagen sind deshalb VERBOTEN — andere
 * Dateien können Daten hinterlassen. Alle Assertions filtern strikt auf die
 * EIGENEN Kunden-IDs bzw. ein einzigartiges Abrechnungsjahr.
 *
 * Enthält bewusst einen SELBST-GEBAUTEN kaputten Ledger-Zustand (Über-Storno +
 * baumelnde Storno-Referenz), der beweist, dass Check 1 (Storno-Ketten-Layer)
 * anschlägt — und zwar GENAU dort, wo der No-Overdraw-Clamp (Layer 1) die
 * Verletzung verschluckt.
 */
import { describe, it, expect, afterAll } from "vitest";
import { db } from "../../server/lib/db";
import {
  appointments,
  budgetAllocations,
  budgetTransactions,
} from "@shared/schema";
import {
  checkBudgetLedgerConsistency,
  checkBookingCompleteness,
} from "../../server/lib/invariants";
import {
  createTestCustomer,
  cleanupCustomer,
  getAuthCookie,
  apiGetAs,
} from "../test-utils";

const CURRENT_YEAR = new Date().getFullYear();
const VALID_FROM = `${CURRENT_YEAR}-01-01`;

function getTodayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function seed45bAllocation(
  customerId: number,
  amountCents: number,
): Promise<number> {
  const [row] = await db
    .insert(budgetAllocations)
    .values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: CURRENT_YEAR,
      month: null,
      amountCents,
      source: "manual_adjustment",
      validFrom: VALID_FROM,
    })
    .returning({ id: budgetAllocations.id });
  return row.id;
}

async function seedAppointment(customerId: number): Promise<number> {
  const [row] = await db
    .insert(appointments)
    .values({
      customerId,
      appointmentType: "kundentermin",
      date: getTodayIso(),
      scheduledStart: "08:00:00",
      durationPromised: 60,
      status: "scheduled",
    })
    .returning({ id: appointments.id });
  return row.id;
}

async function seedConsumption(opts: {
  customerId: number;
  allocationId: number;
  appointmentId: number;
  amountCents: number;
  hauswirtschaftCents: number;
}): Promise<number> {
  const [row] = await db
    .insert(budgetTransactions)
    .values({
      customerId: opts.customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: getTodayIso(),
      transactionType: "consumption",
      amountCents: opts.amountCents,
      hauswirtschaftCents: opts.hauswirtschaftCents,
      allocationId: opts.allocationId,
      appointmentId: opts.appointmentId,
    })
    .returning({ id: budgetTransactions.id });
  return row.id;
}

async function seedReversal(opts: {
  customerId: number;
  appointmentId: number;
  amountCents: number;
  reversedTransactionId: number | null;
}): Promise<number> {
  const [row] = await db
    .insert(budgetTransactions)
    .values({
      customerId: opts.customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: getTodayIso(),
      transactionType: "reversal",
      amountCents: opts.amountCents,
      appointmentId: opts.appointmentId,
      reversedTransactionId: opts.reversedTransactionId,
    })
    .returning({ id: budgetTransactions.id });
  return row.id;
}

describe("Invarianten-Suite (Task #1237)", () => {
  const customerIds: number[] = [];

  afterAll(async () => {
    for (const id of customerIds) {
      await cleanupCustomer(id);
    }
  });

  it("flaggt einen sauberen Kunden (Konsum + voller Storno) NICHT", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id);

    const allocId = await seed45bAllocation(customer.id, 13100);
    const apptId = await seedAppointment(customer.id);
    const consId = await seedConsumption({
      customerId: customer.id,
      allocationId: allocId,
      appointmentId: apptId,
      amountCents: -5000,
      hauswirtschaftCents: 5000,
    });
    await seedReversal({
      customerId: customer.id,
      appointmentId: apptId,
      amountCents: 5000,
      reversedTransactionId: consId,
    });

    const ledger = await checkBudgetLedgerConsistency(db);
    const booking = await checkBookingCompleteness(db);

    const prefix = `${customer.id}|`;
    expect(
      ledger.conservation.overdrawnKeys.filter((k) => k.startsWith(prefix)),
    ).toEqual([]);
    expect(
      ledger.reversalChain.violations.filter(
        (v) => v.customerId === customer.id,
      ),
    ).toEqual([]);
    expect(
      ledger.fifoUnified.violations.filter((v) => v.customerId === customer.id),
    ).toEqual([]);

    expect(
      booking.legSumMismatches.filter((v) => v.customerId === customer.id),
    ).toEqual([]);
    expect(
      booking.overReversedAppointments.filter(
        (v) => v.customerId === customer.id,
      ),
    ).toEqual([]);
    expect(
      booking.orphanConsumptions.filter((v) => v.customerId === customer.id),
    ).toEqual([]);
  });

  it("flaggt einen KAPUTTEN Ledger (Über-Storno + baumelnde Referenz), den der No-Overdraw-Clamp verschluckt", async () => {
    const customer = await createTestCustomer();
    customerIds.push(customer.id);

    const allocId = await seed45bAllocation(customer.id, 13100);
    const apptId = await seedAppointment(customer.id);
    const consId = await seedConsumption({
      customerId: customer.id,
      allocationId: allocId,
      appointmentId: apptId,
      amountCents: -5000,
      hauswirtschaftCents: 5000,
    });
    // Über-Storno: storniert 9000 Cent, das Original hatte nur 5000.
    await seedReversal({
      customerId: customer.id,
      appointmentId: apptId,
      amountCents: 9000,
      reversedTransactionId: consId,
    });
    // Baumelnde Referenz: zeigt auf eine nicht existierende Transaktion.
    // appointment_id ist wegen des CHECK-Constraints (Task #819) Pflicht.
    await seedReversal({
      customerId: customer.id,
      appointmentId: apptId,
      amountCents: 1000,
      reversedTransactionId: 999_999_999,
    });

    const ledger = await checkBudgetLedgerConsistency(db);

    const ownReversalViolations = ledger.reversalChain.violations.filter(
      (v) => v.customerId === customer.id,
    );
    const reasons = ownReversalViolations.map((v) => v.reason);

    // Check 1 (Storno-Ketten-Layer) MUSS anschlagen.
    expect(reasons).toContain("over_reversal");
    expect(reasons).toContain("dangling");
    expect(ownReversalViolations.length).toBeGreaterThanOrEqual(2);

    // ...obwohl der No-Overdraw-Clamp (Layer 1) den Topf für GRÜN hält:
    // netto verbraucht = max(0, 5000 - (9000 + 1000)) = 0 <= 13100.
    expect(
      ledger.conservation.overdrawnKeys.filter((k) =>
        k.startsWith(`${customer.id}|`),
      ),
    ).toEqual([]);

    // Globaler Suite-Status ist damit insgesamt nicht mehr „ok".
    expect(ledger.ok).toBe(false);
  });

  it("liefert über GET /api/admin/invariants-report einen wohlgeformten Report (SuperAdmin)", async () => {
    const auth = await getAuthCookie();
    const res = await apiGetAs<{
      ok: boolean;
      generatedAt: string;
      budgetLedger: { violationCount: number };
      bookingCompleteness: { violationCount: number };
      invoiceNumbering: { violationCount: number };
      totalViolations: number;
    }>(auth, "/api/admin/invariants-report");

    expect(res.status).toBe(200);
    expect(typeof res.data.ok).toBe("boolean");
    expect(typeof res.data.generatedAt).toBe("string");
    expect(typeof res.data.budgetLedger.violationCount).toBe("number");
    expect(typeof res.data.bookingCompleteness.violationCount).toBe("number");
    expect(typeof res.data.invoiceNumbering.violationCount).toBe("number");
    expect(typeof res.data.totalViolations).toBe("number");
  });
});
