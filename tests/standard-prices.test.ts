import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiGet, apiPost, apiDelete, uniqueId, createTestCustomer, cleanupCustomer } from "./test-utils";
import { db } from "../server/lib/db";
import { sql } from "drizzle-orm";

/**
 * Task #1357 — Integrationstests für die firmenweiten Standardpreise
 * (`/api/services/standard-prices`). Die Standardpreis-Zeilen leben in der
 * konsolidierten `prices`-SSoT (`scope='standard'`, `origin='service_rates'`,
 * `customer_id=NULL`).
 *
 * Die reine Auflösungs-Reihenfolge (Kunde → Standard → Default) über den
 * Stichtag ist bereits in `tests/unit/pricing-price-for.test.ts` festgenagelt;
 * hier prüfen wir den Schreib-/Versionierungs-Pfad der Route:
 *   - Anlegen + GET (aktiv am Stichtag, /all, /future)
 *   - Append-only-Versionierung (Vorgängerphase wird per valid_to eingeklemmt)
 *   - PRICE_CONFLICT bei identischem valid_from (+ confirmReplace)
 *   - INVOICED_PERIOD_AFFECTED-Schutz firmenweit (+ confirmInvoiceOverride)
 *   - Revisionssicherheit (Vorgängerzeile behält id/cents/valid_from,
 *     nur valid_to wird eingeklemmt — KEIN In-Place-Update, GoBD/append-only)
 *   - Validierungen (validFrom in der Vergangenheit, validTo<validFrom,
 *     nicht abrechenbare Leistung, 404)
 */

const BASE = "/api/services/standard-prices";

async function getCatalogServiceId(code: string): Promise<number> {
  const { data } = await apiGet<any[]>("/api/services/all");
  const svc = data.find((s) => s.code === code);
  expect(svc, `Katalog-Leistung '${code}' muss vorhanden sein`).toBeDefined();
  return svc.id as number;
}

