/**
 * Task #875 (Budget GF Phase 5) — Hard-Hold-Engine (Integration, DB + Server).
 *
 * Testet die Reservierungs-Engine DIREKT gegen die DB (nicht über die
 * gegateten Routen — der laufende Test-Server startet ohne `BUDGET_HARD_HOLDS`,
 * sodass der HTTP-Pfad byte-identisch zum Legacy bleibt). Hier rufen wir
 * `planHold`/`captureHolds`/`releaseHolds` direkt auf und prüfen die
 * Kern-Invarianten:
 *   - N2/R5/I13/I15 Idempotenz: planHold/captureHolds/releaseHolds doppelt
 *     ausgeführt erzeugen KEINE Duplikate.
 *   - R3/N3/I14 Overdraft: planHold ohne Privatzahlung über Budget wirft
 *     BudgetHardBlockError und schreibt KEINE Hold-Zeile (kein Limbo).
 *   - Capture spiegelt die Legacy-Konsumtion in den Ledger und überführt den
 *     Hold auf `captured`.
 *   - Release überführt aktive Holds auf `released` (idempotent).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetReservations, budgetLedger } from "@shared/schema";
import {
  planHold,
  captureHolds,
  releaseHolds,
  rescheduleHold,
} from "../../server/storage/budget/reservation-storage";
import { BudgetHardBlockError } from "@shared/domain/budget/over-budget-error";
import { readUnifiedBudgetAvailability } from "../../server/storage/budget/unified-reader";
import { apiPost, apiGet, getAuthCookie } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";

function pastWeekdayInCurrentMonth(): string {
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  for (let offset = 1; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  for (let offset = 0; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}

/**
 * Task #912 — deterministischer Termin in einem ZUKÜNFTIGEN Monat (relativ zu
 * heute), plus der erste Tag dieses Monats als §45b-`validFrom`. Robust übers
 * ganze Jahr inkl. Jahreswechsel (Dezember → Januar Folgejahr). Tag liegt in der
 * Monatsmitte auf einem Werktag (Mo–Fr), damit `/api/appointments/kundentermin`
 * nicht an Wochenenden scheitert.
 */
function futureMonthWeekday(): { date: string; monthStart: string } {
  const today = new Date();
  let year = today.getFullYear();
  let month = today.getMonth() + 2; // 1-based, ein Monat in die Zukunft
  if (month > 12) {
    month -= 12;
    year += 1;
  }
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  for (let day = 15; day <= 28; day++) {
    const d = new Date(year, month - 1, day);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return {
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      monthStart,
    };
  }
  throw new Error("Kein Werktag in der Monatsmitte gefunden");
}

async function holdRows(appointmentId: number) {
  return db
    .select()
    .from(budgetReservations)
    .where(eq(budgetReservations.appointmentId, appointmentId));
}

