/**
 * Task #843 — Regressionsschutz für die Präzisions-Migration aus Task #833.
 *
 * Task #833 hat `users.monthly_work_hours` von `real` (IEEE-754 single-precision,
 * driftet z.B. 86.45 → 86.4499969...) auf exaktes `numeric(6,2)` migriert. Diese
 * Tests pinnen zwei Garantien fest, damit eine spätere Schema-/Query-Änderung den
 * Drift nicht still wieder einführt:
 *
 *  1. Die Startup-Migration ist idempotent: ein erster Lauf konvertiert
 *     `real`/`double precision` → `numeric(6,2)` (und rundet den real-Drift via
 *     ROUND(...,2) sauber weg), ein zweiter Lauf ist ein No-Op (kein ALTER).
 *     Spiegelt den Check-Stil der KM-/Geo-Migration (Task #678).
 *  2. Der Raw-SQL-Lesepfad in `loadTeamWorkload` parst den von node-postgres/Neon
 *     für `numeric` als String gelieferten Wert ("86.45") exakt nach 86.45 — kein
 *     Float-Drift beim Round-Trip DB → JS.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { users } from "@shared/schema";
import { migrateMonthlyWorkHoursToNumeric } from "../../server/startup/migrate-monthly-work-hours-to-numeric";
import { loadTeamWorkload } from "../../server/lib/team-workload";
import {
  createTestEmployee,
  deactivateTestEmployee,
  getAuthCookie,
  resetAuthCache,
} from "../test-utils";

async function getColumnMeta(): Promise<{
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
}> {
  const res = await db.execute(sql`
    SELECT data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name = 'monthly_work_hours'
    LIMIT 1
  `);
  const row = res.rows[0] as Record<string, unknown>;
  return {
    data_type: String(row.data_type ?? ""),
    numeric_precision: row.numeric_precision === null || row.numeric_precision === undefined
      ? null
      : Number(row.numeric_precision),
    numeric_scale: row.numeric_scale === null || row.numeric_scale === undefined
      ? null
      : Number(row.numeric_scale),
  };
}

describe("Task #843 — migrate-monthly-work-hours-to-numeric Idempotenz", () => {
  let empId: number;

  beforeAll(async () => {
    await getAuthCookie();
    const emp = await createTestEmployee({ nachnamePrefix: "T843_MWH" });
    empId = emp.id;
    // Exakter Zwei-Nachkommawert, der unter `real` driften würde.
    await db.update(users).set({ monthlyWorkHours: 86.45 }).where(eq(users.id, empId));

    // Spalte gezielt auf `real` zurückdrehen, damit der Konvertierungs-Pfad der
    // Migration im Test tatsächlich greift. Werte ≤ 300 mit 2 NK überleben den
    // numeric→real→ROUND(numeric,2)-Round-Trip verlustfrei.
    await db.execute(sql.raw(
      `ALTER TABLE "users" ALTER COLUMN "monthly_work_hours" TYPE real USING "monthly_work_hours"::real`,
    ));
  });

  afterAll(async () => {
    // Spalte garantiert in den Produktionszustand (numeric) zurückführen, egal
    // wie der Test endete — sonst liefe der Rest der Suite gegen `real`.
    try {
      const meta = await getColumnMeta();
      if (meta.data_type === "real" || meta.data_type === "double precision") {
        await db.execute(sql.raw(
          `ALTER TABLE "users" ALTER COLUMN "monthly_work_hours" TYPE numeric(6,2) USING ROUND("monthly_work_hours"::numeric, 2)`,
        ));
      }
    } catch {}
    await deactivateTestEmployee(empId).catch(() => {});
    resetAuthCache();
  });

  it("erster Lauf konvertiert real → numeric(6,2) und rundet Drift weg; zweiter Lauf ist No-Op", async () => {
    // Vorbedingung: beforeAll hat die Spalte auf `real` gedreht.
    const before = await getColumnMeta();
    expect(before.data_type).toBe("real");

    // --- Erster Lauf: konvertiert. ---
    await migrateMonthlyWorkHoursToNumeric();

    const after = await getColumnMeta();
    expect(after.data_type).toBe("numeric");
    expect(after.numeric_precision).toBe(6);
    expect(after.numeric_scale).toBe(2);

    // Der real-Drift (86.4499969...) wird via ROUND(...,2) sauber auf 86.45
    // zurückgeholt — kein Präzisionsverlust für 2-NK-Werte.
    const valRes = await db.execute(
      sql`SELECT monthly_work_hours AS v FROM users WHERE id = ${empId}`,
    );
    expect(Number((valRes.rows[0] as Record<string, unknown>).v)).toBe(86.45);

    // --- Zweiter Lauf: No-Op. ---
    // Auf bereits-numeric darf die Migration NUR den Typ-Check ausführen
    // (genau ein db.execute) und KEIN weiteres ALTER absetzen.
    const spy = vi.spyOn(db, "execute");
    try {
      await migrateMonthlyWorkHoursToNumeric();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }

    // Typ bleibt unverändert numeric(6,2).
    const afterSecond = await getColumnMeta();
    expect(afterSecond.data_type).toBe("numeric");
    expect(afterSecond.numeric_precision).toBe(6);
    expect(afterSecond.numeric_scale).toBe(2);
  });
});

describe("Task #843 — loadTeamWorkload parst numeric-String ohne Drift", () => {
  let empId: number;

  beforeAll(async () => {
    await getAuthCookie();
    const emp = await createTestEmployee({ nachnamePrefix: "T843_Workload" });
    empId = emp.id;
    await db.update(users).set({ monthlyWorkHours: 86.45 }).where(eq(users.id, empId));
  });

  afterAll(async () => {
    await deactivateTestEmployee(empId).catch(() => {});
    resetAuthCache();
  });

  it("liefert monthlyWorkHours exakt als 86.45 (node-postgres/Neon gibt numeric als String zurück)", async () => {
    const rows = await loadTeamWorkload();
    const row = rows.find((r) => r.employeeId === empId);

    expect(row, "Test-Mitarbeiter sollte in der Workload-Liste auftauchen").toBeDefined();
    // Kernregression: numeric kommt als "86.45" aus dem Treiber; `Number(...)`
    // im Raw-SQL-Mapping muss exakt 86.45 ergeben. Unter dem alten `real`-Typ
    // wäre hier 86.4499969... gelandet und dieser toBe-Vergleich gebrochen.
    expect(row!.monthlyWorkHours).toBe(86.45);
  });
});
