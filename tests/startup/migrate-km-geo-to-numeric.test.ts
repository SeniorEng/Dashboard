/**
 * Task #857 — Regressionsschutz für die KM-/Geo-Präzisions-Migration aus Task #678.
 *
 * Task #678 hat alle Kilometer-Spalten (`numeric(10,3)`) und Geo-Spalten
 * (`numeric(9,6)`) von `real` (IEEE-754 single-precision, driftet z.B.
 * 2.714 → 2.7139999...) auf exaktes `numeric` migriert. Anders als die
 * Monatsstunden-Migration (Task #843) gab es dafür bisher KEINEN automatisierten
 * Test. Diese Tests pinnen zwei Garantien fest, damit eine spätere Schema-/
 * Query-Änderung den Float-Drift nicht still wieder einführt:
 *
 *  1. `migrateKmGeoToNumeric()` ist idempotent: ein erster Lauf konvertiert
 *     `real` → den Ziel-Typ (`numeric(10,3)` für km, `numeric(9,6)` für geo) und
 *     rundet den real-Drift via `ROUND(...)` sauber weg; ein zweiter Lauf ist ein
 *     echtes No-Op (KEIN weiteres `ALTER TABLE`).
 *  2. Der Round-Trip-Wert bleibt nach der Konvertierung erhalten — kein Drift
 *     beim `real → numeric`-Cast.
 *
 * Repräsentative Spalten (Spiegelung des Stils aus
 * `tests/startup/migrate-monthly-work-hours-to-numeric.test.ts`):
 *   - KM:  `employee_time_entries.kilometers`  → numeric(10,3)
 *   - Geo: `appointments.doctor_latitude`      → numeric(9,6)
 *
 * Auswahl-Begründung (minimaler Kollateral-Schaden beim absichtlichen
 * Zurückdrehen auf `real`):
 *   - `appointments.doctor_latitude` ist produktiv komplett NULL → der
 *     `real`-Umweg verändert keine Bestandsdaten; nur EINE Zeile bekommt für den
 *     Round-Trip-Test temporär einen Wert und wird danach wieder auf NULL gesetzt.
 *   - `employee_time_entries.kilometers` enthält ausschließlich kleine Werte
 *     (≤ ~10 km, 3 NK), die den `numeric → real → ROUND(numeric,3)`-Umweg
 *     verlustfrei überleben (vgl. Begründung in der Monatsstunden-Migration).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { migrateKmGeoToNumeric } from "../../server/startup/migrate-km-geo-to-numeric";

const KM_TABLE = "employee_time_entries";
const KM_COLUMN = "kilometers";
const GEO_TABLE = "appointments";
const GEO_COLUMN = "doctor_latitude";

// Round-Trip-Werte, die den künstlichen `real`-Umweg verlustfrei überleben.
// `real` (float4) trägt nur ~6 signifikante Dezimalstellen — analog zur
// Begründung der Monatsstunden-Migration ("Werte ≤300 mit 2 NK überleben den
// numeric→real→ROUND-Round-Trip"). Daher:
//   - km:  3 NK, kleine Magnitude (12.345 → 5 sig. Stellen).
//   - geo: 6 NK bei Magnitude < 1 (0.123456 → 6 sig. Stellen, übt alle 6
//          Nachkommastellen aus und überlebt float4 verlustfrei).
const KM_ROUNDTRIP_VALUE = 12.345;
const GEO_ROUNDTRIP_VALUE = 0.123456;

type ColumnMeta = {
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
};

async function getColumnMeta(table: string, column: string): Promise<ColumnMeta> {
  const res = await db.execute(sql`
    SELECT data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${table}
      AND column_name = ${column}
    LIMIT 1
  `);
  const row = res.rows[0] as Record<string, unknown>;
  return {
    data_type: String(row.data_type ?? ""),
    numeric_precision:
      row.numeric_precision === null || row.numeric_precision === undefined
        ? null
        : Number(row.numeric_precision),
    numeric_scale:
      row.numeric_scale === null || row.numeric_scale === undefined
        ? null
        : Number(row.numeric_scale),
  };
}

async function setColumnToReal(table: string, column: string): Promise<void> {
  await db.execute(
    sql.raw(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE real USING "${column}"::real`),
  );
}

async function restoreColumnToNumeric(
  table: string,
  column: string,
  precision: number,
  scale: number,
): Promise<void> {
  const meta = await getColumnMeta(table, column);
  if (meta.data_type === "real" || meta.data_type === "double precision") {
    await db.execute(
      sql.raw(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE numeric(${precision},${scale}) USING ROUND("${column}"::numeric, ${scale})`,
      ),
    );
  }
}

/**
 * Zählt, wie viele der von `db.execute` empfangenen Statements ein `ALTER TABLE`
 * sind. Funktioniert für `sql.raw(...)` (ein StringChunk mit dem Roh-String) wie
 * auch für Template-`sql\`...\`` (mehrere StringChunks). Die Typ-Check-Queries der
 * Migration (`information_schema`) enthalten kein `ALTER TABLE`.
 */
