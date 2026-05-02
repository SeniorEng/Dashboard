import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, budgetTransactions, appointments } from "@shared/schema";
import { processExpiredCarryover } from "../../server/storage/budget/allocation-storage";
import { freezeTime, thawTime } from "../helpers/frozen-clock";
import { parseLocalDate, formatDateISO, addDays } from "@shared/utils/datetime";
import { apiPut, createTestCustomer, getAuthCookie } from "../test-utils";

// Ein deterministisches Setup verlangt eine bekannte Zeitzone. Berlin ist die
// Produktions-Zeitzone des Pflegedienstes; ohne diesen Override wäre der Test
// unter UTC-Hosts (z.B. CI-Container) wertlos, weil die Datums-Vergleiche in
// `todayISO()` (lokale Mitternacht) andere Ergebnisse liefern würden.
const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "Europe/Berlin";
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

async function seedCarryoverCustomer(amountCents: number): Promise<number> {
  const customer = await createTestCustomer({
    vorname: "TZ",
    nachname: `Carryover_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const customerId = customer.id as number;

  // Nur §45b aktiv — andere Budget-Töpfe würden den Cascade-Pfad triggern,
  // und das ist für den Verfalls-Test irrelevant.
  await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
  });

  // Direkter DB-Insert: minimaler Setup ohne Umweg über `ensureYearlyCarryover45b`.
  // Wir kontrollieren `expiresAt` explizit auf 2026-06-30, sodass die beiden
  // Berlin-zeitlichen Cases (23:30 vs. 00:30 am Tageswechsel) klar trennen.
  await db.insert(budgetAllocations).values({
    customerId,
    budgetType: "entlastungsbetrag_45b",
    year: 2025,
    month: null,
    amountCents,
    source: "carryover",
    validFrom: "2026-01-01",
    expiresAt: "2026-06-30",
    notes: "TZ-Test Carryover",
  });

  return customerId;
}

describe("Budget-Timezone — §45b-Carryover-Verfall und DST-Termin-Anlage (Berlin TZ)", () => {
  it("TZ-SANITY — Berlin-Sommerzeit-Offset ist +02:00 (-120 Min) – ohne diesen Sanity-Check wären alle weiteren Cases ungültig", () => {
    const offsetMin = new Date("2026-07-01T00:00:00Z").getTimezoneOffset();
    expect(offsetMin).toBe(-120);
  });

  it("TZ-CASE-1 — 30.06. 23:30 Berlin: Carryover noch gültig → KEIN Write-Off", async () => {
    const customerId = await seedCarryoverCustomer(50000);

    freezeTime("2026-06-30T23:30:00+02:00");
    const created = await processExpiredCarryover(customerId);
    thawTime();

    expect(created).toEqual([]);

    const txs = await db
      .select()
      .from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId));
    expect(txs.filter((t) => t.transactionType === "write_off")).toHaveLength(0);
  });

  it("TZ-CASE-2 — 01.07. 00:30 Berlin: Carryover abgelaufen → EIN Write-Off mit Restbetrag", async () => {
    const customerId = await seedCarryoverCustomer(50000);

    freezeTime("2026-07-01T00:30:00+02:00");
    const created = await processExpiredCarryover(customerId);
    thawTime();

    expect(created).toHaveLength(1);
    expect(created[0].transactionType).toBe("write_off");
    expect(created[0].amountCents).toBe(-50000);
    expect(created[0].budgetType).toBe("entlastungsbetrag_45b");
    expect(created[0].transactionDate).toBe("2026-06-30");

    const persisted = await db
      .select()
      .from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId));
    const writeOffs = persisted.filter((t) => t.transactionType === "write_off");
    expect(writeOffs).toHaveLength(1);
    expect(writeOffs[0].amountCents).toBe(-50000);
  });

  it("TZ-CASE-3 — DST-Übergang 29.03.2026 02:30 Berlin: Termin-Datum bleibt 2026-03-29 (kein UTC-Shift auf 28.03.)", async () => {
    const auth = await getAuthCookie();

    // Reine Utility-Roundtrips müssen am DST-Tag stabil bleiben. Genau dieser
    // Pfad würde nach einem späteren `parseLocalDate`-Refactor erneut grün
    // bleiben — bzw. einen Regress sofort sichtbar machen.
    expect(formatDateISO(parseLocalDate("2026-03-29"))).toBe("2026-03-29");
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");

    const customer = await createTestCustomer({
      vorname: "TZ",
      nachname: `DST_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      pflegegrad: 3,
      acceptsPrivatePayment: true,
    });
    const customerId = customer.id as number;

    freezeTime("2026-03-29T02:30:00+01:00");
    try {
      const inserted = await db
        .insert(appointments)
        .values({
          customerId,
          appointmentType: "kundentermin",
          date: "2026-03-29",
          scheduledStart: "09:00",
          durationPromised: 60,
          status: "scheduled",
          createdByUserId: auth.user.id,
          assignedEmployeeId: auth.user.id,
        })
        .returning();

      expect(inserted).toHaveLength(1);

      const reread = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, inserted[0].id));
      expect(reread).toHaveLength(1);
      expect(reread[0].date).toBe("2026-03-29");
    } finally {
      thawTime();
    }
  });
});
