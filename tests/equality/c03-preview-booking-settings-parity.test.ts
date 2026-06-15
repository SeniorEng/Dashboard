/**
 * Task #1288 (Phase 3.2) — C-03-Parität: Rebook-/Verfügbarkeits-PREVIEW und
 * tatsächliche BUCHUNG müssen für denselben Termin DENSELBEN stichtagsbezogenen
 * Settings-Stand sehen.
 *
 * Hintergrund (C-03): `customer_budget_type_settings` ist append-only
 * historisiert (Task #440/#721). Für einen Termin am Tag D ist die zum Tag D
 * gültige Phase maßgeblich — NICHT die jüngste (offene) Intent-Zeile
 * (`forEdit`). Driften Anzeige (Verfügbarkeit/Preview) und Buchung auseinander,
 * weil eine Seite versehentlich `forEdit` (Latest-Intent) statt `forDate`
 * (Stichtag) liest, zeigt die Vorschau einen anderen Topf-Zustand als die
 * Buchung tatsächlich bucht (GoBD-/Finanz-Drift).
 *
 * Diese Suite belegt für denselben Termin:
 *   1. Die SSoT `readBudgetTypeSettings` liefert pro Modus UNTERSCHIEDLICHE
 *      Stände (forDate(D) ≠ forEdit), sobald eine Zukunftsphase existiert —
 *      d.h. eine Drift WÄRE möglich, wenn ein Wertpfad den falschen Modus läse.
 *   2. Der PREVIEW-Lesepfad (`readUnifiedBudgetAvailability`, derselbe Reader,
 *      der die Overview/Cost-Estimate speist) sieht am Termin-Datum exakt die
 *      stichtagsbezogene Phase.
 *   3. Der BUCHUNGS-Lesepfad (`createConsumptionTransaction` →
 *      `createCascadeConsumption`) bucht am Termin-Datum gegen exakt dieselbe
 *      stichtagsbezogene Phase.
 * → Preview und Buchung sind je Termin-Datum deckungsgleich und können nicht
 *   auf den Latest-Intent (`forEdit`) abdriften.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, budgetTransactions } from "@shared/schema";
import { addDays, parseLocalDate, todayISO } from "@shared/utils/datetime";
import { readBudgetTypeSettings, upsertBudgetTypeSettings } from "../../server/storage/budget/preferences-storage";
import { readUnifiedBudgetAvailability } from "../../server/storage/budget/unified-reader";
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

/** Erster Tag des Monats `offset` Monate nach heute (immer in der Zukunft). */
function firstOfMonthOffset(offset: number): string {
  const today = parseLocalDate(todayISO());
  const m = today.getMonth() + offset;
  const targetY = today.getFullYear() + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  return `${targetY}-${String(targetM + 1).padStart(2, "0")}-01`;
}

