/**
 * Task #736 — End-to-End-Drift-Test für phasen-historisierte
 * Budget-Type-Settings auf der Buchungs-Seite.
 *
 * Task #721 hat die Schreib-Seite (`upsertBudgetTypeSettings`) phasen-fest
 * gemacht (Append-Only, keine versehentliche In-Place-Überschreibung der
 * Vorgänger-Phase). Was bisher fehlte: ein Round-Trip-Test, der nach mehreren
 * Phasen-Schreibungen je Phase eine echte `createCascadeConsumption`-Buchung
 * mit `transactionDate` in dieser Phase ausführt und prüft, dass Cap /
 * Monthly-Limit / Pot-Routing die zum Buchungsdatum gültige Konfiguration
 * nutzen — und NICHT die jüngste (offene) Endzeile.
 *
 * Das ist genau die Drift-Klasse aus dem Pre-#721-Bug: eine Buchung vom
 * 2026-07-15 sah die 2027er Limits, weil alle Vorgänger-Phasen
 * versehentlich überschrieben worden waren.
 *
 * Erwartungen werden aus dem shared-Domain-Helper `computeCapSlot`
 * berechnet (nicht aus harten Zahlen), damit dieser Test ein echter
 * Drift-Detektor bleibt, falls sich die Cap-Mathe ändert.
 */
// @ts-nocheck

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, budgetTransactions } from "@shared/schema";
import { parseLocalDate, todayISO } from "@shared/utils/datetime";
import { upsertBudgetTypeSettings } from "../../server/storage/budget/preferences-storage";
import { upsertInitialBalanceAllocation } from "../../server/storage/budget/allocation-storage";
import { computeCapSlot } from "../../server/storage/budget/cap-calculator";
import { bookConsumption } from "../helpers/budget-booking";
import {
  createTestCustomer,
  createTestEmployee,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

const ORIGINAL_TZ = process.env.TZ;

beforeAll(async () => {
  process.env.TZ = "Europe/Berlin";
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

async function getActorUserId(): Promise<number> {
  const rows = await db.execute(/* sql */ `SELECT id FROM users ORDER BY id ASC LIMIT 1`);
  const r = (rows as { rows: Array<{ id: number }> }).rows;
  if (!r[0]) throw new Error("Kein User für Audit-Akteur verfügbar");
  return r[0].id;
}

async function freshCustomer(prefix: string, acceptsPrivate = true): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T736_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: acceptsPrivate,
  });
  return c.id as number;
}

/**
 * Liefert YYYY-MM-01 für den ersten Tag des Monats `offset` Monate nach
 * heute. Garantiert deterministisch im selben Monat eines jeden Test-Laufs
 * unterschiedlich, aber immer in der Zukunft (offset ≥ 2 → mindestens
 * nächster-übernächster Monat).
 */
function firstOfMonthOffset(offset: number): string {
  const today = parseLocalDate(todayISO());
  const y = today.getFullYear();
  const m = today.getMonth() + offset; // 0-indexed + offset
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  return `${targetY}-${String(targetM + 1).padStart(2, "0")}-01`;
}

