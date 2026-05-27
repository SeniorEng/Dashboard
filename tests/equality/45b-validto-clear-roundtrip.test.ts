/**
 * Task #696 (Bug 1) — "Gültig bis" eines §45b-Topfs lässt sich am selben Tag
 * wieder leeren, ohne durch den Read-Pfad als „heute" zu reappearen.
 *
 * Repro-Szenario:
 *   - Eine ältere Settings-Zeile (validFrom in der Vergangenheit, validTo=NULL)
 *     existiert (= "gestern in Kraft"-Vorgänger).
 *   - Heute speichert der Admin eine echte Transition (z.B. neuer
 *     monthlyLimit). `upsertBudgetTypeSettings` schließt die alte Zeile mit
 *     `validTo=heute` und legt eine neue Zeile mit `validFrom=morgen` an.
 *   - Direkter GET via `getBudgetTypeSettings` (= active-for-today) liefert
 *     die ALTE Zeile mit `validTo=heute` → die UI zeigt "Gültig bis = heute".
 *   - Admin leert „Gültig bis" und speichert. Der Save vergleicht das Payload
 *     gegen die offene Zeile (das ist die NEUE Zeile mit validTo=null
 *     bereits) — der Equality-Check sieht keinen Unterschied → No-Op.
 *   - Nächster GET liefert wieder "Gültig bis = heute" (alte Zeile). Bug.
 *
 * Fix: Der UI-Read-Pfad nutzt `getLatestBudgetTypeSettings`, das pro Topf
 * die offene Zeile (validTo=null) gegenüber der schließenden Zeile
 * (validTo=heute) bevorzugt. Der Admin sieht somit von Anfang an die
 * jüngste Intent-Zeile (validTo=null), ein Clear+Save ist gar nicht nötig —
 * und wenn ihn doch jemand explizit clear-saved, ist nichts zu ändern.
 *
 * Storage-Round-Trip-Test ohne HTTP, damit kein Auth-/Routing-Rauschen
 * dazwischenkommt. Booking-Pfade nutzen weiterhin
 * `getActiveBudgetTypeSettings(transactionDate)` (separat geprüft).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerBudgetTypeSettings } from "@shared/schema";
import { todayISO, addDays } from "@shared/utils/datetime";
import {
  getActiveBudgetTypeSettings,
  getLatestBudgetTypeSettings,
  upsertBudgetTypeSettings,
} from "../../server/storage/budget/preferences-storage";
import { createTestCustomer, getAuthCookie, runCleanup } from "../test-utils";

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

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T696B1_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const customerId = c.id as number;
  // Auto-Settings aus dem Wizard wegräumen — wir bauen die Historie hier explizit.
  await db.delete(customerBudgetTypeSettings).where(
    eq(customerBudgetTypeSettings.customerId, customerId),
  );
  return customerId;
}

describe("Task #696 (Bug 1) — §45b Gültig-bis Clear-Roundtrip", () => {
  it("Nach echter Transition liefert getLatestBudgetTypeSettings die NEUE offene Zeile (validTo=null) statt der schließenden Zeile (validTo=heute)", async () => {
    const customerId = await freshCustomer("T696B1-LATEST");
    const userId = await getActorUserId();
    const today = todayISO();
    const tomorrow = addDays(today, 1);

    // Erstanlage: §45b ohne Anteil. validFrom künstlich in die Vergangenheit
    // setzen, damit der nächste Upsert eine ECHTE Transition triggert
    // (sonst greift der Same-Day-In-Place-Pfad).
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null }],
      undefined,
      userId,
    );
    await db.update(customerBudgetTypeSettings)
      .set({ validFrom: "2020-01-01" })
      .where(eq(customerBudgetTypeSettings.customerId, customerId));

    // Echte Transition: monthlyLimit ändern.
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 6550, yearlyLimitCents: null }],
      undefined,
      userId,
    );

    // Sanity: zwei Zeilen — alte mit validTo=heute, neue mit validFrom=morgen.
    const allRows = await db.select().from(customerBudgetTypeSettings)
      .where(and(
        eq(customerBudgetTypeSettings.customerId, customerId),
        eq(customerBudgetTypeSettings.budgetType, "entlastungsbetrag_45b"),
      ));
    expect(allRows).toHaveLength(2);
    const closing = allRows.find(r => r.validTo === today);
    const open = allRows.find(r => r.validTo == null);
    expect(closing).toBeTruthy();
    expect(open).toBeTruthy();
    expect(open!.validFrom).toBe(tomorrow);

    // Read-für-UI (Fix): muss die NEUE offene Zeile liefern, NICHT die
    // schließende mit validTo=heute. Sonst sieht der Admin "Gültig bis=heute"
    // auftauchen, obwohl er nichts entsprechendes gesetzt hat.
    const forUI = await getLatestBudgetTypeSettings(customerId);
    const s45bUI = forUI.find(s => s.budgetType === "entlastungsbetrag_45b");
    expect(s45bUI).toBeTruthy();
    expect(s45bUI!.validTo).toBeNull();
    expect(s45bUI!.monthlyLimitCents).toBe(6550);

    // Booking-Pfad bleibt unverändert: für `today` ist weiterhin die alte
    // Zeile in Kraft (validFrom <= today, validTo >= today), morgen kippt
    // die Konfig auf die neue. Wichtig für GoBD.
    const forBookingToday = await getActiveBudgetTypeSettings(customerId, today);
    const s45bBookToday = forBookingToday.find(s => s.budgetType === "entlastungsbetrag_45b");
    expect(s45bBookToday).toBeTruthy();
    expect(s45bBookToday!.validTo).toBe(today);
    expect(s45bBookToday!.monthlyLimitCents).toBeNull();

    const forBookingTomorrow = await getActiveBudgetTypeSettings(customerId, tomorrow);
    const s45bBookTomorrow = forBookingTomorrow.find(s => s.budgetType === "entlastungsbetrag_45b");
    expect(s45bBookTomorrow).toBeTruthy();
    expect(s45bBookTomorrow!.validTo).toBeNull();
    expect(s45bBookTomorrow!.monthlyLimitCents).toBe(6550);
  });

  it("getLatestBudgetTypeSettings liefert NICHT die Zeile mit transientem validTo=heute, auch wenn nur eine Zeile pro Topf offen ist", async () => {
    // Direkte DB-Vorbereitung: schließende + offene Zeile parallel — wie nach
    // einer Transition. Stellt sicher, dass der Tie-Break „offen schlägt
    // geschlossen" unabhängig von der Insert-Reihenfolge greift.
    const customerId = await freshCustomer("T696B1-TIEBREAK");
    const today = todayISO();
    const tomorrow = addDays(today, 1);

    await db.insert(customerBudgetTypeSettings).values([
      {
        customerId,
        budgetType: "entlastungsbetrag_45b",
        enabled: true,
        priority: 1,
        monthlyLimitCents: null,
        yearlyLimitCents: null,
        validFrom: "2025-01-01",
        validTo: today, // schließende Zeile
      },
      {
        customerId,
        budgetType: "entlastungsbetrag_45b",
        enabled: true,
        priority: 1,
        monthlyLimitCents: 9900,
        yearlyLimitCents: null,
        validFrom: tomorrow,
        validTo: null, // neue offene Zeile
      },
    ]);

    const forUI = await getLatestBudgetTypeSettings(customerId);
    const s45b = forUI.find(s => s.budgetType === "entlastungsbetrag_45b");
    expect(s45b).toBeTruthy();
    expect(s45b!.validTo).toBeNull();
    expect(s45b!.monthlyLimitCents).toBe(9900);
  });
});
