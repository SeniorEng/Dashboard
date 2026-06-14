/**
 * Task #963 — Storno-Datum koppelt an die Originalbuchung (Stichtag-Fenster).
 *
 * Bug: `reverseBudgetTransaction` legte die Reversal-Zeile mit
 * `transactionDate = todayISO()` an statt mit dem `transactionDate` der
 * stornierten Original-Consumption. Der Budget-Verbrauch wird aber
 * stichtagsbezogen gerechnet:
 *
 *     netConsumed(asOfDate) = Σ|consumption ≤ asOfDate| − Σ|reversal ≤ asOfDate|
 *
 * (siehe `server/storage/budget/unified-reader.ts → netConsumedUpToDate`).
 * Wurde ein Termin NACH seinem Termindatum storniert, lag das Reversal-Datum
 * (= heute) AUSSERHALB des Stichtag-Fensters einer Abfrage am Termindatum: die
 * Gutschrift fiel raus, die Original-Consumption blieb drin → der Topf wirkte
 * fälschlich überzogen und ein real dokumentierbarer Termin wurde hart
 * geblockt.
 *
 * Dieser Test fährt den ECHTEN DB-Reversal-Pfad (`reverseBudgetTransaction` via
 * `budgetStorage`) und prüft beides:
 *   (A) Unit-Invariante: die Reversal-Zeile erbt exakt das `transactionDate` der
 *       stornierten Consumption (datum-unabhängig, immer geprüft).
 *   (B) Verhalten: eine Stichtag-Abfrage AM (vergangenen) Termindatum sieht nach
 *       dem Storno wieder den vollen Topf (`totalUsedCents === 0`) — vor dem Fix
 *       hätte das „heute"-datierte Reversal hier gefehlt und Verbrauch > 0
 *       gezeigt.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, budgetTransactions } from "@shared/schema";
import { todayISO } from "@shared/utils/datetime";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { budgetStorage } from "../../server/storage/budget-storage";
import { apiGet, apiPost, createTestCustomer, getAuthCookie, runCleanup } from "../test-utils";

interface OverviewResponse {
  entlastungsbetrag45b: {
    totalAllocatedCents: number;
    totalUsedCents: number;
    availableCents: number;
  };
}

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function actorId(): Promise<number> {
  const rows = await db.execute(/* sql */ `SELECT id FROM users ORDER BY id ASC LIMIT 1`);
  const r = (rows as { rows: Array<{ id: number }> }).rows;
  if (!r[0]) throw new Error("Kein User für Audit-Akteur verfügbar");
  return r[0].id;
}

