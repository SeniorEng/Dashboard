import { describe, it, expect, beforeAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  getAuthCookie,
  createTestCustomer,
} from "./test-utils";
import { db } from "../server/lib/db";
import {
  budgetAllocations,
  budgetTransactions,
} from "@shared/schema";
import { createConsumptionTransaction } from "../server/storage/budget/consumption-engine";
import { syncCarryoverAndExpiry } from "../server/storage/budget/allocation-storage";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;

function shiftWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = services.data.find((s: any) => s.code === "hauswirtschaft")!.id;
});

describe("BC-K4: Advisory-Lock serialisiert parallele Konsumbuchungen", () => {
  it("BC-K4.1 — 5 parallele Buchungen je 30 € bei 100 € Budget (acceptsPrivatePayment=false): max 100 € verbraucht, mind. 1 Ablehnung", async () => {
    // Frischer Kunde: kein bestehender Verbrauch, keine alten Allokationen.
    const customer = await createTestCustomer({
      vorname: "Konkurrenz",
      nachname: `Lock-K4-${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = customer.id as number;

    await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    // Nur §45b aktiv — kein Cascade in §45a/§39 möglich.
    await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });

    // Klar definiertes Budget: genau 100 € als initial_balance, ab heute gültig,
    // ohne Verfall — überschreibt die monatliche §45b-Berechnung nicht, addiert
    // sich aber auf, also nutzen wir manual_adjustment, das überschaubar ist.
    const today = new Date();
    const todayIso = today.toISOString().split("T")[0];
    const yyyymm = todayIso.substring(0, 7);

    // Damit nicht zusätzlich monatliche §45b-Allokationen entstehen, setzen wir
    // budgetStartDate weit in die Zukunft. Die manual_adjustment-Allokation
    // bleibt aktiv, weil source='manual_adjustment' unabhängig vom Startdatum
    // gezählt wird (siehe consumeFifo special allocations).
    await apiPut(`/api/budget/${customerId}/preferences`, {
      customerId,
      budgetStartDate: "2099-01-01",
      monthlyLimitCents: null,
    });

    // Direkter DB-Insert einer manual_adjustment-Allokation = 100 €.
    await db.insert(budgetAllocations).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: today.getFullYear(),
      month: today.getMonth() + 1,
      amountCents: 10000,
      source: "manual_adjustment",
      validFrom: `${yyyymm}-01`,
      expiresAt: null,
      notes: "BC-K4 Testbudget 100 €",
    });

    // 5 disjunkte Termine in der Vergangenheit. Wir buchen 60 Min HW pro
    // Termin — bei §45b-Stundensatz reicht 100 € nur für 2 (max. 3) Termine,
    // sodass der Lock-Test eine echte Ablehnung erzwingt.
    const services = [{ serviceId: hwServiceId, durationMinutes: 60 }];
    const appointmentIds: number[] = [];

    const slotTimes = ["08:00", "09:30", "11:00", "12:30", "14:00"];
    let dayOffset = 2;
    while (appointmentIds.length < 5 && dayOffset < 60) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() - dayOffset);
      shiftWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];

      for (const time of slotTimes) {
        if (appointmentIds.length >= 5) break;
        const res = await apiPost<any>("/api/appointments/kundentermin", {
          customerId,
          date: dateStr,
          scheduledStart: time,
          notes: `BC-K4 Slot ${appointmentIds.length}`,
          assignedEmployeeId: auth.user.id,
          services,
        });
        if (res.status === 201) appointmentIds.push(res.data.id);
      }
      dayOffset++;
    }
    expect(appointmentIds.length).toBe(5);

    // Kosten pro Buchung: 60 Minuten Hauswirtschaft. Wir lesen sie über die
    // cost-estimate-API, damit wir die exakte cents-Zahl haben.
    const aDate = (await apiGet<any>(`/api/appointments/${appointmentIds[0]}`)).data.date;
    const estimate = await apiGet<any>(
      `/api/budget/${customerId}/cost-estimate?date=${aDate}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    const costPerBooking = estimate.data.totalCents as number;
    expect(costPerBooking).toBeGreaterThan(0);

    // Wie viele Buchungen passen genau in 10000 cents hinein?
    const expectedSuccesses = Math.floor(10000 / costPerBooking);
    expect(expectedSuccesses).toBeGreaterThanOrEqual(1);
    expect(expectedSuccesses).toBeLessThan(5);

    // Direkter Storage-Aufruf, parallel — das ist die echte Konkurrenzprobe.
    const results = await Promise.allSettled(
      appointmentIds.map(async (apptId) => {
        const apptDate = (await apiGet<any>(`/api/appointments/${apptId}`)).data.date;
        return createConsumptionTransaction({
          customerId,
          appointmentId: apptId,
          transactionDate: apptDate,
          hauswirtschaftMinutes: 60,
          alltagsbegleitungMinutes: 0,
          travelKilometers: 0,
          customerKilometers: 0,
          userId: auth.user.id,
        });
      })
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Ohne Lock würden alle 5 erfolgreich buchen (jede liest 100 € verfügbar
    // bevor die anderen committen) — Overconsumption. Mit Lock dürfen genau
    // floor(budget/cost) Buchungen erfolgen, der Rest scheitert mit
    // "Budget reicht nicht".
    expect(fulfilled.length).toBe(expectedSuccesses);
    expect(rejected.length).toBe(5 - expectedSuccesses);

    for (const r of rejected) {
      expect(String((r as PromiseRejectedResult).reason?.message ?? "")).toMatch(/Budget reicht nicht/);
    }

    // DB-Wahrheit: Summe der §45b-consumption darf das Budget niemals überschreiten.
    const consumed = await db.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      eq(budgetTransactions.transactionType, "consumption"),
    ));
    const totalConsumed = Number(consumed[0]?.total ?? 0);
    expect(totalConsumed).toBeLessThanOrEqual(10000);
    expect(totalConsumed).toBe(expectedSuccesses * costPerBooking);
  });

  it("BC-K4.2 — Cascade-Pfad (Cost=0 nach FIFO) läuft hinter demselben Lock und überbucht §45a nicht parallel", async () => {
    // Szenario: §45b ist leer, §45a hat nur 50 € Restbudget. 4 parallele
    // 30-Min-Buchungen würden ohne Lock alle in §45a kaskadieren und den
    // Topf überziehen. Mit Lock dürfen nur die ins §45a-Budget passenden
    // Buchungen erfolgreich sein, der Rest scheitert mit "Budget reicht nicht".
    const customer = await createTestCustomer({
      vorname: "Konkurrenz",
      nachname: `Cascade-K4-${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = customer.id as number;

    await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    // §45b und §45a aktiv, §45b zuerst (Priority 1) — wird ausgeschöpft,
    // danach kaskadiert in §45a.
    await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });

    // §45b komplett leer (0 €) — kein automatischer Monats-Cap entstehen,
    // §45a mit genau 50 € Restbudget als manual_adjustment.
    const today = new Date();
    const yyyymm = today.toISOString().substring(0, 7);
    await apiPut(`/api/budget/${customerId}/preferences`, {
      customerId,
      budgetStartDate: "2099-01-01",
      monthlyLimitCents: null,
    });
    await db.insert(budgetAllocations).values({
      customerId,
      budgetType: "umwandlung_45a",
      year: today.getFullYear(),
      month: today.getMonth() + 1,
      amountCents: 5000,
      source: "manual_adjustment",
      validFrom: `${yyyymm}-01`,
      expiresAt: null,
      notes: "BC-K4.2 §45a Restbudget 50 €",
    });

    // 4 disjunkte Termine in der Vergangenheit (gleicher Pfad wie BC-K4.1).
    const services = [{ serviceId: hwServiceId, durationMinutes: 60 }];
    const appointmentIds: number[] = [];
    const slotTimes = ["08:00", "09:30", "11:00", "12:30"];
    let dayOffset = 2;
    while (appointmentIds.length < 4 && dayOffset < 60) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() - dayOffset);
      shiftWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];

      for (const time of slotTimes) {
        if (appointmentIds.length >= 4) break;
        const res = await apiPost<any>("/api/appointments/kundentermin", {
          customerId,
          date: dateStr,
          scheduledStart: time,
          notes: `BC-K4.2 Slot ${appointmentIds.length}`,
          assignedEmployeeId: auth.user.id,
          services,
        });
        if (res.status === 201) appointmentIds.push(res.data.id);
      }
      dayOffset++;
    }
    expect(appointmentIds.length).toBe(4);

    const aDate = (await apiGet<any>(`/api/appointments/${appointmentIds[0]}`)).data.date;
    const estimate = await apiGet<any>(
      `/api/budget/${customerId}/cost-estimate?date=${aDate}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    const costPerBooking = estimate.data.totalCents as number;
    expect(costPerBooking).toBeGreaterThan(0);

    // §45b ist leer → vollständige Cascade in §45a. Erwartete Erfolge =
    // floor(5000 / costPerBooking).
    const expectedSuccesses = Math.floor(5000 / costPerBooking);
    expect(expectedSuccesses).toBeGreaterThanOrEqual(1);
    expect(expectedSuccesses).toBeLessThan(4);

    const results = await Promise.allSettled(
      appointmentIds.map(async (apptId) => {
        const apptDate = (await apiGet<any>(`/api/appointments/${apptId}`)).data.date;
        return createConsumptionTransaction({
          customerId,
          appointmentId: apptId,
          transactionDate: apptDate,
          hauswirtschaftMinutes: 60,
          alltagsbegleitungMinutes: 0,
          travelKilometers: 0,
          customerKilometers: 0,
          userId: auth.user.id,
        });
      })
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(expectedSuccesses);
    expect(rejected.length).toBe(4 - expectedSuccesses);

    // §45a darf NIE überbucht werden — Summe Cascade-Konsum ≤ 50 €.
    const consumed45a = await db.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "umwandlung_45a"),
      eq(budgetTransactions.transactionType, "consumption"),
    ));
    expect(Number(consumed45a[0]?.total ?? 0)).toBeLessThanOrEqual(5000);
  });
});

describe("BC-K7: Partielle UNIQUE-Constraint macht Write-Off idempotent", () => {
  it("BC-K7.1 — 5 parallele syncCarryoverAndExpiry-Läufe erzeugen genau 1 Write-Off pro abgelaufener Allokation", async () => {
    const customer = await createTestCustomer({
      vorname: "Konkurrenz",
      nachname: `WriteOff-K7-${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    const customerId = customer.id as number;

    // Künstlich abgelaufener Carryover (Frist letztes Jahr 30.06.).
    const lastYear = new Date().getFullYear() - 1;
    const [carryover] = await db.insert(budgetAllocations).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: lastYear,
      month: null,
      amountCents: 5000,
      source: "carryover",
      validFrom: `${lastYear}-01-01`,
      expiresAt: `${lastYear}-06-30`,
      notes: `BC-K7 Testübertrag aus ${lastYear}`,
    }).returning();
    expect(carryover).toBeDefined();

    // 5x parallel — ohne UNIQUE würde jeder Lauf den existsCheck umgehen
    // und einen eigenen write_off einfügen.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => syncCarryoverAndExpiry(customerId))
    );

    // Alle 5 dürfen erfolgreich durchlaufen — die UNIQUE-Constraint löst über
    // ON CONFLICT DO NOTHING und poisoniert die Transaktion nicht.
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures).toHaveLength(0);

    // Genau 1 write_off für die Allokation.
    const writeOffs = await db.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.allocationId, carryover.id),
        eq(budgetTransactions.transactionType, "write_off"),
      ));
    expect(writeOffs).toHaveLength(1);
    expect(writeOffs[0].amountCents).toBe(-5000);
  });

  it("BC-K7.2 — Doppelter direkter Insert eines Write-Offs schlägt mit unique_violation fehl (DB-Schutz greift)", async () => {
    const customer = await createTestCustomer({
      vorname: "Konkurrenz",
      nachname: `WriteOff-Direct-${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    const customerId = customer.id as number;

    const lastYear = new Date().getFullYear() - 1;
    const [alloc] = await db.insert(budgetAllocations).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: lastYear,
      month: null,
      amountCents: 7700,
      source: "carryover",
      validFrom: `${lastYear}-01-01`,
      expiresAt: `${lastYear}-06-30`,
      notes: "BC-K7.2 Direkter Doppelschutz",
    }).returning();

    const insertWriteOff = () => db.insert(budgetTransactions).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: alloc.expiresAt!,
      transactionType: "write_off",
      amountCents: -7700,
      allocationId: alloc.id,
      notes: "BC-K7.2 Direkttest",
    }).returning();

    const first = await insertWriteOff();
    expect(first).toHaveLength(1);

    let secondError: any = null;
    try {
      await insertWriteOff();
    } catch (err) {
      secondError = err;
    }
    expect(secondError).not.toBeNull();
    // Postgres unique_violation = SQLSTATE 23505. Drizzle wraped den Treiber-
    // Error, der originale Code/Constraint-Name liegt im .cause-Feld.
    const errorBlob = JSON.stringify({
      code: secondError?.code ?? secondError?.cause?.code ?? null,
      constraint: secondError?.constraint ?? secondError?.cause?.constraint ?? null,
      message: String(secondError?.message ?? ""),
      causeMsg: String(secondError?.cause?.message ?? ""),
    });
    expect(errorBlob).toMatch(/23505|duplicate key|unique|write_off_unique/i);

    // Wichtigster Beleg: nach dem Doppel-Insert darf nur 1 Zeile existieren.
    const rows = await db.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.allocationId, alloc.id),
        eq(budgetTransactions.transactionType, "write_off"),
      ));
    expect(rows).toHaveLength(1);
  });
});