describe("Task #736 — Phasen-historisierte Buchung nutzt zum Termin-Datum gültige Konfiguration", () => {
  it("§45a: drei Phasen mit unterschiedlichem monthlyLimitCents → Buchung in jeder Phase respektiert den Phasen-Cap (nicht die jüngste offene Zeile)", async () => {
    const customerId = await freshCustomer("T736-45A");
    const userId = await getActorUserId();
    const emp = await createTestEmployee({ nachnamePrefix: "T736A" });

    // Drei Phasen-Stichtage in der Zukunft, jeweils in unterschiedlichen
    // Monaten (damit der §45a-Monats-Cap pro Buchung in einem eigenen
    // Fenster liegt und nicht durch Vor-Bookings im selben Monat verzerrt
    // wird).
    const vfA = firstOfMonthOffset(2);
    const vfB = firstOfMonthOffset(4);
    const vfC = firstOfMonthOffset(6);

    // Pflegegrad 3 → statutorischer §45a-Monats-Cap liegt deutlich höher als
    // unsere Test-Limits (15/30/50 €), damit die "clampToStatutoryMax"-
    // Klemme nicht auf unsere Limits kollidiert und der Test wirklich die
    // Phase prüft, nicht das Statut.
    const limitA = 15_00;
    const limitB = 30_00;
    const limitC = 50_00;

    // Baseline: §45a aktiv (rückwirkend, kein validFrom), §45b und §39+§42a
    // explizit deaktiviert. Wir wollen, dass die Cascade ALLE Kosten in
    // §45a routet (bzw. den Rest privat). Damit ist der Phasen-Cap auf
    // §45a der einzige Limit-Faktor.
    await upsertBudgetTypeSettings(
      customerId,
      [
        { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a",        enabled: true,  priority: 2, monthlyLimitCents: limitA },
        { budgetType: "ersatzpflege_39_42a",   enabled: false, priority: 3, monthlyLimitCents: null },
      ],
      undefined,
      userId,
    );

    // Drei Folge-Phasen für §45a mit unterschiedlichen Monats-Limits.
    // Wir senden NUR §45a im Payload — §45b/§39 wurden in der Baseline
    // bereits geschlossen, würden also nicht erneut "schließen".
    for (const [vf, limit] of [[vfA, limitA], [vfB, limitB], [vfC, limitC]] as const) {
      await upsertBudgetTypeSettings(
        customerId,
        [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: limit, validFrom: vf }],
        undefined,
        userId,
      );
    }

    // Großzügige §45a-Allokation als `manual_adjustment`, damit FIFO in
    // jeder Phase Mittel ziehen kann. `initial_balance` würde am
    // `calculateAllocated45a`-Cap auf den aktuellen Monat scheitern
    // (Future-Bookings sehen sonst 0 € allokiert), `manual_adjustment`
    // umgeht den curMonth-Cap und wird per `validFrom <= asOfDate`-Regel
    // direkt ausgezahlt.
    await db.insert(budgetAllocations).values({
      customerId,
      budgetType: "umwandlung_45a",
      source: "manual_adjustment",
      year: parseLocalDate(vfA).getFullYear(),
      month: 1,
      amountCents: 500_00,
      validFrom: todayISO(),
      expiresAt: null,
      notes: "T736 §45a allocation",
      createdByUserId: userId,
    });

    // Pro Phase einen Termin buchen. Wir wählen Kosten DEUTLICH über dem
    // Phasen-Cap (180 Min Hauswirtschaft ≈ ~80 € bei Standard-Sätzen),
    // damit der gebuchte §45a-Betrag exakt dem Cap der Phase entspricht
    // (Rest spillt privat). Buchung am ersten Tag der Phase → Cap-Fenster
    // (Monat) ist leer, also netUsed=0 und capRemaining = monthlyLimit.
    const cases = [
      { date: vfA, expectedLimit: limitA },
      { date: vfB, expectedLimit: limitB },
      { date: vfC, expectedLimit: limitC },
    ];

    for (const c of cases) {
      // Drift-Detektor: Erwartung kommt aus dem shared Cap-Helper, nicht
      // aus einer hartkodierten Zahl. capRemainingCents MUSS vor der
      // Buchung berechnet werden — danach hat netUsedInWindow den
      // Buchungsbetrag bereits absorbiert (capRemaining = 0). Wenn die
      // Engine versehentlich die jüngste (offene) Endzeile lesen würde —
      // der Pre-#721-Bug —, dann würde die Buchung in Phase A nicht
      // limitA verbrauchen, sondern limitC.
      const capBefore = await computeCapSlot({
        customerId,
        budgetType: "umwandlung_45a",
        transactionDate: c.date,
        monthlyLimitCents: c.expectedLimit,
        yearlyLimitCents: null,
      });
      expect(capBefore.capRemainingCents).toBe(c.expectedLimit);

      const booking = await bookConsumption({
        customerId, employeeId: emp.id, userId,
        date: c.date, hwMinutes: 180, abMinutes: 0, travelKm: 0, customerKm: 0,
      });

      const txs = await db
        .select()
        .from(budgetTransactions)
        .where(eq(budgetTransactions.appointmentId, booking.appointmentId));

      const fortyFiveA = txs
        .filter(t => t.transactionType === "consumption" && t.budgetType === "umwandlung_45a")
        .reduce((s, t) => s + Math.abs(t.amountCents), 0);
      const privateAmount = txs
        .filter(t => t.transactionType === "consumption" && t.budgetType === "private")
        .reduce((s, t) => s + Math.abs(t.amountCents), 0);

      // Sanity: Gesamtkosten der Buchung MÜSSEN das Phasen-Limit
      // überschreiten — sonst würde §45a den Termin komplett schlucken
      // und der Test wäre nicht aussagekräftig (kein Spill auf privat,
      // also kein Beweis für die Cap-Klemme). Macht den Test
      // zukunftssicher gegen Preis-Änderungen.
      expect(fortyFiveA + privateAmount).toBeGreaterThan(c.expectedLimit);

      // §45a-Buchung muss exakt das Phasen-Limit treffen (Cap-Klemme),
      // Rest spillt privat → nichts geht verloren.
      expect(fortyFiveA).toBe(c.expectedLimit);
      expect(privateAmount).toBeGreaterThan(0);

      // Nach der Buchung muss netUsedInWindow == capBefore sein, sodass
      // capRemaining auf 0 fällt. Doppelter Drift-Check: Anzeige (Cap-Helper)
      // und Buchung (budget_transactions) zeigen identisch das Phasen-Limit.
      const capAfter = await computeCapSlot({
        customerId,
        budgetType: "umwandlung_45a",
        transactionDate: c.date,
        monthlyLimitCents: c.expectedLimit,
        yearlyLimitCents: null,
      });
      expect(capAfter.netUsedInWindowCents).toBe(c.expectedLimit);
      expect(capAfter.capRemainingCents).toBe(0);
    }
  });

  it("§45b: Phasen enabled → disabled → enabled — Buchung pro Phase trifft nur dann §45b, wenn die Phase es zulässt", async () => {
    const customerId = await freshCustomer("T736-45B");
    const userId = await getActorUserId();
    const emp = await createTestEmployee({ nachnamePrefix: "T736B" });

    const vfA = firstOfMonthOffset(2); // Phase A enabled
    const vfB = firstOfMonthOffset(4); // Phase B disabled
    const vfC = firstOfMonthOffset(6); // Phase C enabled

    // Baseline: §45b aktiv (Prio 1), §45a/§39 deaktiviert. Damit fällt in
    // einer §45b-disabled-Phase der gesamte Kostenblock auf "privat"
    // durch — das ist unser Signal "§45b wurde NICHT belastet".
    await upsertBudgetTypeSettings(
      customerId,
      [
        { budgetType: "entlastungsbetrag_45b", enabled: true,  priority: 1, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a",        enabled: false, priority: 2, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a",   enabled: false, priority: 3, monthlyLimitCents: null },
      ],
      undefined,
      userId,
    );

    // Drei §45b-Phasen mit wechselndem enabled-Flag.
    const phases: Array<{ vf: string; enabled: boolean }> = [
      { vf: vfA, enabled: true  },
      { vf: vfB, enabled: false },
      { vf: vfC, enabled: true  },
    ];
    for (const p of phases) {
      await upsertBudgetTypeSettings(
        customerId,
        [{ budgetType: "entlastungsbetrag_45b", enabled: p.enabled, priority: 1, monthlyLimitCents: null, validFrom: p.vf }],
        undefined,
        userId,
      );
    }

    // Großzügige §45b-Allokation, damit FIFO in den enabled-Phasen ziehen
    // kann. §45b hat keinen Monats-Cap, also begrenzt nur die Allokation.
    await upsertInitialBalanceAllocation(
      {
        customerId, budgetType: "entlastungsbetrag_45b",
        year: parseLocalDate(vfA).getFullYear(), month: 1,
        amountCents: 500_00,
        validFrom: todayISO(),
        expiresAt: null,
        notes: "T736 §45b allocation",
      },
      userId,
    );

    // Pro Phase eine kleine Buchung (60 Min HW) — bewusst weit unter der
    // Allokation, damit in enabled-Phasen §45b den vollen Betrag schluckt
    // und in der disabled-Phase ALLES privat geht.
    for (const p of phases) {
      const booking = await bookConsumption({
        customerId, employeeId: emp.id, userId,
        date: p.vf, hwMinutes: 60, abMinutes: 0, travelKm: 0, customerKm: 0,
      });

      const txs = await db
        .select()
        .from(budgetTransactions)
        .where(eq(budgetTransactions.appointmentId, booking.appointmentId));

      const fortyFiveB = txs
        .filter(t => t.transactionType === "consumption" && t.budgetType === "entlastungsbetrag_45b")
        .reduce((s, t) => s + Math.abs(t.amountCents), 0);
      const privateAmount = txs
        .filter(t => t.transactionType === "consumption" && t.budgetType === "private")
        .reduce((s, t) => s + Math.abs(t.amountCents), 0);
      const totalConsumed = fortyFiveB + privateAmount;

      // §45b hat keinen Cap → capRemainingCents = +Infinity in beiden
      // Zuständen. Das Routing-Verhalten wird hier durch das `enabled`-
      // Flag der zur Phase gültigen Zeile bestimmt — genau das, was der
      // Pre-#721-Bug versehentlich kaputt-überschrieben hätte.
      //
      // Drift-Detektor: Wir holen den Cap trotzdem aus dem shared Helper
      // ab, damit eine künftige Änderung an der §45b-Cap-Semantik (z.B.
      // Wiedereinführung eines Monats-Caps) hier sofort auffällt.
      const cap = await computeCapSlot({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        transactionDate: p.vf,
        monthlyLimitCents: null,
        yearlyLimitCents: null,
      });
      expect(cap.capRemainingCents).toBe(Number.POSITIVE_INFINITY);

      if (p.enabled) {
        // Phase erlaubt §45b → der gesamte Termin landet auf §45b, nichts privat.
        expect(fortyFiveB).toBeGreaterThan(0);
        expect(privateAmount).toBe(0);
        expect(fortyFiveB).toBe(totalConsumed);
      } else {
        // Phase deaktiviert §45b → 0 € auf §45b, alles auf privat.
        expect(fortyFiveB).toBe(0);
        expect(privateAmount).toBeGreaterThan(0);
        expect(privateAmount).toBe(totalConsumed);
      }
    }
  });
});