describe("Task #875 — Hard-Hold-Engine (gated)", () => {
  let scenario: BudgetScenarioHandle | undefined;

  beforeAll(async () => {
    await getAuthCookie();
  });

  afterEach(async () => {
    if (scenario) {
      await scenario.cleanup();
      scenario = undefined;
    }
  });

  it("planHold ist idempotent (N2/I13/I15): zweiter Aufruf erzeugt keine neuen Holds", async () => {
    const date = pastWeekdayInCurrentMonth();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T875-PLAN",
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
          document: false,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    const [appointmentId] = scenario.appointmentIds;
    const customerId = scenario.customerId;

    const first = await planHold({
      customerId,
      appointmentId,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
    });
    expect(first.heldCents).toBeGreaterThan(0);
    expect(first.reservations.length).toBeGreaterThan(0);
    const afterFirst = await holdRows(appointmentId);
    expect(afterFirst.length).toBe(first.reservations.length);

    const second = await planHold({
      customerId,
      appointmentId,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
    });
    expect(second.heldCents).toBe(first.heldCents);
    const afterSecond = await holdRows(appointmentId);
    expect(afterSecond.length).toBe(afterFirst.length);
  });

  it("overdraft ohne Privatzahlung wirft BudgetHardBlockError und schreibt keinen Hold (R3/I14/N3)", async () => {
    const date = pastWeekdayInCurrentMonth();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T875-OVERDRAFT",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 100 },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      appointments: [
        {
          date,
          scheduledStart: "08:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 120 }],
          document: false,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    const [appointmentId] = scenario.appointmentIds;
    const customerId = scenario.customerId;

    await expect(
      planHold({
        customerId,
        appointmentId,
        transactionDate: date,
        hauswirtschaftMinutes: 120,
        alltagsbegleitungMinutes: 0,
        travelKilometers: 0,
        customerKilometers: 0,
      }),
    ).rejects.toBeInstanceOf(BudgetHardBlockError);

    const rows = await holdRows(appointmentId);
    const activeHolds = rows.filter((r) => r.state === "hold");
    expect(activeHolds.length).toBe(0);
  });

  it("captureHolds spiegelt Legacy-Konsumtion in den Ledger und ist idempotent (R5/I15)", async () => {
    const date = pastWeekdayInCurrentMonth();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T875-CAPTURE",
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
          document: false,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    const [appointmentId] = scenario.appointmentIds;
    const customerId = scenario.customerId;

    await planHold({
      customerId,
      appointmentId,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
    });

    // Legacy-Abschluss über die (ungegatete) Route → schreibt budget_transactions.
    const svcRes = await apiGet<Array<{ serviceId: number }>>(
      `/api/appointments/${appointmentId}/services`,
    );
    expect(svcRes.status).toBe(200);
    const services = svcRes.data.map((s) => ({
      serviceId: s.serviceId,
      actualDurationMinutes: 60,
      details: "T875 capture",
    }));
    const docRes = await apiPost(`/api/appointments/${appointmentId}/document`, {
      actualStart: "08:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services,
    });
    expect([200, 201]).toContain(docRes.status);

    const capture = await db.transaction((tx) =>
      captureHolds({ customerId, appointmentId }, tx),
    );
    expect(capture.capturedCount).toBeGreaterThan(0);
    expect(capture.ledgerIds.length).toBeGreaterThan(0);

    const captured = (await holdRows(appointmentId)).filter((r) => r.state === "captured");
    expect(captured.length).toBeGreaterThan(0);

    const ledgerAfterFirst = await db
      .select()
      .from(budgetLedger)
      .where(and(eq(budgetLedger.appointmentId, appointmentId), eq(budgetLedger.state, "consumed")));
    expect(ledgerAfterFirst.length).toBeGreaterThan(0);

    // Reconciliation auf Reservierungs-Ebene: der captured Hold trägt den
    // tatsächlich gebuchten Ist-Betrag seines Topfes (nicht mehr den Hold-Schätzwert).
    const actualByType = new Map<string, number>();
    for (const l of ledgerAfterFirst) {
      actualByType.set(l.budgetType, (actualByType.get(l.budgetType) ?? 0) + Math.abs(l.amountCents));
    }
    for (const c of captured) {
      expect(c.amountCents).toBe(actualByType.get(c.budgetType));
    }

    // Replay → keine zusätzlichen Ledger-Zeilen (idempotencyKey UNIQUE).
    await db.transaction((tx) => captureHolds({ customerId, appointmentId }, tx));
    const ledgerAfterReplay = await db
      .select()
      .from(budgetLedger)
      .where(and(eq(budgetLedger.appointmentId, appointmentId), eq(budgetLedger.state, "consumed")));
    expect(ledgerAfterReplay.length).toBe(ledgerAfterFirst.length);
  });

  it("releaseHolds überführt aktive Holds auf released (idempotent)", async () => {
    const date = pastWeekdayInCurrentMonth();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T875-RELEASE",
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
          document: false,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    const [appointmentId] = scenario.appointmentIds;
    const customerId = scenario.customerId;

    await planHold({
      customerId,
      appointmentId,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
    });
    expect((await holdRows(appointmentId)).filter((r) => r.state === "hold").length).toBeGreaterThan(0);

    const releasedCount = await releaseHolds(appointmentId);
    expect(releasedCount).toBeGreaterThan(0);
    expect((await holdRows(appointmentId)).filter((r) => r.state === "hold").length).toBe(0);
    expect((await holdRows(appointmentId)).filter((r) => r.state === "released").length).toBeGreaterThan(0);

    // Replay → 0 weitere Freigaben.
    const replay = await releaseHolds(appointmentId);
    expect(replay).toBe(0);
  });

  it("rescheduleHold gibt alte Holds frei UND legt neue an (I19, revisionierter Key)", async () => {
    const date = pastWeekdayInCurrentMonth();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T875-RESCHED",
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
          document: false,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    const [appointmentId] = scenario.appointmentIds;
    const customerId = scenario.customerId;

    const first = await planHold({
      customerId,
      appointmentId,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
    });
    const firstActive = (await holdRows(appointmentId)).filter((r) => r.state === "hold");
    expect(firstActive.length).toBe(first.reservations.length);
    const firstKeys = firstActive.map((r) => r.idempotencyKey).sort();

    // Reschedule = release alte Holds + plane neue, alles in EINER Transaktion.
    const rescheduled = await rescheduleHold({
      customerId,
      appointmentId,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
    });
    expect(rescheduled.reservations.length).toBe(first.reservations.length);

    const all = await holdRows(appointmentId);
    const active = all.filter((r) => r.state === "hold");
    const released = all.filter((r) => r.state === "released");
    // Alte Holds wurden freigegeben ...
    expect(released.length).toBe(firstActive.length);
    // ... UND neue aktive Holds existieren (Defekt I19: vorher 0, weil der
    // global-eindeutige idempotency_key auf den alten Schlüssel kollidierte).
    expect(active.length).toBe(first.reservations.length);
    // Neue Holds tragen revisionierte, eindeutige Keys (kein onConflict-Swallow).
    const activeKeys = active.map((r) => r.idempotencyKey).sort();
    for (const k of activeKeys) {
      expect(firstKeys).not.toContain(k);
    }
  });

  it("captureHolds: Ist > Hold passt in denselben Topf → kein Fehlblock (R4/I16, case b)", async () => {
    const date = pastWeekdayInCurrentMonth();

    // 1) Probe: tatsächliche §45b-Ist-Kosten von 90 Min Hauswirtschaft ermitteln
    //    (großzügiges Budget, Privatzahlung erlaubt → voller Betrag landet im §45b-Topf).
    const probe = await setupBudgetScenario({
      customerNamePrefix: "T875-RECON-PROBE",
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
          services: [{ code: "hauswirtschaft", durationMinutes: 90 }],
          document: true,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    const actualA = Math.abs(probe.transactions[0]?.amountCents ?? 0);
    await probe.cleanup();
    expect(actualA).toBeGreaterThan(0);

    // 2) Echtes Szenario: §45b-Topf exakt = Ist(90min), KEINE Privatzahlung.
    //    Hold über nur 60min (< Ist). Die Legacy-Ist-Buchung über 90min füllt den
    //    Topf vollständig (availableCents danach = 0). VOR dem Headroom-Fix (R4/I16)
    //    hätte captureHolds hier fälschlich OverBudgetCompletionError geworfen, weil
    //    der bereits gebuchte Ist den Headroom auf 0 drückt; nach dem Fix wird der
    //    Ist-Anteil dieses Termins zurückaddiert → case-b (same_pot_extend).
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T875-RECON",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: actualA },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      appointments: [
        {
          date,
          scheduledStart: "08:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 90 }],
          document: false,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    const [appointmentId] = scenario.appointmentIds;
    const customerId = scenario.customerId;

    const plan = await planHold({
      customerId,
      appointmentId,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
    });
    expect(plan.heldCents).toBeGreaterThan(0);
    expect(plan.heldCents).toBeLessThan(actualA);

    // Legacy-Abschluss über 90min → bucht Ist=actualA in §45b (Topf danach leer).
    const svcRes = await apiGet<Array<{ serviceId: number }>>(
      `/api/appointments/${appointmentId}/services`,
    );
    expect(svcRes.status).toBe(200);
    const services = svcRes.data.map((s) => ({
      serviceId: s.serviceId,
      actualDurationMinutes: 90,
      details: "T875 recon",
    }));
    const docRes = await apiPost(`/api/appointments/${appointmentId}/document`, {
      actualStart: "08:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services,
    });
    expect([200, 201]).toContain(docRes.status);

    // Capture darf NICHT hart blocken: der Mehrbetrag passt in denselben Topf.
    const capture = await db.transaction((tx) =>
      captureHolds({ customerId, appointmentId }, tx),
    );
    expect(capture.reconciliationCase).toBe("same_pot_extend");
    expect(capture.capturedCount).toBeGreaterThan(0);

    const captured = (await holdRows(appointmentId)).filter((r) => r.state === "captured");
    const capturedTotal = captured.reduce((s, r) => s + r.amountCents, 0);
    expect(capturedTotal).toBe(actualA);
  });

  it("Task #912: zukünftiger §45b-Termin wird über die projizierte Vorausschau gebucht statt fälschlich hart geblockt", async () => {
    // §45b beginnt erst im ZUKÜNFTIGEN Termin-Monat (validFrom = 1. des Monats).
    // → Bis HEUTE ist 0 € §45b aufgelaufen (Horizont des unified Readers = heute,
    //   liegt VOR validFrom), aber bis zum Termin-Monat projiziert genau ein
    //   Monats-Anspruch. KEINE Privatzahlung, KEINE anderen Töpfe: Vor dem Fix
    //   (planHold las die nackte As-of-Verfügbarkeit = 0) hätte das einen
    //   BudgetHardBlockError ausgelöst; nach dem Fix bucht planHold gegen die
    //   projizierte §45b-Verfügbarkeit (gleicher Horizont wie die Overview).
    const { date, monthStart } = futureMonthWeekday();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T912-PROJ",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      types: [
        {
          type: "entlastungsbetrag_45b",
          priority: 1,
          enabled: true,
          monthlyLimitCents: null,
          validFrom: monthStart,
        },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      appointments: [
        {
          date,
          scheduledStart: "08:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: false,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    const [appointmentId] = scenario.appointmentIds;
    const customerId = scenario.customerId;

    // Vorbedingung: die NACKTE As-of-Verfügbarkeit (alte planHold-Sicht) ist 0 —
    // genau das hätte vorher hart geblockt.
    const bareAvail = await readUnifiedBudgetAvailability(customerId, date);
    expect(bareAvail.pots.entlastungsbetrag_45b.availableCents).toBe(0);

    // Nach dem Fix: planHold bucht erfolgreich gegen die Projektion.
    const plan = await planHold({
      customerId,
      appointmentId,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
    });
    expect(plan.heldCents).toBeGreaterThan(0);
    // Der Hold liegt im §45b-Topf (nicht privat, da nur §45b aktiv ist).
    const held45b = plan.reservations.filter(
      (r) => r.budgetType === "entlastungsbetrag_45b",
    );
    expect(held45b.length).toBeGreaterThan(0);
    expect(held45b.reduce((s, r) => s + r.amountCents, 0)).toBe(plan.heldCents);
    // Es bleibt KEIN Rest → kein Hard-Block trotz fehlender Privatzahlung.
    const active = (await holdRows(appointmentId)).filter((r) => r.state === "hold");
    expect(active.length).toBe(held45b.length);
  });
});
