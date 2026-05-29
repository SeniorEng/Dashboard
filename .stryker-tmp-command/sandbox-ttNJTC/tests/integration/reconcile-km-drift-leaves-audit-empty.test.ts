/**
 * Task #623 — Regressionstest für Task #619:
 *   Nach erfolgreichem `reconcileKmDrift({ apply: true, ... })` darf der
 *   Boot-Audit (`auditAppointmentBudgetKmDrift`) bzw. das Gegenstück
 *   `findDriftCandidates({ toleranceKm: 0.05 })` KEINE Treffer mehr melden.
 *
 *   Wir erzeugen 3 Termine mit künstlich gedrifteten Budget-Buchungen
 *   (per DB-Mutation von `appointments.travelKilometers` /
 *   `customerKilometers` NACH der Dokumentation), lassen das Korrektur-
 *   Skript laufen und erwarten anschließend einen leeren Drift-Scan.
 *   Zusätzlich prüfen wir, dass pro Termin ein
 *   `budget_transaction_corrected`-Audit-Eintrag mit `batchId` und
 *   `reason` geschrieben wurde — andernfalls wäre die GoBD-Attribution
 *   gebrochen.
 */
// @ts-nocheck

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, auditLog, users } from "@shared/schema";
import {
  findDriftCandidates,
  reconcileKmDrift,
} from "../../server/scripts/reconcile-km-drift";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { getAuthCookie, runCleanup } from "../test-utils";

// Letzte N Werktage (vor "heute"), kalender-stabil über Monatsgrenzen hinweg.
// Bewusst NICHT auf den aktuellen Monat eingeschränkt — sonst flakt der Test
// in den ersten Tagen eines Monats (Code-Review-Feedback zu Task #623).
function lastNWeekdays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let offset = 1; offset <= 60 && out.length < n; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().split("T")[0]);
  }
  if (out.length < n) {
    throw new Error(`Konnte nur ${out.length} vergangene Werktage finden (benötigt ${n})`);
  }
  return out;
}

describe("Task #623 — Boot-Audit ist nach Korrektur-Skript leer", () => {
  let scenario: BudgetScenarioHandle;
  let superadminUserId: number;
  let wasSuperadmin = false;

  beforeAll(async () => {
    const auth = await getAuthCookie();
    superadminUserId = auth.user.id;

    // Aktuellen `isSuperAdmin`-Zustand merken und für den Lauf hochstufen
    // (das Skript verlangt einen Superadmin als Audit-Akteur, ist aber
    // beim direkten `reconcileKmDrift`-Aufruf nicht über `assertSuperadmin`
    // abgesichert — wir setzen das Flag trotzdem, damit der Test die
    // dokumentierte CLI-Voraussetzung widerspiegelt).
    const [u] = await db
      .select({ isSuperAdmin: users.isSuperAdmin })
      .from(users)
      .where(eq(users.id, superadminUserId))
      .limit(1);
    wasSuperadmin = !!u?.isSuperAdmin;
    if (!wasSuperadmin) {
      await db
        .update(users)
        .set({ isSuperAdmin: true })
        .where(eq(users.id, superadminUserId));
    }

    const dates = lastNWeekdays(3);
    // Budget-Anker am frühesten Termin-Jahr verankern — vermeidet Jahres-
    // Grenzen-Flake (early January: lastNWeekdays() liefert ggf. Dezember
    // des Vorjahres, ein auf `currentYear-01-01` gepinnter Budget-Start
    // läge dann nach den Terminen).
    const earliestYear = Math.min(...dates.map((d) => parseInt(d.slice(0, 4), 10)));
    const budgetStart = `${earliestYear}-01-01`;

    scenario = await setupBudgetScenario({
      customerNamePrefix: "T623",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: budgetStart },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: 200000, // 2000 € — reicht für 3 Termine + Reisekosten
        validFrom: budgetStart,
      },
      appointments: dates.map((date, i) => ({
        date,
        scheduledStart: `${String(8 + i).padStart(2, "0")}:00`,
        services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
        document: true,
        travelKilometers: 7,
        customerKilometers: 3,
        notes: `T623-Drift-Setup-${i}`,
      })),
    });
  }, 120_000);

  afterAll(async () => {
    if (scenario) {
      await scenario.cleanup();
    }
    if (!wasSuperadmin) {
      await db
        .update(users)
        .set({ isSuperAdmin: false })
        .where(eq(users.id, superadminUserId));
    }
    await runCleanup();
  });

  it("findet Drift, repariert ihn, hinterlässt einen leeren Boot-Audit und schreibt Audit-Einträge", async () => {
    const apptIds = [...scenario.appointmentIds];
    expect(apptIds.length).toBe(3);

    // 1) Drift künstlich erzeugen: appt-km von 7 → 70 (travel) und 3 → 30
    //    (customer). Die bereits gebuchten budget_transactions bleiben bei
    //    den Original-km, sodass die Differenz weit > 0,05 km liegt.
    await db
      .update(appointments)
      .set({ travelKilometers: 70, customerKilometers: 30 })
      .where(inArray(appointments.id, apptIds));

    // 2) Drift-Scan vor der Korrektur — alle drei Termine müssen auftauchen.
    const beforeCandidates = await findDriftCandidates({
      appointmentIds: apptIds,
      toleranceKm: 0.05,
    });
    expect(beforeCandidates.map((c) => c.appointmentId).sort()).toEqual(
      [...apptIds].sort(),
    );

    // 3) Korrektur-Skript scharf ausführen.
    const reason = "Task #623 Regressionstest — km-Drift Korrekturlauf";
    const summary = await reconcileKmDrift({
      appointmentIds: apptIds,
      apply: true,
      toleranceKm: 0.05,
      userId: superadminUserId,
      reason,
    });

    expect(summary.repaired).toBe(3);
    expect(summary.errored).toBe(0);
    expect(summary.batchId).toBeTruthy();

    // 4) Erwartete Kern-Invariante: Boot-Audit ist leer.
    const afterCandidates = await findDriftCandidates({
      appointmentIds: apptIds,
      toleranceKm: 0.05,
    });
    expect(afterCandidates).toHaveLength(0);

    // 5) Pro Termin ein `budget_transaction_corrected`-Audit-Eintrag mit
    //    batchId und reason.
    const perApptAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "budget_transaction_corrected"),
          eq(auditLog.entityType, "appointment"),
          inArray(auditLog.entityId, apptIds),
        ),
      );
    expect(perApptAudits).toHaveLength(3);
    for (const a of perApptAudits) {
      const meta = (a.metadata ?? {}) as Record<string, unknown>;
      expect(meta.batchId).toBe(summary.batchId);
      expect(meta.reason).toBe(reason);
      expect(meta.newTravelKm).toBe(70);
      expect(meta.newCustomerKm).toBe(30);
      expect(Array.isArray(meta.reversedTransactionIds)).toBe(true);
      expect((meta.reversedTransactionIds as unknown[]).length).toBeGreaterThan(0);
    }

    // 6) Zusätzlich der Sammel-Audit-Eintrag pro Lauf.
    const batchAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "budget_transaction_corrected_batch"),
          eq(auditLog.userId, superadminUserId),
        ),
      );
    const myBatch = batchAudit.find(
      (b) => ((b.metadata ?? {}) as Record<string, unknown>).batchId === summary.batchId,
    );
    expect(myBatch).toBeDefined();
    const batchMeta = (myBatch!.metadata ?? {}) as Record<string, unknown>;
    expect(batchMeta.repaired).toBe(3);
    expect(batchMeta.reason).toBe(reason);
  }, 180_000);
});
