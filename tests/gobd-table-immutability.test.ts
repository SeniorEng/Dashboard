/**
 * Task #828 — GoBD: technische Unveränderbarkeit weiterer integritäts-/
 * historisierungskritischer Tabellen (über audit_log aus Task #824 hinaus).
 *
 * Verifiziert die BEFORE-Trigger aus
 * `server/startup/ensure-gobd-table-immutability.ts`:
 *  - budget_allocations: kein Resurrect (deleted_at NOT NULL → NULL), kein
 *    Hard-Delete; Bypass-GUC erlaubt beides.
 *  - customer_budget_type_settings: kein Hard-Delete; Bypass-GUC erlaubt es.
 *  - invoices: finalisierte Rechnung (status <> 'entwurf') nicht löschbar,
 *    Entwurf schon; Bypass-GUC erlaubt auch finalisierten Delete.
 *  - invoice_line_items: Positionen finalisierter Rechnungen nicht
 *    update-/löschbar, Entwurfs-Positionen schon; Bypass-GUC erlaubt beides.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../server/lib/db";
import {
  budgetAllocations,
  customerBudgetTypeSettings,
  invoices,
  invoiceLineItems,
} from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { createTestCustomer, uniqueId } from "./test-utils";

let customerId: number;
let deletedAllocId: number;
let cbtsId: number;
let finalizedInvoiceId: number;
let finalizedLineItemId: number;
let draftInvoiceId: number;
let draftLineItemId: number;

beforeAll(async () => {
  const c = await createTestCustomer({
    vorname: "GoBD",
    nachname: "Immutable-" + uniqueId(),
  });
  customerId = c.id as number;

  // Soft-gelöschte Allokation (Resurrect-Kandidat).
  const [alloc] = await db
    .insert(budgetAllocations)
    .values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: 2026,
      month: 1,
      amountCents: 13100,
      source: "manual_adjustment",
      validFrom: "2026-01-01",
      deletedAt: new Date(),
    })
    .returning({ id: budgetAllocations.id });
  deletedAllocId = alloc.id;

  const [cbts] = await db
    .insert(customerBudgetTypeSettings)
    .values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      validFrom: "2025-01-01",
      validTo: "2025-12-31",
    })
    .returning({ id: customerBudgetTypeSettings.id });
  cbtsId = cbts.id;

  // Finalisierte Rechnung + Position.
  const [finInv] = await db
    .insert(invoices)
    .values({
      invoiceNumber: "GOBD-FIN-" + uniqueId(),
      customerId,
      billingType: "selbstzahler",
      invoiceType: "rechnung",
      billingMonth: 1,
      billingYear: 2026,
      recipientName: "GoBD Testempfänger",
      status: "versendet",
    })
    .returning({ id: invoices.id });
  finalizedInvoiceId = finInv.id;
  const [finLi] = await db
    .insert(invoiceLineItems)
    .values({
      invoiceId: finalizedInvoiceId,
      appointmentDate: "2026-01-15",
      serviceDescription: "GoBD Position finalisiert",
      durationMinutes: 60,
      unitPriceCents: 5000,
      totalCents: 5000,
    })
    .returning({ id: invoiceLineItems.id });
  finalizedLineItemId = finLi.id;

  // Entwurfs-Rechnung + Position (frei mutierbar).
  const [draftInv] = await db
    .insert(invoices)
    .values({
      invoiceNumber: "GOBD-DRAFT-" + uniqueId(),
      customerId,
      billingType: "selbstzahler",
      invoiceType: "rechnung",
      billingMonth: 1,
      billingYear: 2026,
      recipientName: "GoBD Testempfänger",
      status: "entwurf",
    })
    .returning({ id: invoices.id });
  draftInvoiceId = draftInv.id;
  const [draftLi] = await db
    .insert(invoiceLineItems)
    .values({
      invoiceId: draftInvoiceId,
      appointmentDate: "2026-01-16",
      serviceDescription: "GoBD Position Entwurf",
      durationMinutes: 30,
      unitPriceCents: 2500,
      totalCents: 2500,
    })
    .returning({ id: invoiceLineItems.id });
  draftLineItemId = draftLi.id;
});

afterAll(async () => {
  // Alles mit transaktions-lokalem Bypass-GUC aufräumen.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
    await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, finalizedInvoiceId));
    await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, draftInvoiceId));
    await tx.delete(invoices).where(eq(invoices.id, finalizedInvoiceId));
    await tx.delete(invoices).where(eq(invoices.id, draftInvoiceId));
    await tx.delete(budgetAllocations).where(eq(budgetAllocations.id, deletedAllocId));
    await tx.delete(customerBudgetTypeSettings).where(eq(customerBudgetTypeSettings.id, cbtsId));
    await tx.delete(customerBudgetTypeSettings).where(eq(customerBudgetTypeSettings.customerId, customerId));
    await tx.delete(budgetAllocations).where(eq(budgetAllocations.customerId, customerId));
  });
});

describe("budget_allocations: Resurrect & Hard-Delete sind gesperrt", () => {
  it("Resurrect (deleted_at NOT NULL → NULL) schlägt fehl", async () => {
    await expect(
      db.update(budgetAllocations).set({ deletedAt: null }).where(eq(budgetAllocations.id, deletedAllocId)),
    ).rejects.toThrow();
    const rows = await db
      .select({ deletedAt: budgetAllocations.deletedAt })
      .from(budgetAllocations)
      .where(eq(budgetAllocations.id, deletedAllocId));
    expect(rows[0]?.deletedAt).not.toBeNull();
  });

  it("Hard-Delete schlägt fehl", async () => {
    await expect(
      db.delete(budgetAllocations).where(eq(budgetAllocations.id, deletedAllocId)),
    ).rejects.toThrow();
    const rows = await db
      .select({ id: budgetAllocations.id })
      .from(budgetAllocations)
      .where(eq(budgetAllocations.id, deletedAllocId));
    expect(rows.length).toBe(1);
  });

  it("Legitime Felder dürfen weiterhin per UPDATE geändert werden", async () => {
    await db.update(budgetAllocations).set({ notes: "ok" }).where(eq(budgetAllocations.id, deletedAllocId));
    const rows = await db
      .select({ notes: budgetAllocations.notes })
      .from(budgetAllocations)
      .where(eq(budgetAllocations.id, deletedAllocId));
    expect(rows[0]?.notes).toBe("ok");
  });

  it("Mit Bypass-GUC ist Hard-Delete möglich", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
      await tx.delete(budgetAllocations).where(eq(budgetAllocations.id, deletedAllocId));
    });
    const rows = await db
      .select({ id: budgetAllocations.id })
      .from(budgetAllocations)
      .where(eq(budgetAllocations.id, deletedAllocId));
    expect(rows.length).toBe(0);
  });
});

describe("customer_budget_type_settings: append-only (kein Hard-Delete)", () => {
  it("Hard-Delete schlägt fehl", async () => {
    await expect(
      db.delete(customerBudgetTypeSettings).where(eq(customerBudgetTypeSettings.id, cbtsId)),
    ).rejects.toThrow();
    const rows = await db
      .select({ id: customerBudgetTypeSettings.id })
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.id, cbtsId));
    expect(rows.length).toBe(1);
  });

  it("UPDATE bleibt erlaubt (Phasen-Append/In-Place-Pfad)", async () => {
    await db
      .update(customerBudgetTypeSettings)
      .set({ priority: 2 })
      .where(eq(customerBudgetTypeSettings.id, cbtsId));
    const rows = await db
      .select({ priority: customerBudgetTypeSettings.priority })
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.id, cbtsId));
    expect(rows[0]?.priority).toBe(2);
  });

  it("Mit Bypass-GUC ist Hard-Delete möglich", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
      await tx.delete(customerBudgetTypeSettings).where(eq(customerBudgetTypeSettings.id, cbtsId));
    });
    const rows = await db
      .select({ id: customerBudgetTypeSettings.id })
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.id, cbtsId));
    expect(rows.length).toBe(0);
  });
});

describe("invoices: finalisierte Rechnungen sind unloeschbar", () => {
  it("DELETE einer finalisierten Rechnung schlägt fehl", async () => {
    await expect(
      db.delete(invoices).where(eq(invoices.id, finalizedInvoiceId)),
    ).rejects.toThrow();
    const rows = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, finalizedInvoiceId));
    expect(rows.length).toBe(1);
  });

  it("Status-UPDATE bleibt erlaubt (z.B. bezahlt)", async () => {
    await db.update(invoices).set({ status: "bezahlt" }).where(eq(invoices.id, finalizedInvoiceId));
    const rows = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, finalizedInvoiceId));
    expect(rows[0]?.status).toBe("bezahlt");
  });

  it("DELETE eines Entwurfs ist erlaubt", async () => {
    // Erst die Entwurfs-Position löschen (sonst FK-Cascade greift ohnehin).
    await db.delete(invoiceLineItems).where(eq(invoiceLineItems.id, draftLineItemId));
    await db.delete(invoices).where(eq(invoices.id, draftInvoiceId));
    const rows = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, draftInvoiceId));
    expect(rows.length).toBe(0);
  });
});

describe("invoice_line_items: Positionen finalisierter Rechnungen sind eingefroren", () => {
  it("UPDATE schlägt fehl", async () => {
    await expect(
      db.update(invoiceLineItems).set({ totalCents: 9999 }).where(eq(invoiceLineItems.id, finalizedLineItemId)),
    ).rejects.toThrow();
    const rows = await db
      .select({ totalCents: invoiceLineItems.totalCents })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.id, finalizedLineItemId));
    expect(rows[0]?.totalCents).toBe(5000);
  });

  it("DELETE schlägt fehl", async () => {
    await expect(
      db.delete(invoiceLineItems).where(eq(invoiceLineItems.id, finalizedLineItemId)),
    ).rejects.toThrow();
    const rows = await db
      .select({ id: invoiceLineItems.id })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.id, finalizedLineItemId));
    expect(rows.length).toBe(1);
  });

  it("Mit Bypass-GUC sind UPDATE und DELETE möglich", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
      await tx.update(invoiceLineItems).set({ totalCents: 1 }).where(eq(invoiceLineItems.id, finalizedLineItemId));
      await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.id, finalizedLineItemId));
    });
    const rows = await db
      .select({ id: invoiceLineItems.id })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.id, finalizedLineItemId));
    expect(rows.length).toBe(0);
  });
});
