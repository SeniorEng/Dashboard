/**
 * Task #1503 — TS↔SQL-Lockstep der `wageFor`-SSoT.
 *
 * Die reine Domänenfunktion `resolveWageFor` (ein Datensatz) und der SQL-Spiegel
 * `resolvedWageCentsSql`/`wageRoleSql` (viele Mitarbeiter × Termine in einer
 * Aggregat-Query) MÜSSEN byte-für-byte dieselbe Auflösung liefern, sonst driftet
 * „Anzeige vs. Buchung". Dieser Test seedet reale `role_wage_rates`-Phasen + ein
 * Service + Mitarbeiter mit verschiedenen Flag-Kombinationen und vergleicht die
 * DB-Auflösung (pro Mitarbeiter, pro Datum) gegen `resolveWageFor`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import {
  resolveWageFor,
  wageRoleForUserFlags,
  type VersionedWageRow,
  type WageRole,
} from "@shared/domain/pricing/wage-for";
import { resolvedWageCentsSql, wageRoleSql } from "../server/storage/pricing/wage-for-sql";

const SUFFIX = `wfsql_${Date.now()}`;

interface SeedUser {
  id: number;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isTeamLead: boolean;
  isActive: boolean;
  isAnonymized: boolean;
}

let serviceId: number;
let catalogRateCents: number;
const userIds: number[] = [];
const seedUsers: SeedUser[] = [];

async function rows(res: unknown): Promise<Array<Record<string, unknown>>> {
  return ((res as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

async function insertUser(flags: Omit<SeedUser, "id">): Promise<SeedUser> {
  const email = `${SUFFIX}_${flags.isSuperAdmin ? "s" : ""}${flags.isAdmin ? "a" : ""}${flags.isTeamLead ? "t" : ""}${flags.isActive ? "x" : ""}${flags.isAnonymized ? "z" : ""}_${userIds.length}@test.local`;
  const res = await db.execute(sql`
    INSERT INTO users (email, password_hash, vorname, nachname, display_name, is_admin, is_super_admin, is_team_lead, is_active, is_anonymized)
    VALUES (${email}, ${"x"}, ${"WF"}, ${SUFFIX}, ${`WF ${SUFFIX}`}, ${flags.isAdmin}, ${flags.isSuperAdmin}, ${flags.isTeamLead}, ${flags.isActive}, ${flags.isAnonymized})
    RETURNING id
  `);
  const id = Number((await rows(res))[0].id);
  userIds.push(id);
  const u = { id, ...flags };
  seedUsers.push(u);
  return u;
}

beforeAll(async () => {
  const svc = await rows(await db.execute(
    sql`SELECT id, employee_rate_cents FROM services WHERE code = 'hauswirtschaft' ORDER BY id LIMIT 1`,
  ));
  if (svc.length === 0) throw new Error("Service 'hauswirtschaft' nicht vorhanden");
  serviceId = Number(svc[0].id);
  catalogRateCents = Number(svc[0].employee_rate_cents);

  // Phasen je Rolle (existence-wins, dated, tiebreaker):
  //   admin: zwei Phasen 2025 / ab 2026
  //   teamLead: eine offene Phase ab 2026, plus cents=0 Phase (Existenz gewinnt)
  //   employee: KEINE Rollen-Zeile ⇒ Katalog-Default
  await db.execute(sql`
    INSERT INTO role_wage_rates (role, service_id, cents, valid_from, valid_to) VALUES
      ('admin', ${serviceId}, ${3000}, ${"2025-01-01"}, ${"2025-12-31"}),
      ('admin', ${serviceId}, ${3300}, ${"2026-01-01"}, ${null}),
      ('teamLead', ${serviceId}, ${0}, ${"2026-01-01"}, ${null})
  `);

  // Mitarbeiter mit allen relevanten Flag-Kombinationen.
  const bools = [false, true];
  for (const isSuperAdmin of bools)
    for (const isAdmin of bools)
      for (const isTeamLead of bools)
        for (const isActive of bools)
          for (const isAnonymized of bools)
            await insertUser({ isSuperAdmin, isAdmin, isTeamLead, isActive, isAnonymized });
}, 60_000);

afterAll(async () => {
  await db.execute(sql`DELETE FROM role_wage_rates WHERE service_id = ${serviceId} AND valid_from IN ('2025-01-01','2026-01-01')`);
  if (userIds.length > 0) {
    await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`);
  }
});

/** TS-Referenz: aktive Rollen-Phasen je Rolle für die Lockstep-Erwartung. */
function roleRowsFor(role: WageRole): VersionedWageRow[] {
  if (role === "admin") {
    return [
      { id: 1, cents: 3000, validFrom: "2025-01-01", validTo: "2025-12-31" },
      { id: 2, cents: 3300, validFrom: "2026-01-01", validTo: null },
    ];
  }
  if (role === "teamLead") {
    return [{ id: 3, cents: 0, validFrom: "2026-01-01", validTo: null }];
  }
  return [];
}

describe("Task #1503 — wageFor TS↔SQL Lockstep", () => {
  for (const date of ["2025-06-15", "2026-06-15"]) {
    it(`SQL-Auflösung pro Mitarbeiter === resolveWageFor am ${date}`, async () => {
      const res = await rows(await db.execute(sql`
        SELECT u.id AS user_id,
          ${wageRoleSql("u")} AS role,
          ${resolvedWageCentsSql(wageRoleSql("u"), "s", sql`${date}::date`)} AS cents
        FROM users u
        CROSS JOIN services s
        WHERE u.id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)}) AND s.id = ${serviceId}
      `));
      expect(res.length).toBe(seedUsers.length);

      const byId = new Map(res.map((r) => [Number(r.user_id), r]));
      for (const u of seedUsers) {
        const sqlRow = byId.get(u.id)!;
        // Rolle: teamLead nur wenn aktiv, nicht anonymisiert, kein admin.
        const gatedTeamLead = u.isTeamLead && u.isActive && !u.isAnonymized;
        const expectedRole = wageRoleForUserFlags(u.isSuperAdmin, u.isAdmin, gatedTeamLead);
        expect(String(sqlRow.role), `role for user ${u.id}`).toBe(expectedRole);

        const expected = resolveWageFor({
          date,
          roleRows: roleRowsFor(expectedRole),
          catalog: { employeeRateCents: catalogRateCents },
        });
        expect(Number(sqlRow.cents), `cents for user ${u.id} (${expectedRole})`).toBe(expected!.cents);
      }
    });
  }

  it("Existenz-gewinnt-bei-0: teamLead löst auf 0 auf, NICHT auf den Katalog-Default", async () => {
    const tlUser = seedUsers.find((u) => !u.isAdmin && !u.isSuperAdmin && u.isTeamLead && u.isActive && !u.isAnonymized)!;
    const res = await rows(await db.execute(sql`
      SELECT ${resolvedWageCentsSql(wageRoleSql("u"), "s", sql`'2026-06-15'::date`)} AS cents
      FROM users u CROSS JOIN services s
      WHERE u.id = ${tlUser.id} AND s.id = ${serviceId}
    `));
    expect(Number(res[0].cents)).toBe(0);
    expect(catalogRateCents).toBeGreaterThan(0);
  });
});
