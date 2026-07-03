/**
 * Task #1616 — Zwei Änderungen an der Übersicht /admin/mitarbeiterabrechnung,
 * hier gegen Regressionen verankert:
 *
 * Teil A — Die „Erfasst"-Spalte wurde durch ZWEI Lexware-Töpfe ersetzt:
 *   - HW = Hauswirtschaft + Erstberatung + Anfahrtszeit + Leerfahrten +
 *          Sonstiges (reine Arbeitszeit, OHNE Urlaub/Krankheit/Feiertage)
 *   - AB = Alltagsbegleitung
 * Urlaub/Krankheit dürfen NICHT mehr in `erfasst.hw` einfließen.
 *
 * Teil B — Je Mitarbeiter werden zusammenhängende Abwesenheits-Blöcke
 * (Von–Bis) im Payload mitgeliefert (`row.abwesenheiten`). Die Blöcke werden
 * aus den einzelnen Tages-Einträgen rekonstruiert; Σ `tage` je Typ MUSS der
 * Tages-Zählung (`tageUrlaub`/`tageKrankheit` des Drill-downs) entsprechen.
 *
 * Beide Pfade nutzen dieselben Datums-/Feiertags-Helfer wie die Erfassung, so
 * dass Anzeige und Buchung nie driften.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import {
  apiGet,
  apiPost,
  createTestEmployee,
  deactivateTestEmployee,
} from "./test-utils";

const YEAR = 2021;
const MONTH = 3; // März 2021

interface AbsenceBlock {
  typ: "urlaub" | "krankheit";
  von: string;
  bis: string;
  tage: number;
}
interface OverviewRow {
  employeeId: number;
  erfasst: { hw: number; ab: number; feiertage: number; kilometer: number };
  abwesenheiten: AbsenceBlock[];
}
interface OverviewResponse {
  year: number;
  month: number;
  rows: OverviewRow[];
}
interface DrilldownRow {
  tageUrlaub: number;
  tageKrankheit: number;
}
interface DrilldownResponse {
  row: DrilldownRow;
}

describe("Task #1616: Abwesenheits-Blöcke + HW ohne Urlaub/Krankheit", () => {
  let employeeId: number;

  async function getOverviewRow(): Promise<OverviewRow> {
    const res = await apiGet<OverviewResponse>(
      `/api/admin/mitarbeiterabrechnung?year=${YEAR}&month=${MONTH}`,
    );
    expect(res.status).toBe(200);
    const row = res.data.rows.find((r) => r.employeeId === employeeId);
    expect(row, `Mitarbeiter ${employeeId} muss eine Übersichts-Zeile haben`).toBeDefined();
    return row!;
  }

  beforeAll(async () => {
    const employee = await createTestEmployee({ nachnamePrefix: "TestAbsence" });
    employeeId = employee.id;

    // Urlaub-Block: Mo 01.03. – Mi 03.03.2021 (3 Werktage, keine Feiertage).
    const urlaub = await apiPost(`/api/time-entries`, {
      targetUserId: employeeId,
      entryType: "urlaub",
      entryDate: `${YEAR}-03-01`,
      endDate: `${YEAR}-03-03`,
      isFullDay: true,
    });
    expect(urlaub.status).toBe(201);

    // Krankheit-Block: Mo 15.03. – Di 16.03.2021 (2 Werktage), separater Block
    // (echte Arbeitstags-Lücke zwischen Urlaub und Krankheit).
    const krankheit = await apiPost(`/api/time-entries`, {
      targetUserId: employeeId,
      entryType: "krankheit",
      entryDate: `${YEAR}-03-15`,
      endDate: `${YEAR}-03-16`,
      isFullDay: true,
    });
    expect(krankheit.status).toBe(201);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM employee_time_entries WHERE user_id = ${employeeId}`);
    await db.execute(sql`DELETE FROM employee_hours_accounts WHERE user_id = ${employeeId}`);
    await db.execute(sql`DELETE FROM employee_month_closings WHERE user_id = ${employeeId}`);
    await deactivateTestEmployee(employeeId);
  });

  it("Teil B: liefert je Typ einen zusammenhängenden Von–Bis-Block mit korrekter Tageszahl", async () => {
    const row = await getOverviewRow();

    const urlaubBloecke = row.abwesenheiten.filter((b) => b.typ === "urlaub");
    const krankBloecke = row.abwesenheiten.filter((b) => b.typ === "krankheit");

    expect(urlaubBloecke).toHaveLength(1);
    expect(urlaubBloecke[0]).toMatchObject({
      von: `${YEAR}-03-01`,
      bis: `${YEAR}-03-03`,
      tage: 3,
    });

    expect(krankBloecke).toHaveLength(1);
    expect(krankBloecke[0]).toMatchObject({
      von: `${YEAR}-03-15`,
      bis: `${YEAR}-03-16`,
      tage: 2,
    });
  });

  it("Teil B: Σ Block-Tage je Typ === tageUrlaub/tageKrankheit des Drill-downs", async () => {
    const row = await getOverviewRow();
    const drill = await apiGet<DrilldownResponse>(
      `/api/admin/mitarbeiterabrechnung/employee/${employeeId}?year=${YEAR}&month=${MONTH}`,
    );
    expect(drill.status).toBe(200);

    const urlaubTage = row.abwesenheiten
      .filter((b) => b.typ === "urlaub")
      .reduce((s, b) => s + b.tage, 0);
    const krankTage = row.abwesenheiten
      .filter((b) => b.typ === "krankheit")
      .reduce((s, b) => s + b.tage, 0);

    expect(urlaubTage).toBe(drill.data.row.tageUrlaub);
    expect(krankTage).toBe(drill.data.row.tageKrankheit);
  });

  it("Teil A: HW-Topf enthält KEINE Urlaubs-/Krankheits-Stunden (reine Abwesenheit ⇒ HW = 0)", async () => {
    const row = await getOverviewRow();
    // Der Mitarbeiter hat ausschließlich Urlaub/Krankheit, keine Termine/
    // Nebenzeiten ⇒ beide Arbeits-Töpfe müssen 0 sein.
    expect(row.erfasst.hw).toBe(0);
    expect(row.erfasst.ab).toBe(0);
  });
});
