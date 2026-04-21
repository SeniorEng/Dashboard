import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getAuthCookie,
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

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

/**
 * Task #118 — Vorschau und tatsächliche Buchung im Import sichtbar gleichschalten.
 *
 * Verifies that `getAvailableForDate()` (preview path) and
 * `createCascadeConsumption()` (booking path) compute the same cap-aware slot
 * across edge cases. Both must consult the SAME `computeCapSlot()` helper so
 * preview and booking can never drift.
 */
describe("Task #118 — Import-Vorschau == tatsächliche Buchung", () => {
  async function setupCustomerWithCap(): Promise<number> {
    const created = await createTestCustomer({
      vorname: "Cap",
      nachname: `Aligned-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
    });
    const cid = created.id as number;

    await apiPatch(`/api/admin/customers/${cid}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    await apiPut(`/api/budget/${cid}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 13100 },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });

    return cid;
  }

  async function bookCascade(
    cid: number,
    date: string,
    amountCents: number,
  ): Promise<{ consumedCents: number; outstandingCents: number; appointmentId: number }> {
    const { db } = await import("../server/lib/db");
    const { appointments: apptsTable } = await import("@shared/schema");
    const { createCascadeConsumption } = await import(
      "../server/storage/budget/consumption-engine"
    );

    const [appt] = await db.insert(apptsTable).values({
      customerId: cid,
      assignedEmployeeId: auth.user.id,
      performedByEmployeeId: auth.user.id,
      appointmentType: "Kundentermin",
      serviceType: "Alltagsbegleitung",
      date,
      scheduledStart: "09:00",
      scheduledEnd: "10:00",
      durationPromised: 60,
      status: "completed",
      actualStart: "09:00",
      actualEnd: "10:00",
      isFahrtdienst: false,
      travelKilometers: 0,
      customerKilometers: 0,
    }).returning();

    const result = await createCascadeConsumption({
      customerId: cid,
      appointmentId: appt.id,
      transactionDate: date,
      totalAmountCents: amountCents,
      hauswirtschaftMinutes: 0,
      hauswirtschaftCents: 0,
      alltagsbegleitungMinutes: 60,
      alltagsbegleitungCents: amountCents,
      travelKilometers: 0,
      travelCents: 0,
      customerKilometers: 0,
      customerKilometersCents: 0,
      userId: auth.user.id,
    });

    return {
      consumedCents: result.totalConsumedCents,
      outstandingCents: result.outstandingCents,
      appointmentId: appt.id,
    };
  }

  async function previewCents(cid: number, date: string): Promise<number> {
    const { getAvailableForDate } = await import(
      "../server/storage/budget/import-availability"
    );
    const r = await getAvailableForDate(cid, date);
    return r.totalCents;
  }

  it("INT-118.1 – Standardfall: Vorschau == Buchung im selben Monat", async () => {
    const cid = await setupCustomerWithCap();
    const year = new Date().getFullYear();
    const date = `${year}-10-15`;

    await apiPost(`/api/budget/${cid}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentYearAmountCents: 200000,
      carryoverAmountCents: 0,
      budgetStartDate: `${year}-01-01`,
    });

    const preview = await previewCents(cid, date);
    expect(preview).toBeGreaterThan(0);
    expect(preview).toBe(13100); // monatlicher Cap §45b

    const booked = await bookCascade(cid, date, preview);
    expect(booked.consumedCents).toBe(preview);
    expect(booked.outstandingCents).toBe(0);

    // Nach Buchung muss die Vorschau für denselben Tag exakt 0 sein.
    const previewAfter = await previewCents(cid, date);
    expect(previewAfter).toBe(0);

    try { await apiDeleteRaw(`/api/customers/${cid}`); } catch {}
  }, 30000);

  it("INT-118.2 – Monatswechsel: Verbrauch im März blockiert nicht den April", async () => {
    const cid = await setupCustomerWithCap();
    const year = new Date().getFullYear();
    const dateMarch = `${year}-11-20`;
    const dateApril = `${year}-12-05`;

    await apiPost(`/api/budget/${cid}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentYearAmountCents: 200000,
      carryoverAmountCents: 0,
      budgetStartDate: `${year}-01-01`,
    });

    // Voll im März verbraten.
    const previewMarch = await previewCents(cid, dateMarch);
    const bookedMarch = await bookCascade(cid, dateMarch, previewMarch);
    expect(bookedMarch.consumedCents).toBe(previewMarch);

    // April: Cap muss zurückgesetzt sein.
    const previewApril = await previewCents(cid, dateApril);
    expect(previewApril).toBe(13100);

    const bookedApril = await bookCascade(cid, dateApril, previewApril);
    expect(bookedApril.consumedCents).toBe(previewApril);

    try { await apiDeleteRaw(`/api/customers/${cid}`); } catch {}
  }, 30000);

  it("INT-118.3 – Carryover läuft mid-month aus: Vorschau und Buchung sehen denselben Cap", async () => {
    const cid = await setupCustomerWithCap();
    const year = new Date().getFullYear();

    // Initialbudget anlegen (legt auch Carryover-Allocation für Vorjahr an).
    await apiPost(`/api/budget/${cid}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentYearAmountCents: 200000,
      carryoverAmountCents: 0,
      budgetStartDate: `${year}-01-01`,
    });

    // Carryover-Allocation direkt mit mid-month Expiry einfügen, um Edge-Case
    // zu modellieren (Standard-API erlaubt nur 30.06. als Expiry).
    const { db } = await import("../server/lib/db");
    const { budgetAllocations } = await import("@shared/schema");

    await db.insert(budgetAllocations).values({
      customerId: cid,
      budgetType: "entlastungsbetrag_45b",
      year: year - 1,
      amountCents: 5000,
      source: "carryover",
      validFrom: `${year}-01-01`,
      expiresAt: `${year}-11-15`, // mid-month Expiry
      notes: "Test #118 mid-month expiry",
    });

    const datePreExpiry = `${year}-11-10`;
    const datePostExpiry = `${year}-11-20`;

    // Vor Expiry: Cap = 13100 + 5000 carryover = 18100
    const previewPre = await previewCents(cid, datePreExpiry);
    expect(previewPre).toBe(18100);
    const bookedPre = await bookCascade(cid, datePreExpiry, previewPre);
    expect(bookedPre.consumedCents).toBe(previewPre);

    // Anderer Kunde für Post-Expiry-Check (Pot wäre sonst leer).
    const cid2 = await setupCustomerWithCap();
    await apiPost(`/api/budget/${cid2}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentYearAmountCents: 200000,
      carryoverAmountCents: 0,
      budgetStartDate: `${year}-01-01`,
    });
    await db.insert(budgetAllocations).values({
      customerId: cid2,
      budgetType: "entlastungsbetrag_45b",
      year: year - 1,
      amountCents: 5000,
      source: "carryover",
      validFrom: `${year}-01-01`,
      expiresAt: `${year}-11-15`,
      notes: "Test #118 mid-month expiry (post)",
    });

    // Nach Expiry: Carryover zählt nicht mehr → Cap = 13100
    const previewPost = await previewCents(cid2, datePostExpiry);
    expect(previewPost).toBe(13100);
    const bookedPost = await bookCascade(cid2, datePostExpiry, previewPost);
    expect(bookedPost.consumedCents).toBe(previewPost);

    try { await apiDeleteRaw(`/api/customers/${cid}`); } catch {}
    try { await apiDeleteRaw(`/api/customers/${cid2}`); } catch {}
  }, 30000);

  it("INT-118.4 – Pot disabled: Vorschau und Buchung beide 0", async () => {
    const cid = await setupCustomerWithCap();
    const year = new Date().getFullYear();
    const date = `${year}-12-15`;

    await apiPost(`/api/budget/${cid}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentYearAmountCents: 200000,
      carryoverAmountCents: 0,
      budgetStartDate: `${year}-01-01`,
    });

    // §45b deaktivieren — alle Töpfe nun aus.
    await apiPut(`/api/budget/${cid}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: false, monthlyLimitCents: 13100 },
        { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });

    const preview = await previewCents(cid, date);
    expect(preview).toBe(0);

    // Buchung mit positivem Wunschbetrag: nichts wird konsumiert, Outstanding == Wunsch.
    const booked = await bookCascade(cid, date, 5000);
    expect(booked.consumedCents).toBe(0);
    expect(booked.outstandingCents).toBe(5000);

    try { await apiDeleteRaw(`/api/customers/${cid}`); } catch {}
  }, 30000);
});
