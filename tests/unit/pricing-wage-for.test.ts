/**
 * Task #1503 — Unit-Tests für die reine `wageFor`-Lohnsatz-Auflösung (SSoT).
 *
 * Pinnt die zugesicherten Invarianten fest:
 *   (0) Existenz-gewinnt-bei-0: eine VORHANDENE Rollen-Satz-Zeile gewinnt IMMER
 *       über den Katalog-Default — auch bei cents = 0. Es zählt die Existenz der
 *       Zeile, nicht der Wert (kein 0/NULL-Kurzschluss auf den Katalog).
 *   (1) Auflösungsreihenfolge: Rollen-Satz → Katalog-Default → null.
 *   (2) Zeitversionierung + Tiebreaker (spätestes validFrom, dann höchste id).
 *   (3) Rollen-Ableitung `wageRoleForUserFlags` deckungsgleich mit
 *       `actorRole`/`isTeamLead` (`server/lib/team-lead.ts`) über ALLE Flag-
 *       Kombinationen (admin > teamLead > employee).
 */
import { describe, it, expect } from "vitest";
import {
  resolveWageFor,
  wageRoleForUserFlags,
  type VersionedWageRow,
} from "@shared/domain/pricing/wage-for";
import { actorRole, isTeamLead } from "../../server/lib/team-lead";

function row(p: Partial<VersionedWageRow> & { id: number; cents: number }): VersionedWageRow {
  return { validFrom: null, validTo: null, ...p };
}

describe("resolveWageFor — Existenz gewinnt bei 0", () => {
  it("Rollen-Satz = 0 ⇒ liefert 0 (source role), NICHT den Katalog-Default", () => {
    const res = resolveWageFor({
      date: "2026-06-15",
      roleRows: [row({ id: 1, cents: 0, validFrom: "2026-01-01" })],
      catalog: { employeeRateCents: 2500 },
    });
    expect(res).toEqual({ cents: 0, source: "role" });
  });

  it("Rollen-Satz > 0 schlägt den Katalog-Default", () => {
    const res = resolveWageFor({
      date: "2026-06-15",
      roleRows: [row({ id: 1, cents: 1800 })],
      catalog: { employeeRateCents: 2500 },
    });
    expect(res).toEqual({ cents: 1800, source: "role" });
  });
});

describe("resolveWageFor — Auflösungsreihenfolge", () => {
  it("kein Rollen-Satz ⇒ Katalog-Default", () => {
    const res = resolveWageFor({
      date: "2026-06-15",
      roleRows: [],
      catalog: { employeeRateCents: 2500 },
    });
    expect(res).toEqual({ cents: 2500, source: "default" });
  });

  it("Katalog-Default = 0 ⇒ liefert 0 (source default)", () => {
    const res = resolveWageFor({
      date: "2026-06-15",
      roleRows: [],
      catalog: { employeeRateCents: 0 },
    });
    expect(res).toEqual({ cents: 0, source: "default" });
  });

  it("weder Rollen-Satz noch Katalog ⇒ null (unbekanntes Service)", () => {
    expect(resolveWageFor({ date: "2026-06-15", roleRows: [] })).toBeNull();
  });
});

describe("resolveWageFor — Zeitversionierung & Tiebreaker", () => {
  it("wählt die am Datum aktive Phase", () => {
    const rows = [
      row({ id: 1, cents: 1500, validFrom: "2025-01-01", validTo: "2025-12-31" }),
      row({ id: 2, cents: 1700, validFrom: "2026-01-01", validTo: null }),
    ];
    expect(resolveWageFor({ date: "2025-06-01", roleRows: rows })).toEqual({ cents: 1500, source: "role" });
    expect(resolveWageFor({ date: "2026-06-01", roleRows: rows })).toEqual({ cents: 1700, source: "role" });
  });

  it("Datum vor jeder Rollen-Zeile ⇒ fällt auf den Katalog-Default", () => {
    const res = resolveWageFor({
      date: "2024-06-01",
      roleRows: [row({ id: 1, cents: 1700, validFrom: "2026-01-01" })],
      catalog: { employeeRateCents: 2500 },
    });
    expect(res).toEqual({ cents: 2500, source: "default" });
  });

  it("identisches validFrom ⇒ höchste id gewinnt (deterministischer Tiebreaker)", () => {
    const rows = [
      row({ id: 5, cents: 1700, validFrom: "2026-01-01" }),
      row({ id: 7, cents: 1900, validFrom: "2026-01-01" }),
    ];
    expect(resolveWageFor({ date: "2026-06-01", roleRows: rows })).toEqual({ cents: 1900, source: "role" });
  });

  it("validTo ist inklusiv (Grenztag zählt noch zur Phase)", () => {
    const rows = [row({ id: 1, cents: 1600, validFrom: "2026-01-01", validTo: "2026-06-30" })];
    expect(resolveWageFor({ date: "2026-06-30", roleRows: rows })).toEqual({ cents: 1600, source: "role" });
    expect(resolveWageFor({ date: "2026-07-01", roleRows: rows, catalog: { employeeRateCents: 2500 } }))
      .toEqual({ cents: 2500, source: "default" });
  });

  it("offener validFrom (null) zählt als frühester Start", () => {
    const res = resolveWageFor({
      date: "2026-06-01",
      roleRows: [row({ id: 1, cents: 1650, validFrom: null, validTo: null })],
    });
    expect(res).toEqual({ cents: 1650, source: "role" });
  });
});

describe("wageRoleForUserFlags — Rollen-Ableitung", () => {
  it("admin/superadmin → 'admin' (auch wenn teamLead gesetzt)", () => {
    expect(wageRoleForUserFlags(false, true, false)).toBe("admin");
    expect(wageRoleForUserFlags(true, false, false)).toBe("admin");
    expect(wageRoleForUserFlags(false, true, true)).toBe("admin");
    expect(wageRoleForUserFlags(true, true, true)).toBe("admin");
  });

  it("teamLead (kein admin) → 'teamLead'", () => {
    expect(wageRoleForUserFlags(false, false, true)).toBe("teamLead");
  });

  it("sonst → 'employee'", () => {
    expect(wageRoleForUserFlags(false, false, false)).toBe("employee");
  });
});

describe("wageRoleForUserFlags — Parität mit actorRole/isTeamLead (alle Flag-Kombinationen)", () => {
  const bools = [false, true];
  for (const isSuperAdmin of bools) {
    for (const isAdmin of bools) {
      for (const isTeamLeadFlag of bools) {
        for (const isActive of bools) {
          for (const isAnonymized of bools) {
            const label = `sa=${isSuperAdmin} a=${isAdmin} tl=${isTeamLeadFlag} act=${isActive} anon=${isAnonymized}`;
            it(`deckungsgleich mit actorRole — ${label}`, () => {
              const user = {
                isSuperAdmin,
                isAdmin,
                isTeamLead: isTeamLeadFlag,
                isActive,
                isAnonymized,
              };
              // Aufrufer (TS wie SQL) gaten das teamLead-Flag VOR der Ableitung
              // exakt wie team-lead.ts → genau das spiegelt isTeamLead(user).
              const derived = wageRoleForUserFlags(isSuperAdmin, isAdmin, isTeamLead(user));
              expect(derived).toBe(actorRole(user));
            });
          }
        }
      }
    }
  }
});
