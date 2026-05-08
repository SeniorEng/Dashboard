import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { getAuthCookie, createTestCustomer, cleanupCustomer } from "./test-utils";
import { getPerformanceStats } from "../server/storage/statistics/performance";
import { resolvePeriod } from "../server/storage/statistics/common";

/**
 * Task #391 — „Geleistete Stunden je Monat" muss die Kategorie aus
 * appointment_services → services.lohnart_kategorie ableiten. Die frühere
 * Legacy-Spalte appointments.service_type wurde mit Task #396 entfernt;
 * Junction ist alleinige Source of Truth.
 */
describe("Task #391 — Performance: lohnart_kategorie aus Junction", () => {
  const testYear = 2031;
  const customerIds: number[] = [];
  let userId: number;
  let hwServiceId: number;
  let abServiceId: number;
  let otherServiceId: number;

  beforeAll(async () => {
    const auth = await getAuthCookie();
    userId = auth.user.id;

    const [hw] = await db.execute(sql`
      INSERT INTO services (code, name, unit_type, default_price_cents, employee_rate_cents, lohnart_kategorie, is_active)
      VALUES (${`task391_hw_${Date.now()}`}, 'T391 HW', 'hours', 3500, 1500, 'hauswirtschaft', true)
      RETURNING id
    `).then((r) => r.rows as Array<{ id: number }>);
    hwServiceId = hw.id;

    const [ab] = await db.execute(sql`
      INSERT INTO services (code, name, unit_type, default_price_cents, employee_rate_cents, lohnart_kategorie, is_active)
      VALUES (${`task391_ab_${Date.now()}`}, 'T391 AB', 'hours', 3500, 1500, 'alltagsbegleitung', true)
      RETURNING id
    `).then((r) => r.rows as Array<{ id: number }>);
    abServiceId = ab.id;

    const [other] = await db.execute(sql`
      INSERT INTO services (code, name, unit_type, default_price_cents, employee_rate_cents, lohnart_kategorie, is_active)
      VALUES (${`task391_other_${Date.now()}`}, 'T391 Other', 'hours', 3500, 1500, 'sonstige', true)
      RETURNING id
    `).then((r) => r.rows as Array<{ id: number }>);
    otherServiceId = other.id;
  });

  afterAll(async () => {
    for (const id of customerIds) await cleanupCustomer(id);
    await db.execute(sql`DELETE FROM services WHERE id IN (${hwServiceId}, ${abServiceId}, ${otherServiceId})`);
  });

  async function insertAppt(opts: {
    customerId: number;
    date: string;
    durationMinutes: number;
    junctionServiceId: number | null;
  }): Promise<number> {
    const rows = await db.execute(sql`
      INSERT INTO appointments (
        customer_id, created_by_user_id, assigned_employee_id, performed_by_employee_id,
        appointment_type, date, scheduled_start, scheduled_end, duration_promised,
        status, actual_start, actual_end, travel_origin_type, travel_kilometers,
        travel_minutes, customer_kilometers, signed_at, signed_by_user_id
      ) VALUES (
        ${opts.customerId}, ${userId}, ${userId}, ${userId},
        'Kundentermin', ${opts.date}, '09:00', '10:00', ${opts.durationMinutes},
        'completed', '09:00', '10:00', 'home', 0,
        0, 0, NOW(), ${userId}
      )
      RETURNING id
    `).then((r) => r.rows as Array<{ id: number }>);
    const apptId = rows[0].id;
    if (opts.junctionServiceId) {
      await db.execute(sql`
        INSERT INTO appointment_services
          (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes, details)
        VALUES (${apptId}, ${opts.junctionServiceId}, ${opts.durationMinutes}, ${opts.durationMinutes}, 'T391 fixture')
      `);
    }
    return apptId;
  }

  it("manuelle und importierte Termine landen in derselben Kategorie", async () => {
    const customer = await createTestCustomer({ vorname: "T391", nachname: `Cat_${Date.now()}` });
    const cid = customer.id as number;
    customerIds.push(cid);

    // (a) Manueller Termin: Junction-Zeile HW
    await insertAppt({
      customerId: cid,
      date: `${testYear}-01-15`,
      durationMinutes: 60,
      junctionServiceId: hwServiceId,
    });

    // (b) Importierter Termin: Junction-Zeile HW
    await insertAppt({
      customerId: cid,
      date: `${testYear}-02-15`,
      durationMinutes: 90,
      junctionServiceId: hwServiceId,
    });

    // (c) Alltagsbegleitung importiert (Junction)
    await insertAppt({
      customerId: cid,
      date: `${testYear}-03-15`,
      durationMinutes: 120,
      junctionServiceId: abServiceId,
    });

    // (d) Termin OHNE Junction-Zeile
    //     → muss strikt in „Sonstige" landen (Junction ist Source of Truth).
    await insertAppt({
      customerId: cid,
      date: `${testYear}-04-15`,
      durationMinutes: 45,
      junctionServiceId: null,
    });

    // (e) Multi-Service-Termin: HW + „sonstige" verknüpft, „sonstige" hat
    //     die längere Dauer. Trotzdem MUSS der Termin als HW gezählt werden
    //     (HW/AB hat Vorrang vor sonstige) und genau einmal (kein
    //     Doppel-Counting durch zwei Junction-Zeilen).
    const multiAppt = await insertAppt({
      customerId: cid,
      date: `${testYear}-05-15`,
      durationMinutes: 75,
      junctionServiceId: hwServiceId,
    });
    await db.execute(sql`
      INSERT INTO appointment_services
        (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes, details)
      VALUES (${multiAppt}, ${otherServiceId}, 200, 200, 'T391 mixed-other')
    `);

    const stats = await getPerformanceStats(resolvePeriod({ year: testYear }));
    const jan = stats.minutesByMonth.find((m) => m.month === 1)!;
    const feb = stats.minutesByMonth.find((m) => m.month === 2)!;
    const mar = stats.minutesByMonth.find((m) => m.month === 3)!;
    const apr = stats.minutesByMonth.find((m) => m.month === 4)!;
    const may = stats.minutesByMonth.find((m) => m.month === 5)!;

    expect(jan.hauswirtschaft).toBeGreaterThanOrEqual(60);
    expect(jan.sonstige).toBe(0);

    // Kernregression: Importierter HW-Termin landet NICHT in „Sonstige"
    expect(feb.hauswirtschaft).toBeGreaterThanOrEqual(90);
    expect(feb.sonstige).toBe(0);

    expect(mar.alltagsbegleitung).toBeGreaterThanOrEqual(120);
    expect(mar.sonstige).toBe(0);

    // Junction ist Source of Truth: Termine ohne Verknüpfung sind „Sonstige"
    expect(apr.hauswirtschaft).toBe(0);
    expect(apr.sonstige).toBeGreaterThanOrEqual(45);

    // Multi-Service: HW/AB schlägt „sonstige" und Termin wird nur 1× gezählt
    expect(may.hauswirtschaft).toBeGreaterThanOrEqual(75);
    expect(may.sonstige).toBe(0);
    expect(may.hauswirtschaft + may.alltagsbegleitung + may.erstberatung + may.sonstige).toBe(75);
  });
});
