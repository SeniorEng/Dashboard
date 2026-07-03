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
import { qontoStorage } from "../../server/storage/qonto";
import { db } from "../../server/lib/db";
import { qontoTransactions, qontoHideRules, auditLog } from "../../shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniqueId, apiPost, apiDelete } from "../test-utils";

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

// Task #1605 — Ein manuell wieder sichtbar gemachter Zahlungseingang (Override)
// darf durch einen erneuten Sync/Backfill NICHT erneut automatisch ausgeblendet
// werden. Deckt die höchstrisiko-Verhaltensweise aus #1599 end-to-end ab: eine
// Regression würde bewusst wiederhergestellte Einnahmen still ausblenden.
describe("Qonto un-hide Override überlebt Re-Sync (Task #1605)", () => {
  const otag = uniqueId();
  const TX_OVERRIDDEN = `qonto-tx-override-${otag}`;
  const TX_MATCHING = `qonto-tx-matching-${otag}`;
  // Eindeutiger Counterparty-Teilstring, damit die Regel NUR die hier
  // gesäten Transaktionen trifft (keine Fremdzeilen der geteilten Test-DB).
  const HIDE_VALUE = `finanzamt-${otag}`;
  let ruleId: number | null = null;

  async function seedCreditTx(externalId: string) {
    const [row] = await db
      .insert(qontoTransactions)
      .values({
        qontoTransactionId: externalId,
        amountCents: 5000,
        currency: "EUR",
        side: "credit",
        counterpartyName: `Finanzamt ${HIDE_VALUE}`,
        emittedAt: new Date(),
        status: "completed",
      })
      .returning();
    return row;
  }

  async function reload(externalId: string) {
    const [row] = await db
      .select()
      .from(qontoTransactions)
      .where(eq(qontoTransactions.qontoTransactionId, externalId));
    return row;
  }

  /** Mockt die Qonto-API leer, damit backfill nur die Regel-Anwendung ausübt. */
  function stubFetchEmpty() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ transactions: [], meta: { total_pages: 1 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
  }

  afterAll(async () => {
    await db
      .delete(qontoTransactions)
      .where(inArray(qontoTransactions.qontoTransactionId, [TX_OVERRIDDEN, TX_MATCHING]));
    if (ruleId !== null) {
      await db.delete(qontoHideRules).where(eq(qontoHideRules.id, ruleId));
    }
  });

  it("blendet einen un-hidden Override bei einem erneuten Backfill NICHT wieder aus, hidet aber weiterhin nicht-überschriebene Treffer", async () => {
    const overridden = await seedCreditTx(TX_OVERRIDDEN);

    // Passende Auto-Ausblenden-Regel anlegen.
    const rule = await qontoStorage.createHideRule({
      ruleType: "counterparty",
      value: HIDE_VALUE,
      createdByUserId: null,
    });
    ruleId = rule.id;

    // Erster Sync blendet die Transaktion automatisch aus.
    await qontoService.applyHideRules();
    const afterFirst = await reload(TX_OVERRIDDEN);
    expect(afterFirst.billingIrrelevantAt).not.toBeNull();
    expect(afterFirst.billingIrrelevantSource).toBe("auto");

    // Admin macht die Transaktion bewusst wieder sichtbar (spiegelt die
    // DELETE /transactions/:id/ignore-Route: Override setzen, Markierung löschen).
    await db
      .update(qontoTransactions)
      .set({
        billingIrrelevantAt: null,
        billingIrrelevantSource: null,
        billingRelevantOverrideAt: new Date(),
      })
      .where(eq(qontoTransactions.id, overridden.id));

    // Ein zweiter, NICHT-überschriebener Treffer, der weiterhin ausgeblendet
    // werden muss (Gegenprobe zur Override-Ausnahme).
    await seedCreditTx(TX_MATCHING);

    // Voller Backfill-Zyklus: fetch leer, aber applyHideRules läuft am Ende.
    stubFetchEmpty();
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    await qontoService.backfillTransactions(startDate);

    // Override überlebt: bleibt sichtbar (abrechnungsrelevant).
    const overriddenAfter = await reload(TX_OVERRIDDEN);
    expect(overriddenAfter.billingIrrelevantAt).toBeNull();
    expect(overriddenAfter.billingRelevantOverrideAt).not.toBeNull();

    // Gegenprobe: der nicht-überschriebene Treffer wird vom selben Lauf
    // automatisch ausgeblendet.
    const matchingAfter = await reload(TX_MATCHING);
    expect(matchingAfter.billingIrrelevantAt).not.toBeNull();
    expect(matchingAfter.billingIrrelevantSource).toBe("auto");
  });
});

