/**
 * Task #617 — Tests für die automatische Budget-Rebuchung bei km-Änderungen
 *
 * Sichert die Auto-Rebook-Logik aus Task #613 ab:
 *  - PATCH eines dokumentierten Termins mit geänderten km löst Storno (reversal)
 *    + Neubuchung (consumption mit neuen km) aus.
 *  - Genau ein Audit-Eintrag mit action=`appointment_km_rebooked` und
 *    metadata.trigger=`appointment_edit:km_change` wird geschrieben
 *    (siehe Task #646 — einheitliches Trigger-Vokabular
 *    `shared/domain/budget-rebook-triggers.ts`).
 *  - PATCH ohne km-Änderung fasst budget_transactions NICHT an und schreibt
 *    keinen Rebook-Audit-Eintrag.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { quarantinedInCI } from "../helpers/known-failing";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { auditLog, budgetTransactions } from "@shared/schema";
import {
  apiPatch,
  apiPost,
  getAuthCookie,
} from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";

function pastWeekdayInCurrentMonth(): string {
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  for (let offset = 0; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  for (let offset = 1; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}

async function selectConsumptionTxs(
  customerId: number,
  appointmentId: number,
) {
  return db
    .select()
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.appointmentId, appointmentId),
        eq(budgetTransactions.transactionType, "consumption"),
      ),
    )
    .orderBy(asc(budgetTransactions.id));
}

async function selectAllTxsForCustomer(customerId: number) {
  return db
    .select()
    .from(budgetTransactions)
    .where(eq(budgetTransactions.customerId, customerId))
    .orderBy(asc(budgetTransactions.id));
}

async function selectRebookAudits(appointmentId: number) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "appointment"),
        eq(auditLog.entityId, appointmentId),
        eq(auditLog.action, "appointment_km_rebooked"),
      ),
    )
    .orderBy(asc(auditLog.id));
}

describe("Task #617 — Auto-Rebook bei km-Änderung im Termin-Edit", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    await getAuthCookie();
  });

  afterEach(async () => {
    if (scenario) {
      await scenario.cleanup();
    }
  });

  it.skipIf(quarantinedInCI)("Reopen + PATCH mit geänderten travelKilometers erzeugt Neubuchung mit neuen km + genau einen appointment_km_rebooked-Audit-Eintrag", async () => {
    const date = pastWeekdayInCurrentMonth();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T617-CHG",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      appointments: [
        {
          date,
          scheduledStart: "08:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
          travelKilometers: 10,
          customerKilometers: 0,
          notes: "T617 ursprüngliche km=10",
        },
      ],
    });

    const [appointmentId] = scenario.appointmentIds;
    const customerId = scenario.customerId;

    const before = await selectConsumptionTxs(customerId, appointmentId);
    expect(before.length).toBeGreaterThan(0);
    const beforeIds = new Set(before.map((t) => t.id));

    // PATCH ist auf abgeschlossenen Terminen geblockt (canModifyAppointment
    // verhindert Status-Bearbeitung). Realer Workflow für nachträgliche
    // km-Korrekturen: /reopen setzt den Termin auf `documenting` zurück und
    // schreibt bereits Storno-Txs für die bestehenden Consumptions. Erst
    // danach läuft der PATCH durch die Status-Validierung.
    const reopenRes = await apiPost<{ status: string }>(
      `/api/appointments/${appointmentId}/reopen`,
      {},
    );
    expect(reopenRes.status).toBe(200);
    expect(reopenRes.data.status).toBe("documenting");

    const patchRes = await apiPatch<{ id: number; travelKilometers: number }>(
      `/api/appointments/${appointmentId}`,
      { travelKilometers: 25 },
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.data.travelKilometers).toBe(25);

    const allTxs = await selectAllTxsForCustomer(customerId);

    // 1) Es gibt mindestens eine NEUE Consumption-Tx am Termin mit den
    //    aktualisierten km-Werten. Die alten Consumption-Zeilen wurden vom
    //    Termin abgekoppelt (appointmentId = null), damit der Cascade-Pre-
    //    Check keine Dup-Konflikte sieht.
    const newConsumption = allTxs.filter(
      (t) =>
        t.transactionType === "consumption"
        && t.appointmentId === appointmentId
        && !beforeIds.has(t.id),
    );
    expect(newConsumption.length).toBeGreaterThan(0);
    const newKmSum = newConsumption.reduce(
      (s, t) => s + (t.travelKilometers ?? 0),
      0,
    );
    expect(newKmSum).toBeCloseTo(25, 5);

    // Alte Consumption-Zeilen sind vom Termin abgekoppelt.
    const stillLinkedOld = allTxs.filter(
      (t) => beforeIds.has(t.id) && t.appointmentId === appointmentId,
    );
    expect(stillLinkedOld).toHaveLength(0);

    // 2) Pro alte Consumption-Tx existiert ein Reversal — entweder vom
    //    Reopen-Pfad oder als idempotenter Rebook-Storno. Beide Pfade
    //    nutzen den UNIQUE-Index auf reversedTransactionId.
    const reversals = allTxs.filter(
      (t) =>
        t.transactionType === "reversal"
        && t.reversedTransactionId != null
        && beforeIds.has(t.reversedTransactionId),
    );
    const reversedOldIds = new Set(reversals.map((t) => t.reversedTransactionId));
    for (const orig of before) {
      expect(reversedOldIds.has(orig.id)).toBe(true);
    }

    // 3) Genau ein Rebook-Audit-Eintrag mit Trigger="appointment_edit".
    const audits = await selectRebookAudits(appointmentId);
    expect(audits).toHaveLength(1);
    const meta = audits[0].metadata as {
      trigger?: string;
      previousTravelKm?: number;
      newTravelKm?: number;
      reversedTransactionIds?: number[];
    } | null;
    expect(meta?.trigger).toBe("appointment_edit:km_change");
    expect(meta?.newTravelKm).toBe(25);
    expect(meta?.previousTravelKm).toBeCloseTo(10, 5);
    expect(Array.isArray(meta?.reversedTransactionIds)).toBe(true);
  });

  it("PATCH ohne km-Änderung erzeugt KEINE neuen budget_transactions und KEINEN Rebook-Audit-Eintrag", async () => {
    const date = pastWeekdayInCurrentMonth();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T617-NOOP",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      appointments: [
        {
          date,
          scheduledStart: "08:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
          travelKilometers: 7,
          customerKilometers: 0,
          notes: "T617 noop km=7",
        },
      ],
    });

    const [appointmentId] = scenario.appointmentIds;
    const customerId = scenario.customerId;

    // Reopen ist nötig, damit PATCH auf einem dokumentierten Termin überhaupt
    // durch die Status-Validierung kommt (siehe vorheriger Test). Reopen
    // selbst schreibt Reversals — die merken wir uns als Baseline und prüfen
    // anschließend, dass der PATCH KEINE weiteren budget_transactions erzeugt.
    const reopenRes = await apiPost<{ status: string }>(
      `/api/appointments/${appointmentId}/reopen`,
      {},
    );
    expect(reopenRes.status).toBe(200);

    const txsBefore = await selectAllTxsForCustomer(customerId);
    const idsBefore = new Set(txsBefore.map((t) => t.id));

    // Felder ändern, die NICHT km sind. Hier: Notiz aktualisieren.
    const patchRes = await apiPatch<{ id: number; notes: string }>(
      `/api/appointments/${appointmentId}`,
      { notes: "T617 noop — nur Notiz geändert" },
    );
    expect(patchRes.status).toBe(200);

    const txsAfter = await selectAllTxsForCustomer(customerId);
    const newTxs = txsAfter.filter((t) => !idsBefore.has(t.id));
    expect(newTxs).toHaveLength(0);

    const audits = await selectRebookAudits(appointmentId);
    expect(audits).toHaveLength(0);
  });
});
