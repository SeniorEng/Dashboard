/**
 * Task #1586 — Carve-out: Erstberatungen sind NIE „completed, aber unsigniert".
 *
 * Erstberatungen (`appointment_type = 'Erstberatung'`) werden dokumentiert
 * (status = 'completed'), bekommen aber nie eine Unterschrift — es gibt keinen
 * Kunden, gegen den unterschrieben würde. Die einzige SSoT dieser Definition
 * (`server/lib/appointment-signed.ts`) muss sie daher aus BEIDEN Spiegeln
 * ausschließen: der Drizzle-Bedingung `appointmentCompletedButUnsignedCondition()`
 * UND dem Roh-SQL-Fragment `completedButUnsignedSqlRaw(alias)`.
 *
 * Dieser Test prüft die SSoT direkt: eine abgeschlossene Erstberatung ohne
 * Unterschrift ist NICHT „completed but unsigned", ein ansonsten identischer
 * Nicht-Erstberatungs-Termin (abgeschlossen, ohne Unterschrift) ist es weiterhin.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { appointments } from "@shared/schema";
import {
  appointmentCompletedButUnsignedCondition,
  completedButUnsignedSqlRaw,
} from "../server/lib/appointment-signed";

const DATE = "2018-05-14";

describe("Task #1586: Erstberatung-Carve-out in completed-aber-unsigniert", () => {
  let prospectId: number;
  let erstberatungId: number;
  let normalApptId: number;

  beforeAll(async () => {
    const prospectRes = await db.execute(sql`
      INSERT INTO prospects (vorname, nachname, status)
      VALUES ('Test1586', 'CarveoutProspect', 'neu')
      RETURNING id
    `);
    prospectId = Number((prospectRes.rows[0] as { id: number }).id);

    // A) Abgeschlossene Erstberatung ohne Unterschrift ⇒ MUSS ausgeschlossen sein.
    const erstRes = await db.execute(sql`
      INSERT INTO appointments (
        prospect_id, customer_id, appointment_type, date,
        scheduled_start, scheduled_end, duration_promised, status, signature_data
      ) VALUES (
        ${prospectId}, NULL, 'Erstberatung', ${DATE},
        '10:00:00', '10:45:00', 45, 'completed', NULL
      ) RETURNING id
    `);
    erstberatungId = Number((erstRes.rows[0] as { id: number }).id);

    // B) Ansonsten identischer Nicht-Erstberatungs-Termin (abgeschlossen, unsigniert)
    //    ⇒ MUSS weiterhin als „completed, aber unsigniert" gelten (keine Regression).
    const normalRes = await db.execute(sql`
      INSERT INTO appointments (
        prospect_id, customer_id, appointment_type, date,
        scheduled_start, scheduled_end, duration_promised, status, signature_data
      ) VALUES (
        ${prospectId}, NULL, 'Hausbesuch', ${DATE},
        '11:00:00', '11:45:00', 45, 'completed', NULL
      ) RETURNING id
    `);
    normalApptId = Number((normalRes.rows[0] as { id: number }).id);
  });

  afterAll(async () => {
    await db.execute(
      sql`DELETE FROM appointments WHERE id IN (${erstberatungId}, ${normalApptId})`,
    );
    await db.execute(sql`DELETE FROM prospects WHERE id = ${prospectId}`);
  });

  async function matchesDrizzleCondition(apptId: number): Promise<boolean> {
    const rows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.id, apptId), appointmentCompletedButUnsignedCondition()));
    return rows.length === 1;
  }

  async function matchesRawSql(apptId: number): Promise<boolean> {
    const res = await db.execute(sql`
      SELECT a.id FROM appointments a
      WHERE a.id = ${apptId} AND ${completedButUnsignedSqlRaw("a")}
    `);
    return res.rows.length === 1;
  }

  it("schließt die abgeschlossene, unsignierte Erstberatung aus (Drizzle-Bedingung)", async () => {
    expect(await matchesDrizzleCondition(erstberatungId)).toBe(false);
  });

  it("schließt die abgeschlossene, unsignierte Erstberatung aus (Roh-SQL)", async () => {
    expect(await matchesRawSql(erstberatungId)).toBe(false);
  });

  it("behält den abgeschlossenen, unsignierten Nicht-Erstberatungs-Termin (Drizzle-Bedingung)", async () => {
    expect(await matchesDrizzleCondition(normalApptId)).toBe(true);
  });

  it("behält den abgeschlossenen, unsignierten Nicht-Erstberatungs-Termin (Roh-SQL)", async () => {
    expect(await matchesRawSql(normalApptId)).toBe(true);
  });

  it("hält beide Spiegel in lockstep (Drizzle ≡ Roh-SQL)", async () => {
    expect(await matchesDrizzleCondition(erstberatungId)).toBe(await matchesRawSql(erstberatungId));
    expect(await matchesDrizzleCondition(normalApptId)).toBe(await matchesRawSql(normalApptId));
  });
});