function countAlterStatements(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(([arg]) => {
    const chunks = (arg as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
    const text = chunks
      .map((c) => {
        const v = (c as { value?: unknown })?.value;
        if (Array.isArray(v)) return v.join(" ");
        return typeof v === "string" ? v : "";
      })
      .join(" ");
    return text.includes("ALTER TABLE");
  }).length;
}

describe("Task #857 — migrate-km-geo-to-numeric Idempotenz + Round-Trip", () => {
  // Wir verändern je EINE Bestands-Zeile (km + geo) für den Round-Trip und
  // führen sie in afterAll exakt in ihren Ausgangszustand zurück — kein
  // dauerhafter Fixture-Drift, auch wenn der Test mittendrin abbricht.
  let geoApptId: number;
  let geoOrigValue: number | null;
  let kmRowId: number;
  let kmOrigValue: number | null;

  beforeAll(async () => {
    // Eine (produktiv NULL-)Termin-Zeile für den Geo-Round-Trip auswählen,
    // Original-Wert merken und mit einem bekannten Wert belegen.
    const apptRes = await db.execute(
      sql`SELECT id, doctor_latitude AS v FROM appointments WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
    );
    const apptRow = apptRes.rows[0] as Record<string, unknown> | undefined;
    if (!apptRow) throw new Error("Kein Termin in der Test-DB für den Geo-Round-Trip gefunden");
    geoApptId = Number(apptRow.id);
    geoOrigValue = apptRow.v === null || apptRow.v === undefined ? null : Number(apptRow.v);
    await db.execute(
      sql`UPDATE appointments SET doctor_latitude = ${GEO_ROUNDTRIP_VALUE} WHERE id = ${geoApptId}`,
    );

    // Eine Zeit-Eintrag-Zeile für den KM-Round-Trip auswählen, Original-Wert
    // merken und mit einem bekannten Wert belegen (Magnitude/Präzision wie
    // Bestandsdaten → überlebt den real-Umweg verlustfrei).
    const kmRes = await db.execute(
      sql`SELECT id, kilometers AS v FROM employee_time_entries ORDER BY id LIMIT 1`,
    );
    const kmRow = kmRes.rows[0] as Record<string, unknown> | undefined;
    if (!kmRow) throw new Error("Keine Zeit-Erfassung in der Test-DB für den KM-Round-Trip gefunden");
    kmRowId = Number(kmRow.id);
    kmOrigValue = kmRow.v === null || kmRow.v === undefined ? null : Number(kmRow.v);
    await db.execute(
      sql`UPDATE employee_time_entries SET kilometers = ${KM_ROUNDTRIP_VALUE} WHERE id = ${kmRowId}`,
    );

    // Beide Spalten gezielt auf `real` zurückdrehen, damit der
    // Konvertierungs-Pfad der Migration im Test tatsächlich greift.
    await setColumnToReal(KM_TABLE, KM_COLUMN);
    await setColumnToReal(GEO_TABLE, GEO_COLUMN);
  });

  afterAll(async () => {
    // Spalten garantiert in den Produktionszustand (numeric) zurückführen, egal
    // wie der Test endete — sonst liefe der Rest der Suite gegen `real`.
    await restoreColumnToNumeric(KM_TABLE, KM_COLUMN, 10, 3).catch(() => {});
    await restoreColumnToNumeric(GEO_TABLE, GEO_COLUMN, 9, 6).catch(() => {});
    // Beide Bestands-Zeilen exakt auf ihren Original-Wert zurücksetzen.
    if (geoApptId) {
      await db
        .execute(sql`UPDATE appointments SET doctor_latitude = ${geoOrigValue} WHERE id = ${geoApptId}`)
        .catch(() => {});
    }
    if (kmRowId) {
      await db
        .execute(sql`UPDATE employee_time_entries SET kilometers = ${kmOrigValue} WHERE id = ${kmRowId}`)
        .catch(() => {});
    }
  });

  it("konvertiert real → numeric (km 10,3 / geo 9,6), erhält den Wert und ist beim zweiten Lauf ein No-Op", async () => {
    // --- Vorbedingung: beforeAll hat beide Spalten auf `real` gedreht. ---
    expect((await getColumnMeta(KM_TABLE, KM_COLUMN)).data_type).toBe("real");
    expect((await getColumnMeta(GEO_TABLE, GEO_COLUMN)).data_type).toBe("real");

    // --- Erster Lauf: konvertiert beide Spalten. ---
    await migrateKmGeoToNumeric();

    const kmMeta = await getColumnMeta(KM_TABLE, KM_COLUMN);
    expect(kmMeta.data_type).toBe("numeric");
    expect(kmMeta.numeric_precision).toBe(10);
    expect(kmMeta.numeric_scale).toBe(3);

    const geoMeta = await getColumnMeta(GEO_TABLE, GEO_COLUMN);
    expect(geoMeta.data_type).toBe("numeric");
    expect(geoMeta.numeric_precision).toBe(9);
    expect(geoMeta.numeric_scale).toBe(6);

    // --- Round-Trip: Werte bleiben nach der Konvertierung driftfrei erhalten. ---
    const kmValRes = await db.execute(
      sql`SELECT kilometers AS v FROM employee_time_entries WHERE id = ${kmRowId}`,
    );
    expect(Number((kmValRes.rows[0] as Record<string, unknown>).v)).toBe(KM_ROUNDTRIP_VALUE);

    const geoValRes = await db.execute(
      sql`SELECT doctor_latitude AS v FROM appointments WHERE id = ${geoApptId}`,
    );
    expect(Number((geoValRes.rows[0] as Record<string, unknown>).v)).toBe(GEO_ROUNDTRIP_VALUE);

    // --- Zweiter Lauf: echtes No-Op (KEIN ALTER TABLE). ---
    const spy = vi.spyOn(db, "execute");
    try {
      await migrateKmGeoToNumeric();
      expect(countAlterStatements(spy)).toBe(0);
    } finally {
      spy.mockRestore();
    }

    // Typen bleiben unverändert.
    const kmAfter = await getColumnMeta(KM_TABLE, KM_COLUMN);
    expect(kmAfter.data_type).toBe("numeric");
    expect(kmAfter.numeric_scale).toBe(3);
    const geoAfter = await getColumnMeta(GEO_TABLE, GEO_COLUMN);
    expect(geoAfter.data_type).toBe("numeric");
    expect(geoAfter.numeric_scale).toBe(6);
  });
});