// Stichtag weit in der Zukunft, damit der firmenweite Rechnungs-Schutz
// (alle nicht-stornierten Rechnungen ab dem Stichtag) nicht durch von
// Schwester-Tests im selben Worker erzeugte Rechnungen ausgelöst wird.
function farFuture(monthOffset: number, day: number): string {
  const base = new Date();
  const year = base.getFullYear() + 10;
  const month = String(monthOffset).padStart(2, "0");
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const trackedPriceIds: number[] = [];

async function cleanupPrices(): Promise<void> {
  for (const id of trackedPriceIds) {
    try {
      await db.execute(sql`UPDATE prices SET deleted_at = NOW() WHERE id = ${id} AND deleted_at IS NULL`);
    } catch {}
  }
  trackedPriceIds.length = 0;
}

describe("Standardpreise CRUD + Append-only-Versionierung (Task #1357)", () => {
  let serviceId = 0;
  let nonBillableServiceId = 0;

  beforeAll(async () => {
    serviceId = await getCatalogServiceId("hauswirtschaft");
    nonBillableServiceId = await getCatalogServiceId("erstberatung");
  });

  afterAll(async () => {
    await cleanupPrices();
    // Restliche, in diesem Service angelegte Standardzeilen aufräumen.
    try {
      await db.execute(sql`
        UPDATE prices SET deleted_at = NOW()
        WHERE scope = 'standard' AND origin = 'service_rates'
          AND customer_id IS NULL AND service_id = ${serviceId} AND deleted_at IS NULL
      `);
    } catch {}
  });

  it("legt einen Standardpreis an und liefert ihn am Stichtag zurück", async () => {
    const validFrom = farFuture(1, 1);
    const res = await apiPost<any>(BASE, { serviceId, priceCents: 5000, validFrom });
    expect(res.status).toBe(200);
    expect(res.data.id).toBeGreaterThan(0);
    expect(res.data.priceCents).toBe(5000);
    expect(res.data.validTo).toBeNull();
    trackedPriceIds.push(res.data.id);

    const list = await apiGet<any[]>(`${BASE}?date=${validFrom}`);
    expect(list.status).toBe(200);
    const found = list.data.find((r) => r.serviceId === serviceId);
    expect(found).toBeDefined();
    expect(found.priceCents).toBe(5000);
  });

  it("klemmt beim Anlegen einer späteren Version die Vorgängerphase per valid_to ein (Append-only)", async () => {
    const laterValidFrom = farFuture(6, 1);
    const res = await apiPost<any>(BASE, { serviceId, priceCents: 5500, validFrom: laterValidFrom });
    expect(res.status).toBe(200);
    trackedPriceIds.push(res.data.id);

    const all = await apiGet<any[]>(`${BASE}/all`);
    const rows = all.data.filter((r) => r.serviceId === serviceId);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Die Vorgängerzeile (validFrom = Monat 1) muss jetzt ein valid_to am Tag
    // VOR der neuen Version (Monat 6, Tag 1) tragen.
    const predecessor = rows.find((r) => String(r.validFrom).startsWith(farFuture(1, 1).slice(0, 7)));
    expect(predecessor).toBeDefined();
    expect(predecessor.validTo).not.toBeNull();
    const vt = String(predecessor.validTo).slice(0, 10);
    expect(vt < laterValidFrom).toBe(true);
  });

  it("listet zukünftige Standardpreise unter /future", async () => {
    const res = await apiGet<any[]>(`${BASE}/future`);
    expect(res.status).toBe(200);
    const rows = res.data.filter((r) => r.serviceId === serviceId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("blockiert PRICE_CONFLICT bei identischem valid_from ohne confirmReplace", async () => {
    const validFrom = farFuture(1, 1);
    const res = await apiPost<any>(BASE, { serviceId, priceCents: 6100, validFrom });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe("PRICE_CONFLICT");
    expect(res.data.details?.existing).toBeDefined();
    expect(res.data.details.newPriceCents).toBe(6100);
  });

  it("ersetzt den bestehenden Preis bei confirmReplace=true (alter wird soft-deleted)", async () => {
    const validFrom = farFuture(1, 1);
    const res = await apiPost<any>(BASE, { serviceId, priceCents: 6100, validFrom, confirmReplace: true });
    expect(res.status).toBe(200);
    expect(res.data.priceCents).toBe(6100);
    trackedPriceIds.push(res.data.id);

    const list = await apiGet<any[]>(`${BASE}?date=${validFrom}`);
    const found = list.data.find((r) => r.serviceId === serviceId);
    expect(found.priceCents).toBe(6100);
  });

  it("ist revisionssicher: eine neue Phase überschreibt NIE die Vorgängerzeile in-place (append-only)", async () => {
    // Nutzt eine eigene, isolierte Leistung-Stichtag-Reihe weit in der Zukunft.
    const earlierValidFrom = farFuture(9, 1);
    const created = await apiPost<any>(BASE, { serviceId, priceCents: 7000, validFrom: earlierValidFrom });
    expect(created.status).toBe(200);
    trackedPriceIds.push(created.data.id);
    const predecessorId = created.data.id as number;

    // Vor-Zustand der Vorgängerzeile festhalten.
    const before = await db.execute(sql`
      SELECT id, cents, valid_from, valid_to FROM prices WHERE id = ${predecessorId}
    `);
    expect(before.rows.length).toBe(1);
    const beforeRow = before.rows[0] as { id: number; cents: number; valid_from: any; valid_to: any };
    expect(Number(beforeRow.cents)).toBe(7000);
    expect(beforeRow.valid_to).toBeNull();

    // Spätere Korrekturphase anlegen.
    const laterValidFrom = farFuture(10, 1);
    const correction = await apiPost<any>(BASE, { serviceId, priceCents: 7200, validFrom: laterValidFrom });
    expect(correction.status).toBe(200);
    trackedPriceIds.push(correction.data.id);
    expect(correction.data.id).not.toBe(predecessorId);

    // Die Vorgängerzeile behält id + cents + valid_from unverändert;
    // NUR valid_to wird eingeklemmt (kein In-Place-Overwrite ihrer Werte).
    const after = await db.execute(sql`
      SELECT id, cents, valid_from, valid_to, deleted_at FROM prices WHERE id = ${predecessorId}
    `);
    expect(after.rows.length).toBe(1);
    const afterRow = after.rows[0] as { id: number; cents: number; valid_from: any; valid_to: any; deleted_at: any };
    expect(afterRow.id).toBe(predecessorId);
    expect(Number(afterRow.cents)).toBe(7000);
    expect(String(afterRow.valid_from).slice(0, 10)).toBe(String(beforeRow.valid_from).slice(0, 10));
    expect(afterRow.deleted_at).toBeNull();
    expect(afterRow.valid_to).not.toBeNull();
    expect(String(afterRow.valid_to).slice(0, 10) < laterValidFrom).toBe(true);
  });

  it("lehnt das Löschen bereits beendeter Historienphasen ab (revisionssicher)", async () => {
    // Eine bereits in der Vergangenheit beendete Phase lässt sich nicht über die
    // API erzeugen (POST verlangt validFrom >= heute), daher direkt seeden.
    const inserted = await db.execute(sql`
      INSERT INTO prices (scope, origin, customer_id, service_id, cents, valid_from, valid_to)
      VALUES ('standard', 'service_rates', NULL, ${serviceId}, 4444, '2020-01-01', '2020-12-31')
      RETURNING id
    `);
    const historicalId = (inserted.rows[0] as any).id as number;
    trackedPriceIds.push(historicalId);

    const res = await apiDelete<any>(`${BASE}/${historicalId}`);
    expect(res.status).toBe(409);
    expect(res.data.error).toBe("HISTORICAL_PRICE_IMMUTABLE");

    // Die historische Zeile bleibt unverändert: valid_to und deleted_at intakt.
    const after = await db.execute(sql`
      SELECT valid_to, deleted_at FROM prices WHERE id = ${historicalId}
    `);
    const afterRow = after.rows[0] as { valid_to: any; deleted_at: any };
    expect(String(afterRow.valid_to).slice(0, 10)).toBe("2020-12-31");
    expect(afterRow.deleted_at).toBeNull();
  });

  it("lehnt validFrom in der Vergangenheit ab", async () => {
    const past = "2000-01-01";
    const res = await apiPost<any>(BASE, { serviceId, priceCents: 4000, validFrom: past });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe("VALIDATION_ERROR");
  });

  it("lehnt Standardpreise für nicht abrechenbare Leistungen ab", async () => {
    const res = await apiPost<any>(BASE, {
      serviceId: nonBillableServiceId,
      priceCents: 4000,
      validFrom: farFuture(1, 1),
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe("VALIDATION_ERROR");
  });

  it("liefert 404 bei unbekannter Dienstleistung", async () => {
    const res = await apiPost<any>(BASE, { serviceId: 999999999, priceCents: 4000, validFrom: farFuture(1, 1) });
    expect(res.status).toBe(404);
    expect(res.data.error).toBe("NOT_FOUND");
  });
});

describe("Standardpreise — firmenweiter Rechnungs-Schutz (Task #1357)", () => {
  let serviceId = 0;
  let invoiceId = 0;
  let customerId = 0;

  beforeAll(async () => {
    serviceId = await getCatalogServiceId("hauswirtschaft");

    const cust = await createTestCustomer();
    customerId = cust.id;

    const today = new Date();
    const invoiceNumber = "QS-STD-" + uniqueId();
    const insertRes = await db.execute(sql`
      INSERT INTO invoices (
        invoice_number, customer_id, billing_type, invoice_type,
        billing_month, billing_year, recipient_name,
        net_amount_cents, vat_amount_cents, gross_amount_cents,
        status
      ) VALUES (
        ${invoiceNumber}, ${customerId}, 'privat', 'rechnung',
        ${today.getMonth() + 1}, ${today.getFullYear()}, 'Test',
        0, 0, 0,
        'versendet'
      ) RETURNING id
    `);
    invoiceId = (insertRes.rows[0] as any).id as number;
  });

  afterAll(async () => {
    await cleanupPrices();
    try {
      await db.execute(sql`
        UPDATE prices SET deleted_at = NOW()
        WHERE scope = 'standard' AND origin = 'service_rates'
          AND customer_id IS NULL AND service_id = ${serviceId} AND deleted_at IS NULL
      `);
    } catch {}
    try {
      if (invoiceId) await db.execute(sql`DELETE FROM invoices WHERE id = ${invoiceId}`);
    } catch {}
    await cleanupCustomer(customerId);
  });

  it("blockiert POST mit 409 INVOICED_PERIOD_AFFECTED, wenn der Stichtag einen abgerechneten Monat trifft", async () => {
    const res = await apiPost<any>(BASE, { serviceId, priceCents: 4200, validFrom: todayISO() });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe("INVOICED_PERIOD_AFFECTED");
    expect(Array.isArray(res.data.details?.invoices)).toBe(true);
    expect(res.data.details.invoices.length).toBeGreaterThan(0);
  });

  it("akzeptiert POST mit confirmInvoiceOverride=true und schreibt einen Audit-Eintrag", async () => {
    const beforeAudit = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM audit_log
      WHERE action = 'standard_price_changed_invoiced'
        AND entity_type = 'service' AND entity_id = ${serviceId}
    `);
    const beforeCount = (beforeAudit.rows[0] as any).count as number;

    const res = await apiPost<any>(BASE, {
      serviceId,
      priceCents: 4200,
      validFrom: todayISO(),
      confirmInvoiceOverride: true,
    });
    expect(res.status).toBe(200);
    expect(res.data.id).toBeGreaterThan(0);
    trackedPriceIds.push(res.data.id);

    const afterAudit = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM audit_log
      WHERE action = 'standard_price_changed_invoiced'
        AND entity_type = 'service' AND entity_id = ${serviceId}
    `);
    const afterCount = (afterAudit.rows[0] as any).count as number;
    expect(afterCount).toBe(beforeCount + 1);
  });

  it("blockiert DELETE mit 409, wenn das Löschen einen abgerechneten Monat betrifft, und akzeptiert es mit Override", async () => {
    const list = await apiGet<any[]>(`${BASE}?date=${todayISO()}`);
    const active = list.data.find((r) => r.serviceId === serviceId);
    expect(active).toBeDefined();

    const blocked = await apiDelete(`${BASE}/${active.id}`);
    expect(blocked.status).toBe(409);
    expect((blocked.data as any).code).toBe("INVOICED_PERIOD_AFFECTED");

    const ok = await apiDelete(`${BASE}/${active.id}?confirmInvoiceOverride=true`);
    expect(ok.status).toBe(200);
  });
});
