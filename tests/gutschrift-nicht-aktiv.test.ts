import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  uniqueId,
  createTestCustomer,
  cleanupCustomer,
  createAndDocumentAppointment,
  getFutureDate,
} from "./test-utils";
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
/** Weitere Kunden, die einzelne Tests selbst anlegen. */
const extraCustomerIds: number[] = [];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function seedInvoiceFor(
  forCustomerId: number,
  kind: "rechnung" | "stornorechnung",
  year: number,
  month: number,
) {
  const res = await db.execute(sql`
    INSERT INTO invoices (
      invoice_number, customer_id, billing_type, invoice_type,
      billing_month, billing_year, recipient_name,
      net_amount_cents, vat_amount_cents, gross_amount_cents, status
    ) VALUES (
      ${"QS-1909-" + uniqueId()}, ${forCustomerId}, 'privat', ${kind},
      ${month}, ${year}, 'Test', 0, 0, 0, 'versendet'
    ) RETURNING id`);
  const id = (res.rows[0] as any).id as number;
  invoiceIds.push(id);
  return id;
}

/** Bequemer Wrapper fuer den Haupt-Testkunden. */
const seedInvoice = (kind: "rechnung" | "stornorechnung", year: number, month: number) =>
  seedInvoiceFor(customerId, kind, year, month);

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
  for (const id of extraCustomerIds) {
    try { await cleanupCustomer(id); } catch { /* best effort */ }
  }
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

  it("Abrechnungs-Gate: ein Monat mit NUR einer Gutschrift gilt als nicht abgerechnet", async () => {
    // Die HAERTENDE Seite dieses PR — und die einzige, die sonst ungetestet
    // waere. Ein Rueckbau wuerde ein Gate still oeffnen, das eine
    // Kunden-Deaktivierung (und mittelbar die DSGVO-Anonymisierung) freigibt.
    //
    // Eigener Kunde, damit die Rechnungen der anderen Tests nicht hineinspielen.
    const cust = await createTestCustomer();
    const gateCustomerId = cust.id as number;
    extraCustomerIds.push(gateCustomerId);

    // Die Monatsliste des Readiness-Checks kommt aus den TERMINEN, nicht aus dem
    // Vertragszeitraum. Ohne Termin ist sie leer — und `every()` auf einem
    // leeren Array ist `true`, der Check waere dann trivial erfuellt und der
    // Test falsch gruen. (Erst so passiert, dann gemessen.)
    const apptDate = getFutureDate(7);
    const [ay, am] = apptDate.split("-").map(Number);

    const contract = await apiPost<any>(`/api/admin/customers/${gateCustomerId}/contract`, {
      contractStart: `${ay}-${String(am).padStart(2, "0")}-01`,
      // Vertragsende NACH dem Termin, sonst faellt er aus dem Fenster.
      contractEnd: getFutureDate(21),
    });
    expect(contract.status, `contract: ${JSON.stringify(contract.data)}`).toBe(201);
    await createAndDocumentAppointment(gateCustomerId, serviceId, { date: apptDate, startTime: "09:00" });

    // NUR eine Gutschrift im Monat dieses Termins.
    await seedInvoiceFor(gateCustomerId, "stornorechnung", ay, am);
    const mitGutschrift = await apiGet<any>(`/api/admin/customers/${gateCustomerId}/deactivation-readiness`);
    expect(mitGutschrift.status).toBe(200);
    const check1 = (mitGutschrift.data.checks ?? []).find((c: any) => c.key === "allInvoiced");
    expect(check1, "allInvoiced-Check muss es geben").toBeDefined();
    expect(check1.met, "Gutschrift allein ist keine Abrechnung").toBe(false);

    // Jetzt eine echte Rechnung dazu — Gegenprobe, sonst waere der Test auch
    // gruen, wenn der Check aus ganz anderem Grund immer false lieferte.
    await seedInvoiceFor(gateCustomerId, "rechnung", ay, am);
    const mitRechnung = await apiGet<any>(`/api/admin/customers/${gateCustomerId}/deactivation-readiness`);
    const check2 = (mitRechnung.data.checks ?? []).find((c: any) => c.key === "allInvoiced");
    expect(check2.met, "echte Rechnung erfuellt das Gate").toBe(true);
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
    // Der Handler kennt ZWEI 409er — `INVOICED_PERIOD_AFFECTED` (der gemeinte)
    // und `PRICE_CONFLICT` (gleicher `valid_from` fuer Kunde+Service). Ohne
    // diese Zeile waere der Test auch beim falschen gruen — genau die Klasse
    // Fehler, die den ersten Wurf dieser Datei erwischt hat.
    expect(res.data.code).toBe("INVOICED_PERIOD_AFFECTED");
  });
});
