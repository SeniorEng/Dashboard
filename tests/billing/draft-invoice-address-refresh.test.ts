/**
 * Task #1030 — Regressionstest für die Adress-Aktualisierung von Entwurf-
 * Rechnungen bei einer Kunden-Stammadress-Änderung.
 *
 * Hintergrund: Der Leistungsnachweis-„Leistungsempfänger/in" rendert
 * `invoice.recipientAddress` — bei gesetzlichen Kassen OHNE Kostenerstattung
 * also faelschlich die Pflegekassen-Anschrift statt der Patient-Wohnadresse
 * (Kunde 117 „Egon Uhlig"). Zusätzlich liefen Selbstzahler-Entwürfe mit einer
 * veralteten Empfänger-Adresse weiter.
 *
 * `refreshDraftInvoicesForCustomerAddress` löst die Adresse für alle Entwürfe
 * eines Kunden neu auf:
 *   - Kunden-adressiert (Selbstzahler / Privat / gesetzlich + Kostenerstattung):
 *     `recipient_address` → Stammadresse.
 *   - Kassen-adressiert (gesetzlich ohne Kostenerstattung): Empfänger bleibt die
 *     Kasse; nur der (Leistungsnachweis-)Cache wird invalidiert, damit das LN
 *     beim Neu-Rendern die korrekte Patient-Stammadresse zeigt.
 *   - Stornorechnungen & nicht-Entwurf-Rechnungen (GoBD): NIE angefasst.
 *   - Idempotent: ein zweiter Lauf ohne Stammdaten-Änderung ist ein No-Op.
 *
 * Die Tests legen eigene Kunden an, schreiben Entwurf-Rechnungen direkt per db
 * (Insert ist GoBD-erlaubt) und räumen via `cleanupCustomer` auf. Assertions
 * zielen ausschließlich auf die in diesem Test angelegten Rechnungen (per id).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getAuthCookie, uniqueId, createTestCustomer, cleanupCustomer } from "../test-utils";
import { db } from "../../server/lib/db";
import { invoices } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  refreshDraftInvoicesForCustomerAddress,
  isCustomerAddressedInvoice,
} from "../../server/services/invoice-address-refresh";

const MASTER = "Teststraße 1\n10115 Berlin"; // entspricht createTestCustomer-Defaults
const STALE_RECIPIENT = "Alte Straße 99\n99999 Altstadt";
const INSURANCE_ADDRESS = "AOK Pflegekasse\nKassenweg 1\n12345 Kassenstadt";

const createdCustomerIds: number[] = [];

async function newCustomer(overrides: Record<string, unknown> = {}): Promise<number> {
  const c = await createTestCustomer(overrides);
  createdCustomerIds.push(c.id);
  return c.id;
}

async function insertDraftInvoice(values: Record<string, unknown>): Promise<number> {
  const [row] = await db
    .insert(invoices)
    .values({
      invoiceNumber: `T1030-${uniqueId()}`,
      invoiceType: "rechnung",
      billingMonth: 1,
      billingYear: 2026,
      recipientName: "Test Empfänger",
      status: "entwurf",
      netAmountCents: 100,
      vatAmountCents: 0,
      grossAmountCents: 100,
      ...values,
    } as typeof invoices.$inferInsert)
    .returning({ id: invoices.id });
  return row.id;
}

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  for (const id of createdCustomerIds) {
    await cleanupCustomer(id);
  }
});

describe("isCustomerAddressedInvoice", () => {
  it("Selbstzahler ist kunden-adressiert", () => {
    expect(isCustomerAddressedInvoice("selbstzahler", false)).toBe(true);
  });
  it("private Pflegekasse ist kunden-adressiert", () => {
    expect(isCustomerAddressedInvoice("pflegekasse_privat", false)).toBe(true);
  });
  it("gesetzliche Kasse OHNE Kostenerstattung ist kassen-adressiert", () => {
    expect(isCustomerAddressedInvoice("pflegekasse_gesetzlich", false)).toBe(false);
  });
  it("gesetzliche Kasse MIT Kostenerstattung ist kunden-adressiert", () => {
    expect(isCustomerAddressedInvoice("pflegekasse_gesetzlich", true)).toBe(true);
  });
});

describe("refreshDraftInvoicesForCustomerAddress", () => {
  it("aktualisiert den Empfänger einer Selbstzahler-Entwurfsrechnung auf die Stammadresse und ist idempotent", async () => {
    const customerId = await newCustomer({ billingType: "selbstzahler" });
    const invId = await insertDraftInvoice({
      customerId,
      billingType: "selbstzahler",
      recipientAddress: STALE_RECIPIENT,
    });

    // Dry-Run: meldet die Änderung, schreibt aber nichts.
    const dry = await refreshDraftInvoicesForCustomerAddress(customerId, { dryRun: true });
    const dryItem = dry.changed.find((c) => c.invoiceId === invId);
    expect(dryItem?.recipientUpdated).toBe(true);
    expect(dryItem?.newRecipientAddress).toBe(MASTER);
    const afterDry = (await db.select().from(invoices).where(eq(invoices.id, invId)))[0];
    expect(afterDry.recipientAddress).toBe(STALE_RECIPIENT);

    // Apply: schreibt die Stammadresse in recipient_address.
    const applied = await refreshDraftInvoicesForCustomerAddress(customerId);
    expect(applied.changed.find((c) => c.invoiceId === invId)?.recipientUpdated).toBe(true);
    const afterApply = (await db.select().from(invoices).where(eq(invoices.id, invId)))[0];
    expect(afterApply.recipientAddress).toBe(MASTER);

    // Idempotent: ein zweiter Lauf ändert nichts mehr an dieser Rechnung.
    const second = await refreshDraftInvoicesForCustomerAddress(customerId);
    expect(second.changed.find((c) => c.invoiceId === invId)).toBeUndefined();
  });

  it("lässt den Pflegekassen-Empfänger unverändert, invalidiert aber den (Legacy-)Cache", async () => {
    const customerId = await newCustomer({ billingType: "pflegekasse_gesetzlich" });
    const invId = await insertDraftInvoice({
      customerId,
      billingType: "pflegekasse_gesetzlich",
      recipientAddress: INSURANCE_ADDRESS,
      // Legacy-Cache: PDF-Pfad vorhanden, aber kein Fingerprint → konservativ neu rendern.
      pdfPath: "/objects/invoices/__t1030_legacy__.pdf",
      pdfHash: "deadbeef",
    });

    const applied = await refreshDraftInvoicesForCustomerAddress(customerId);
    const item = applied.changed.find((c) => c.invoiceId === invId);
    expect(item?.recipientUpdated).toBe(false);
    expect(item?.cacheCleared).toBe(true);

    const after = (await db.select().from(invoices).where(eq(invoices.id, invId)))[0];
    // Empfänger bleibt die Kasse (GoBD/Logik: Kasse ist Rechnungsadressat).
    expect(after.recipientAddress).toBe(INSURANCE_ADDRESS);
    // Cache wurde invalidiert.
    expect(after.pdfPath).toBeNull();
    expect(after.pdfHash).toBeNull();
  });

  it("rührt Stornorechnungen nicht an", async () => {
    const customerId = await newCustomer({ billingType: "selbstzahler" });
    const stornoId = await insertDraftInvoice({
      customerId,
      billingType: "selbstzahler",
      invoiceType: "stornorechnung",
      recipientAddress: STALE_RECIPIENT,
    });

    const applied = await refreshDraftInvoicesForCustomerAddress(customerId);
    expect(applied.changed.find((c) => c.invoiceId === stornoId)).toBeUndefined();
    const after = (await db.select().from(invoices).where(eq(invoices.id, stornoId)))[0];
    expect(after.recipientAddress).toBe(STALE_RECIPIENT);
  });

  it("rührt versendete (nicht-Entwurf) Rechnungen nicht an", async () => {
    const customerId = await newCustomer({ billingType: "selbstzahler" });
    const sentId = await insertDraftInvoice({
      customerId,
      billingType: "selbstzahler",
      status: "versendet",
      recipientAddress: STALE_RECIPIENT,
    });

    const applied = await refreshDraftInvoicesForCustomerAddress(customerId);
    expect(applied.changed.find((c) => c.invoiceId === sentId)).toBeUndefined();
    const after = (await db.select().from(invoices).where(eq(invoices.id, sentId)))[0];
    expect(after.recipientAddress).toBe(STALE_RECIPIENT);
  });
});