// Task #1608 — Der manuelle „Un-hide"-Button (DELETE /transactions/:id/ignore)
// muss den Override end-to-end über die auditierte Route setzen (nicht nur per
// direktem DB-Schreiben wie #1605). Eine Regression in der Route — z.B. das
// Override zu setzen vergessen, oder der „doch nicht relevant"-Pfad, der das
// Override wieder löschen muss — würde die bisherige Coverage passieren.
// Deshalb hier die echten HTTP-Routen mit authentifiziertem Nutzer.
describe("Qonto un-hide/hide Routen setzen Override auditiert (Task #1608)", () => {
  const rtag = uniqueId();
  const TX_ROUTE = `qonto-tx-route-${rtag}`;
  const HIDE_VALUE = `finanzamt-route-${rtag}`;
  let ruleId: number | null = null;
  let txDbId: number | null = null;

  // Vorige Blöcke stubben `global.fetch` (Qonto-API-Mock) und stellen es nicht
  // immer wieder her. Diese Suite ruft ECHTE HTTP-Routen über `apiPost`/
  // `apiDelete` (= `fetch`) auf → das echte `fetch` muss wieder aktiv sein,
  // sonst schlägt schon das Login (kein Set-Cookie) fehl.
  beforeAll(() => {
    vi.unstubAllGlobals();
  });

  async function seedCreditTx(externalId: string) {
    const [row] = await db
      .insert(qontoTransactions)
      .values({
        qontoTransactionId: externalId,
        amountCents: 7500,
        currency: "EUR",
        side: "credit",
        counterpartyName: `Finanzamt ${HIDE_VALUE}`,
        emittedAt: new Date(),
        status: "completed",
      })
      .returning();
    return row;
  }

  async function reload(id: number) {
    const [row] = await db
      .select()
      .from(qontoTransactions)
      .where(eq(qontoTransactions.id, id));
    return row;
  }

  async function countAudit(action: string, entityId: number): Promise<number> {
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, action),
        eq(auditLog.entityType, "qonto_transaction"),
        eq(auditLog.entityId, entityId),
      ));
    return rows.length;
  }

  afterAll(async () => {
    // audit_log ist GoBD-unveränderbar (Trigger) → Löschen nur über Bypass-GUC.
    if (txDbId !== null) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
        await tx.delete(auditLog).where(and(
          eq(auditLog.entityType, "qonto_transaction"),
          eq(auditLog.entityId, txDbId!),
        ));
      });
    }
    await db
      .delete(qontoTransactions)
      .where(eq(qontoTransactions.qontoTransactionId, TX_ROUTE));
    if (ruleId !== null) {
      await db.delete(qontoHideRules).where(eq(qontoHideRules.id, ruleId));
    }
  });

  it("DELETE /transactions/:id/ignore setzt den Override, auditiert ihn und schützt vor erneutem Auto-Hide", async () => {
    const seeded = await seedCreditTx(TX_ROUTE);
    txDbId = seeded.id;

    // Passende Auto-Ausblenden-Regel: würde ohne Override erneut greifen.
    const rule = await qontoStorage.createHideRule({
      ruleType: "counterparty",
      value: HIDE_VALUE,
      createdByUserId: null,
    });
    ruleId = rule.id;

    // Erst manuell ausblenden (POST-Route), damit ein DELETE etwas aufzuheben hat.
    const hideRes = await apiPost(`/api/admin/qonto/transactions/${txDbId}/ignore`, {});
    expect(hideRes.status).toBe(200);
    const afterHide = await reload(txDbId);
    expect(afterHide.billingIrrelevantAt).not.toBeNull();
    expect(afterHide.billingIrrelevantSource).toBe("manual");
    expect(await countAudit("qonto_transaction_marked_irrelevant", txDbId)).toBe(1);

    // Jetzt der eigentliche „Un-hide"-Button: DELETE-Route.
    const unhideRes = await apiDelete(`/api/admin/qonto/transactions/${txDbId}/ignore`);
    expect(unhideRes.status).toBe(200);

    const afterUnhide = await reload(txDbId);
    // Override gesetzt, Markierung + Quelle gelöscht.
    expect(afterUnhide.billingIrrelevantAt).toBeNull();
    expect(afterUnhide.billingIrrelevantSource).toBeNull();
    expect(afterUnhide.billingRelevantOverrideAt).not.toBeNull();

    // Audit-Zeile für das Aufheben.
    expect(await countAudit("qonto_transaction_unmarked_irrelevant", txDbId)).toBe(1);

    // Der eigentliche Schutz: applyHideRules darf die Transaktion trotz
    // passender Regel NICHT wieder ausblenden.
    await qontoService.applyHideRules();
    const afterRules = await reload(txDbId);
    expect(afterRules.billingIrrelevantAt).toBeNull();
    expect(afterRules.billingRelevantOverrideAt).not.toBeNull();
  });

  it("POST /transactions/:id/ignore löscht einen bestehenden Override wieder (bewusstes Ausblenden gewinnt)", async () => {
    // Vorbedingung aus dem vorigen Test: Transaktion ist sichtbar mit Override.
    expect(txDbId).not.toBeNull();
    const before = await reload(txDbId!);
    expect(before.billingRelevantOverrideAt).not.toBeNull();

    const hideRes = await apiPost(`/api/admin/qonto/transactions/${txDbId}/ignore`, {});
    expect(hideRes.status).toBe(200);

    const after = await reload(txDbId!);
    // Ausblenden gesetzt, Override wieder gelöscht.
    expect(after.billingIrrelevantAt).not.toBeNull();
    expect(after.billingIrrelevantSource).toBe("manual");
    expect(after.billingRelevantOverrideAt).toBeNull();

    // Zweite marked_irrelevant-Audit-Zeile (die erste stammt aus dem 1. Test).
    expect(await countAudit("qonto_transaction_marked_irrelevant", txDbId!)).toBe(2);
  });
});
