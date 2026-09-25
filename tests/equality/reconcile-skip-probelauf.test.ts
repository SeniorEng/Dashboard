/**
 * #193, Gate 2 Runde 3, S-1: der Vorschau-PROBELAUF schreibt keinen
 * Audit-Eintrag `budget_reconcile_skipped` — der lief auf eigener Verbindung,
 * überlebte das Zurückrollen und wurde dem ältesten Nutzer zugeschrieben.
 * Beim echten Buchen bleibt der Eintrag (Befund C-02: Anomalie nicht lautlos).
 *
 * Misst BEIDE Seiten (CLAUDE.md „Rot ohne Aussage"): ohne Probelauf entsteht
 * der Eintrag — sonst bewiese das Fehlen im Probelauf nichts.
 *
 * Der Zweig wird erreicht, wenn die übergebenen Leistungsfelder nicht zum
 * Gesamtbetrag passen: jede Buchungszeile normiert ihre Felder auf ihren
 * Betrag (`buildConsumptionTxData`), Σ Δ ≠ 0 → `logReconcileSkip`.
 *
 * Läuft im Coverage-Gate „consumption-engine" (`script/coverage-gate.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, auditLog } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie, runCleanup } from "../test-utils";
import { createCascadeConsumption } from "../../server/storage/budget/consumption-engine";

const kunden: number[] = [];
let userId: number;

class Zurueckrollen extends Error {}

async function termin(customerId: number): Promise<number> {
  const [t] = await db.insert(appointments).values({
    customerId, date: "2026-08-14", scheduledStart: "09:00", durationPromised: 60,
    status: "completed", appointmentType: "Betreuung",
  } as never).returning({ id: appointments.id });
  return t.id;
}

async function skipEintraege(appointmentId: number): Promise<number> {
  const rows = await db.select({ id: auditLog.id }).from(auditLog).where(and(
    eq(auditLog.action, "budget_reconcile_skipped"),
    eq(auditLog.entityType, "appointment"),
    eq(auditLog.entityId, appointmentId),
  ));
  return rows.length;
}

function buchung(customerId: number, appointmentId: number, extra: { probelauf?: boolean; userId?: number }) {
  // 1000 Gesamt, Felder nur 900 → Σ Δ = −100 ≠ 0 → Reconcile-Skip.
  return {
    customerId, appointmentId, transactionDate: "2026-08-14", totalAmountCents: 1000,
    hauswirtschaftMinutes: 60, hauswirtschaftCents: 900,
    alltagsbegleitungMinutes: 0, alltagsbegleitungCents: 0,
    travelKilometers: 0, travelCents: 0, customerKilometers: 0, customerKilometersCents: 0,
    skipExistingCheck: true,
    privatePot: { statutoryExcluded: true, noteKind: "selbstzahler" as const },
    ...extra,
  };
}

beforeAll(async () => {
  userId = (await getAuthCookie()).user.id;
});

afterAll(async () => {
  for (const id of kunden) await cleanupCustomer(id);
  await runCleanup();
});

describe("Reconcile-Skip: Probelauf ohne Audit, echtes Buchen mit Audit", () => {
  it("RS-1 – echtes Buchen protokolliert die Anomalie (Gegenseite)", async () => {
    const k = (await createTestCustomer({ billingType: "selbstzahler", acceptsPrivatePayment: true })).id as number;
    kunden.push(k);
    const t = await termin(k);
    await db.transaction((tx) => createCascadeConsumption(buchung(k, t, { userId }), tx));
    expect(await skipEintraege(t), "ohne Probelauf: genau ein Eintrag").toBe(1);
  }, 120_000);

  it("RS-2 – der Probelauf schreibt KEINEN Eintrag, der das Zurückrollen überlebt", async () => {
    const k = (await createTestCustomer({ billingType: "selbstzahler", acceptsPrivatePayment: true })).id as number;
    kunden.push(k);
    const t = await termin(k);
    await expect(db.transaction(async (tx) => {
      await createCascadeConsumption(buchung(k, t, { probelauf: true }), tx);
      throw new Zurueckrollen();
    })).rejects.toBeInstanceOf(Zurueckrollen);
    expect(await skipEintraege(t), "Probelauf: kein Audit-Eintrag").toBe(0);
  }, 120_000);
});