describe("Task #963 — Storno erbt transactionDate der Originalbuchung", () => {
  it("Storno NACH dem Termindatum: Reversal erbt Termin-Datum ⇒ Stichtag-Fenster am Termin nettet auf null", async () => {
    const now = new Date();
    const cy = now.getFullYear();
    const startDate = `${cy}-01-01`;
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;

    // Termindatum: deutlich in der Vergangenheit (10 Tage zurück), aber nicht
    // vor den 10. Januar des laufenden Jahres (der §45b-Laufzeit-Pfad bodet den
    // Aufstockungs-Anker aufs laufende Jahr). So liegt das Termindatum im
    // §45b-Fenster UND vor „heute", womit das fehl-datierte Reversal (heute)
    // aus dem Termin-Stichtag-Fenster fiele.
    let apptDay = new Date(now);
    apptDay.setDate(apptDay.getDate() - 10);
    const jan10 = new Date(cy, 0, 10);
    if (apptDay < jan10) apptDay = jan10;
    const apptIso = fmt(apptDay);
    // Nur wenn der Termin echt in der Vergangenheit liegt, weicht das (heutige)
    // Reversal-Datum vom Termin-Stichtag ab — sonst ist der Bug nicht sichtbar.
    const apptStrictlyInPast = apptIso < todayISO();

    const c = await createTestCustomer({
      vorname: "T963-Storno-AsOf",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    const userId = await actorId();

    // Nur §45b aktiv; großzügiges Anfangsbudget, damit die Konsumtion sicher
    // hineinpasst (Cascade in andere Töpfe vermeiden).
    await budgetStorage.upsertBudgetTypeSettings(
      customerId,
      [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, validFrom: startDate },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, yearlyLimitCents: null },
      ],
      undefined,
      userId,
    );
    const initResp = await apiPost<unknown>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 40_00, // < gesetzliches §45b-Monatsmaximum
      carryoverAmountCents: 0,
      budgetStartDate: startDate,
    });
    expect(initResp.status, "Initial-Budget muss angelegt werden").toBe(201);

    const [appt] = await db
      .insert(appointments)
      .values({
        customerId,
        date: apptIso,
        scheduledStart: "09:00",
        status: "completed",
        appointmentType: "Kundentermin",
        durationPromised: 30,
        createdByUserId: userId,
        assignedEmployeeId: userId,
      })
      .returning({ id: appointments.id });
    const appointmentId = appt.id;

    // 1) Konsumtion am (vergangenen) Termindatum buchen.
    await createConsumptionTransaction({
      customerId,
      appointmentId,
      transactionDate: apptIso,
      hauswirtschaftMinutes: 30,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
      userId,
    });

    const consumptions = await db
      .select()
      .from(budgetTransactions)
      .where(
        and(
          eq(budgetTransactions.appointmentId, appointmentId),
          eq(budgetTransactions.transactionType, "consumption"),
        ),
      );
    expect(consumptions.length, "Konsumtion muss gebucht sein").toBeGreaterThan(0);
    const bookedUsedCents = consumptions.reduce(
      (s, t) => s + Math.abs(Number(t.amountCents ?? 0)),
      0,
    );
    expect(bookedUsedCents, "Konsumtion muss einen §45b-Betrag buchen").toBeGreaterThan(0);

    if (apptStrictlyInPast) {
      const beforeStorno = await apiGet<OverviewResponse>(
        `/api/budget/${customerId}/overview?date=${apptIso}`,
      );
      expect(beforeStorno.status).toBe(200);
      expect(
        beforeStorno.data.entlastungsbetrag45b.totalUsedCents,
        "Vor dem Storno muss der Verbrauch am Termin-Stichtag sichtbar sein",
      ).toBe(bookedUsedCents);
    }

    // 2) Storno über den echten Reversal-Pfad (heute ausgeführt).
    for (const t of consumptions) {
      await budgetStorage.reverseBudgetTransaction(t.id, userId);
    }

    // (A) Unit-Invariante: jede Reversal-Zeile erbt das transactionDate ihrer
    //     stornierten Consumption — NICHT das heutige Datum.
    const reversals = await db
      .select()
      .from(budgetTransactions)
      .where(
        and(
          eq(budgetTransactions.appointmentId, appointmentId),
          eq(budgetTransactions.transactionType, "reversal"),
        ),
      );
    expect(reversals.length, "Es muss mindestens eine Reversal-Zeile geben").toBe(
      consumptions.length,
    );
    const byId = new Map(consumptions.map((t) => [t.id, t]));
    for (const rev of reversals) {
      const orig = byId.get(rev.reversedTransactionId!);
      expect(orig, "Reversal muss auf eine bekannte Consumption zeigen").toBeDefined();
      expect(
        rev.transactionDate,
        `Reversal #${rev.id} muss das transactionDate (${orig!.transactionDate}) der ` +
          `stornierten Consumption #${orig!.id} erben, nicht das heutige Datum (${todayISO()}).`,
      ).toBe(orig!.transactionDate);
    }

    // (B) Verhalten: Stichtag-Abfrage AM Termindatum nettet Verbrauch + Storno
    //     auf null → der volle Topf ist wieder verfügbar. Vor dem Fix lag das
    //     Reversal-Datum (heute) außerhalb dieses Fensters und der Verbrauch
    //     wäre fälschlich > 0 geblieben.
    if (apptStrictlyInPast) {
      const afterStorno = await apiGet<OverviewResponse>(
        `/api/budget/${customerId}/overview?date=${apptIso}`,
      );
      expect(afterStorno.status).toBe(200);
      const p = afterStorno.data.entlastungsbetrag45b;
      expect(
        p.totalUsedCents,
        `Nach dem Storno muss der Verbrauch am Termin-Stichtag (${apptIso}) auf 0 ` +
          `netten (Consumption + Reversal im selben Fenster). Ist er > 0, fiel das ` +
          `Reversal wegen falschem (heutigem) Datum aus dem Fenster (Task #963).`,
      ).toBe(0);
      expect(p.availableCents).toBe(p.totalAllocatedCents);
    }
  }, 120_000);
});
