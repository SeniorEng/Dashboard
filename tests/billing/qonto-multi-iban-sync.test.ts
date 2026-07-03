/**
 * Task #1587 — Qonto-Sync über mehrere Konten (gleicher Login, andere IBAN).
 *
 * Verifiziert:
 *  1. `syncTransactions` fragt die Qonto-API für JEDE überwachte IBAN
 *     (primär + zusätzlich) ab.
 *  2. Jede importierte Transaktion wird mit ihrer Quell-IBAN (`sourceIban`)
 *     gestempelt.
 *  3. `testConnection` validiert alle Konten und liefert pro Konto einen
 *     Status (`accounts[]`).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { storage } from "../../server/storage";
import { qontoService } from "../../server/services/qonto";
import { db } from "../../server/lib/db";
import { qontoTransactions } from "../../shared/schema";
import { inArray } from "drizzle-orm";
import { uniqueId } from "../test-utils";

const PRIMARY_IBAN = "DE00PRIMARY0000000001";
const SECOND_IBAN = "DE00SECOND0000000002";

const tag = uniqueId();
const TX_PRIMARY = `qonto-tx-primary-${tag}`;
const TX_SECOND = `qonto-tx-second-${tag}`;

function txPayload(id: string, iban: string) {
  return {
    transaction_id: id,
    amount_cents: 12345,
    currency: "EUR",
    side: "credit",
    counterparty: `Zahler ${iban.slice(-4)}`,
    reference: `RE-${iban.slice(-4)}`,
    label: "Test",
    emitted_at: new Date().toISOString(),
    status: "completed",
  };
}

let savedSettings: { qontoLogin: string | null; qontoSecretKey: string | null; qontoIban: string | null; qontoAdditionalIbans: string[] };

beforeAll(async () => {
  const current = await storage.getCompanySettings();
  savedSettings = {
    qontoLogin: current.qontoLogin ?? null,
    qontoSecretKey: current.qontoSecretKey ?? null,
    qontoIban: current.qontoIban ?? null,
    qontoAdditionalIbans: current.qontoAdditionalIbans ?? [],
  };

  await storage.updateCompanySettings(
    {
      qontoLogin: "test-login",
      qontoSecretKey: "test-secret",
      qontoIban: PRIMARY_IBAN,
      qontoAdditionalIbans: [SECOND_IBAN],
    },
    null,
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await storage.updateCompanySettings(savedSettings, null);
  await db.delete(qontoTransactions).where(
    inArray(qontoTransactions.qontoTransactionId, [TX_PRIMARY, TX_SECOND]),
  );
});

/** Mockt die Qonto-API: liefert pro IBAN je genau eine Transaktion. */
function stubFetchPerIban() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(input.toString());
      const iban = url.searchParams.get("iban");
      const page = url.searchParams.get("page") ?? "1";

      let transactions: unknown[] = [];
      // Nur Seite 1 liefert Daten, damit die Pagination terminiert.
      if (page === "1") {
        if (iban === PRIMARY_IBAN) transactions = [txPayload(TX_PRIMARY, PRIMARY_IBAN)];
        else if (iban === SECOND_IBAN) transactions = [txPayload(TX_SECOND, SECOND_IBAN)];
      }

      return new Response(
        JSON.stringify({ transactions, meta: { total_pages: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

describe("Qonto Multi-IBAN Sync (Task #1587)", () => {
  it("synchronisiert alle überwachten Konten und stempelt die Quell-IBAN", async () => {
    stubFetchPerIban();

    const result = await qontoService.syncTransactions();
    expect(result.synced).toBe(2);

    const rows = await db
      .select()
      .from(qontoTransactions)
      .where(inArray(qontoTransactions.qontoTransactionId, [TX_PRIMARY, TX_SECOND]));

    const byId = new Map(rows.map((r) => [r.qontoTransactionId, r]));
    expect(byId.get(TX_PRIMARY)?.sourceIban).toBe(PRIMARY_IBAN);
    expect(byId.get(TX_SECOND)?.sourceIban).toBe(SECOND_IBAN);

    // fetch wurde für BEIDE IBANs aufgerufen.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const calledIbans = fetchMock.mock.calls.map(
      (c) => new URL(c[0].toString()).searchParams.get("iban"),
    );
    expect(calledIbans).toContain(PRIMARY_IBAN);
    expect(calledIbans).toContain(SECOND_IBAN);
  });

  it("testConnection validiert alle Konten und liefert pro Konto einen Status", async () => {
    stubFetchPerIban();

    const conn = await qontoService.testConnection();
    expect(conn.success).toBe(true);
    expect(conn.accounts).toHaveLength(2);
    const ibans = (conn.accounts ?? []).map((a) => a.iban).sort();
    expect(ibans).toEqual([PRIMARY_IBAN, SECOND_IBAN].sort());
    expect((conn.accounts ?? []).every((a) => a.success)).toBe(true);
  });

  // Task #1599 — Backfill zieht ALLE Konten (primär + Zusatz) ab einem Startdatum
  // per emitted_at-Fenster (ersetzt den additional-only Voll-Sync aus #1588).
  it("backfillTransactions synchronisiert ALLE Konten ab Startdatum per emitted_at-Fenster", async () => {
    stubFetchPerIban();

    // Startdatum am Monatsersten des aktuellen Monats → genau ein Monats-Fenster.
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

    const result = await qontoService.backfillTransactions(startDate);
    expect(result.accounts).toBe(2);
    expect(result.synced).toBe(2);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const calledUrls = fetchMock.mock.calls.map((c) => new URL(c[0].toString()));
    const calledIbans = calledUrls.map((u) => u.searchParams.get("iban"));

    // BEIDE Konten werden abgefragt (nicht mehr nur die Zusatzkonten).
    expect(calledIbans).toContain(PRIMARY_IBAN);
    expect(calledIbans).toContain(SECOND_IBAN);

    // Datums-Fenster über emitted_at (kein updated_at_from mehr).
    for (const url of calledUrls) {
      expect(url.searchParams.get("updated_at_from")).toBeNull();
      expect(url.searchParams.get("emitted_at_from")).not.toBeNull();
      expect(url.searchParams.get("emitted_at_to")).not.toBeNull();
      expect(url.searchParams.get("status")).toBe("completed");
      expect(url.searchParams.get("side")).toBe("credit");
    }
    // Das erste Fenster beginnt exakt am gewählten Startdatum.
    expect(calledUrls[0].searchParams.get("emitted_at_from")).toBe(startDate.toISOString());

    // Beide Transaktionen sind mit ihrer Quell-IBAN gestempelt.
    const rows = await db
      .select()
      .from(qontoTransactions)
      .where(inArray(qontoTransactions.qontoTransactionId, [TX_PRIMARY, TX_SECOND]));
    const byId = new Map(rows.map((r) => [r.qontoTransactionId, r]));
    expect(byId.get(TX_PRIMARY)?.sourceIban).toBe(PRIMARY_IBAN);
    expect(byId.get(TX_SECOND)?.sourceIban).toBe(SECOND_IBAN);
  });
});
