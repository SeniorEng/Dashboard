import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiGet, apiPost, uniqueId, createTestCustomer, cleanupCustomer } from "./test-utils";
import { db } from "../server/lib/db";
import { sql } from "drizzle-orm";

/**
 * Task #1909 — eine GUTSCHRIFT (`invoice_type = 'stornorechnung'`) ist keine
 * aktive Rechnung.
 *
 * Zwei Pfade prüften das bisher nur über den STATUS und zählten Gutschriften
 * deshalb mit:
 *   • der Preis-Pfad („welche Rechnungen wären von dieser Preisänderung
 *     betroffen?") — eine Gutschrift erschien als betroffen, obwohl eine
 *     Preisänderung einen Storno-Beleg nicht mehr trifft;
 *   • der Abrechnungs-Gate-Pfad in `workflows.ts` („hat dieser Monat schon eine
 *     Rechnung?") — ein Monat mit NUR einer Gutschrift galt als abgerechnet.
 *
 * Beide Stellen nutzen jetzt das kanonische Aktiv-Prädikat (Task #1908). Diese
 * Datei nagelt die Korrektur fest: ohne sie wäre die Verhaltensänderung
 * ungeschützt und ein Rückbau fiele niemandem auf — die vorhandenen 27 Tests
 * der Preis-Pfade laufen mit UND ohne den Typ-Filter grün.
 */

let customerId = 0;
let serviceId = 0;
/** Zweiter Service für die Gegenprobe — sonst kollidiert sie mit dem Preis aus Test 1. */
let serviceId2 = 0;
const invoiceIds: number[] = [];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function seedInvoice(kind: "rechnung" | "stornorechnung", year: number, month: number) {
  const res = await db.execute(sql`
    INSERT INTO invoices (
      invoice_number, customer_id, billing_type, invoice_type,
      billing_month, billing_year, recipient_name,
      net_amount_cents, vat_amount_cents, gross_amount_cents, status
    ) VALUES (
      ${"QS-1909-" + uniqueId()}, ${customerId}, 'privat', ${kind},
      ${month}, ${year}, 'Test', 0, 0, 0, 'versendet'
    ) RETURNING id`);
  const id = (res.rows[0] as any).id as number;
  invoiceIds.push(id);
  return id;
}

beforeAll(async () => {
  const cust = await createTestCustomer();
  customerId = cust.id as number;
  const services = await apiGet<any[]>("/api/services/all");
  const list = services.data.filter((s: any) => s.isActive !== false);
  serviceId = (list.find((s: any) => s.code === "hauswirtschaft") ?? list[0]).id;
  serviceId2 = (list.find((s: any) => s.id !== serviceId) ?? list[0]).id;
  expect(serviceId2, "zwei verschiedene Services noetig").not.toBe(serviceId);
});

afterAll(async () => {
  for (const id of invoiceIds) {
    try { await db.execute(sql`DELETE FROM invoices WHERE id = ${id}`); } catch { /* best effort */ }
  }
  await cleanupCustomer(customerId);
});

describe("Task #1909 — Gutschriften zählen nicht als aktive Rechnung", () => {
  it("Preis-Pfad: eine Gutschrift blockiert die Preisänderung NICHT", async () => {
    // Nur eine Gutschrift im laufenden Monat — sonst nichts. Vor der Korrektur
    // galt sie als „betroffene Rechnung" und der POST wurde mit 409 abgelehnt.
    const today = new Date();
    await seedInvoice("stornorechnung", today.getFullYear(), today.getMonth() + 1);

    // HEUTE, nicht der Monatserste: ein Datum in der Vergangenheit wird schon
    // von der Feld-Validierung mit 400 abgelehnt — dann prueft der Test den
    // Rechnungs-Guard gar nicht mehr (erst so passiert, dann gemessen).
    const validFrom = todayIso();
    const res = await apiPost<any>(`/api/customers/${customerId}/service-prices`, {
      serviceId,
      priceCents: 4242,
      validFrom,
    });
    // POSITIV pruefen: der Preis wird angelegt (200 mit Datensatz). Ein blosses
    // `not.toBe(409)` waere auch bei einem 400 aus ganz anderem Grund gruen —
    // genau so ist dieser Test im ersten Wurf falsch gruen gewesen.
    expect(res.status, `unerwartet: ${JSON.stringify(res.data)}`).toBe(200);
    expect(res.data.priceCents).toBe(4242);
  });

  it("Preis-Pfad: eine echte Rechnung blockiert weiterhin (Gegenprobe)", async () => {
    // Ohne diese Gegenprobe wäre der Test oben auch dann grün, wenn der Guard
    // versehentlich ganz abgeschaltet würde.
    const today = new Date();
    await seedInvoice("rechnung", today.getFullYear(), today.getMonth() + 1);

    const validFrom = todayIso();
    const res = await apiPost<any>(`/api/customers/${customerId}/service-prices`, {
      serviceId: serviceId2,
      priceCents: 4343,
      validFrom,
    });
    expect(res.status, `unerwartet: ${JSON.stringify(res.data)}`).toBe(409);
  });
});