describe("Task #1288 — C-03: Preview-Lesepfad und Buchungs-Lesepfad nutzen denselben stichtagsbezogenen Settings-Stand", () => {
  it("§45a heute aktiv, ab Zukunftsphase deaktiviert → Preview UND Buchung folgen je Termin-Datum derselben Phase (kein Abdriften auf Latest-Intent)", async () => {
    const customerId = (await createTestCustomer({
      vorname: "T1288-C03",
      nachname: `C03_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
    })).id as number;
    const userId = await getActorUserId();
    const emp = await createTestEmployee({ nachnamePrefix: "T1288C03" });

    const today = todayISO();
    const futurePhaseStart = firstOfMonthOffset(2);
    const futureApptDate = addDays(futurePhaseStart, 5);

    // Baseline (rückwirkend, kein validFrom): §45a aktiv, §45b/§39 deaktiviert.
    await upsertBudgetTypeSettings(
      customerId,
      [
        { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a",        enabled: true,  priority: 2, monthlyLimitCents: 200_00 },
        { budgetType: "ersatzpflege_39_42a",   enabled: false, priority: 3, monthlyLimitCents: null },
      ],
      undefined,
      userId,
    );

    // Zukunftsphase: §45a wird ab `futurePhaseStart` DEAKTIVIERT (Phasen-Append).
    // Dadurch ist die jüngste Intent-Zeile (`forEdit`) §45a=disabled, während
    // die heute gültige Phase §45a=enabled bleibt.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, validFrom: futurePhaseStart }],
      undefined,
      userId,
    );

    // Großzügige §45a-Allokation (manual_adjustment umgeht den curMonth-Cap der
    // initial_balance und ist per `validFrom <= asOfDate` sofort verfügbar).
    await db.insert(budgetAllocations).values({
      customerId,
      budgetType: "umwandlung_45a",
      source: "manual_adjustment",
      year: parseLocalDate(today).getFullYear(),
      month: 1,
      amountCents: 500_00,
      validFrom: today,
      expiresAt: null,
      notes: "T1288 §45a allocation",
      createdByUserId: userId,
    });

    // ---- (1) SSoT-Modi DIVERGIEREN → Drift wäre möglich ----------------------
    const forDateToday = await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: today });
    const forDateFuture = await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: futureApptDate });
    const forEdit = await readBudgetTypeSettings(customerId, { kind: "forEdit" });

    const a45 = (rows: typeof forDateToday) => rows.find(r => r.budgetType === "umwandlung_45a");
    expect(a45(forDateToday)?.enabled).toBe(true);   // heute gültige Phase
    expect(a45(forDateFuture)?.enabled).toBe(false);  // stichtagsbezogene Zukunftsphase
    expect(a45(forEdit)?.enabled).toBe(false);        // Latest-Intent ≠ heute → Drift wäre möglich

    // ---- (2) PREVIEW-Lesepfad folgt je Stichtag der gültigen Phase -----------
    const previewToday = await readUnifiedBudgetAvailability(customerId, today);
    const previewFuture = await readUnifiedBudgetAvailability(customerId, futureApptDate);
    expect(previewToday.pots.umwandlung_45a.enabled).toBe(true);
    expect(previewToday.pots.umwandlung_45a.availableCents).toBeGreaterThan(0);
    expect(previewFuture.pots.umwandlung_45a.enabled).toBe(false);
    expect(previewFuture.pots.umwandlung_45a.availableCents).toBe(0);

    // ---- (3) BUCHUNGS-Lesepfad bucht je Stichtag gegen dieselbe Phase --------
    const bookToday = await bookConsumption({
      customerId, employeeId: emp.id, userId,
      date: today, hwMinutes: 60, abMinutes: 0, travelKm: 0, customerKm: 0,
    });
    const bookFuture = await bookConsumption({
      customerId, employeeId: emp.id, userId,
      date: futureApptDate, hwMinutes: 60, abMinutes: 0, travelKm: 0, customerKm: 0,
    });

    const split = async (appointmentId: number) => {
      const txs = await db
        .select()
        .from(budgetTransactions)
        .where(eq(budgetTransactions.appointmentId, appointmentId));
      const sumOf = (bt: string) => txs
        .filter(t => t.transactionType === "consumption" && t.budgetType === bt)
        .reduce((s, t) => s + Math.abs(t.amountCents), 0);
      return { a45: sumOf("umwandlung_45a"), priv: sumOf("private") };
    };

    const splitToday = await split(bookToday.appointmentId);
    const splitFuture = await split(bookFuture.appointmentId);

    // Heute: §45a (zur Phase aktiv) absorbiert den Termin → §45a belastet, nichts privat.
    expect(splitToday.a45).toBeGreaterThan(0);
    expect(splitToday.priv).toBe(0);

    // Zukunft (Phase deaktiviert §45a): nichts auf §45a, alles privat.
    expect(splitFuture.a45).toBe(0);
    expect(splitFuture.priv).toBeGreaterThan(0);

    // ---- Parität: Preview-Enabled je Stichtag === Buchungs-Routing je Stichtag
    // (§45a belastet ⟺ Preview zeigt §45a aktiv). Wäre ein Pfad auf `forEdit`
    // abgedriftet, würde die HEUTIGE Seite §45a fälschlich deaktiviert sehen.
    expect(previewToday.pots.umwandlung_45a.enabled).toBe(splitToday.a45 > 0);
    expect(previewFuture.pots.umwandlung_45a.enabled).toBe(splitFuture.a45 > 0);
  }, 60_000);
});
