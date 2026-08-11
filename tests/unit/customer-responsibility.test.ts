/**
 * Unit-Tests für die zentrale Zuständigkeits-Regel
 * (`shared/domain/customer-responsibility.ts`) — Vorrang der Kette
 * Primär → 1. Vertretung → 2. Vertretung und das Rollen-Subset der
 * Where-Bedingung.
 *
 * Die Gleichheit mit den beiden ERSETZTEN Inline-Implementierungen des
 * Coverage-Checks steht separat in
 * `tests/equality/coverage-responsibility-ssot.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  responsibilityRole,
  responsibilityCondition,
  RESPONSIBILITY_ROLES,
  type CustomerCoverage,
} from "@shared/domain/customer-responsibility";

const dialect = new PgDialect();
const EMP = 42;

function coverage(partial: Partial<CustomerCoverage>): CustomerCoverage {
  return {
    primaryEmployeeId: null,
    backupEmployeeId: null,
    backupEmployeeId2: null,
    ...partial,
  };
}

describe("responsibilityRole", () => {
  it("erkennt jede der drei Rollen einzeln", () => {
    expect(responsibilityRole(coverage({ primaryEmployeeId: EMP }), EMP)).toBe("primary");
    expect(responsibilityRole(coverage({ backupEmployeeId: EMP }), EMP)).toBe("backup1");
    expect(responsibilityRole(coverage({ backupEmployeeId2: EMP }), EMP)).toBe("backup2");
  });

  it("null, wenn der Mitarbeiter gar nicht zuständig ist", () => {
    expect(responsibilityRole(coverage({ primaryEmployeeId: 1, backupEmployeeId: 2, backupEmployeeId2: 3 }), EMP)).toBeNull();
  });

  it("null bei komplett unbesetzter Kette", () => {
    expect(responsibilityRole(coverage({}), EMP)).toBeNull();
  });

  it("Vorrang primary > backup1 > backup2 bei Mehrfach-Eintrag", () => {
    expect(responsibilityRole(coverage({ primaryEmployeeId: EMP, backupEmployeeId: EMP, backupEmployeeId2: EMP }), EMP)).toBe("primary");
    expect(responsibilityRole(coverage({ backupEmployeeId: EMP, backupEmployeeId2: EMP }), EMP)).toBe("backup1");
  });

  it("employeeId 0 wird nicht mit einer leeren (NULL-)Kette verwechselt", () => {
    // Defensiv: NULL-Spalten dürfen nie gegen eine ID matchen, auch nicht gegen
    // die falsy 0 — sonst bekäme ein Nutzer mit ID 0 alle unbesetzten Kunden.
    expect(responsibilityRole(coverage({}), 0)).toBeNull();
    expect(responsibilityRole(coverage({ primaryEmployeeId: 0 }), 0)).toBe("primary");
  });
});

describe("responsibilityCondition", () => {
  it("deckt ohne roles-Option alle drei Spalten ab", () => {
    const { sql } = dialect.sqlToQuery(responsibilityCondition(EMP));
    expect(sql).toContain('"primary_employee_id"');
    expect(sql).toContain('"backup_employee_id"');
    expect(sql).toContain('"backup_employee_id_2"');
  });

  it("bindet die Mitarbeiter-ID als Parameter, nicht als String-Interpolation", () => {
    const { params } = dialect.sqlToQuery(responsibilityCondition(EMP));
    expect(params).toEqual([EMP, EMP, EMP]);
  });

  it("ein Rollen-Subset verengt die Bedingung", () => {
    const { sql, params } = dialect.sqlToQuery(responsibilityCondition(EMP, { roles: ["primary"] }));
    expect(sql).toContain('"primary_employee_id"');
    expect(sql).not.toContain('"backup_employee_id"');
    expect(params).toEqual([EMP]);
  });

  it("leeres roles-Array wirft, statt die Where-Klausel verschwinden zu lassen", () => {
    // Regressionsschutz: drizzles or() liefert ohne Argumente `undefined`, was
    // in einem umschließenden and(...) wegfällt — die Query lieferte dann ALLE
    // Kunden statt keiner (stille Sichtbarkeits-Ausweitung).
    expect(() => responsibilityCondition(EMP, { roles: [] })).toThrow(/leeres roles-Array/);
  });

  it("RESPONSIBILITY_ROLES ist die Vorrang-Reihenfolge", () => {
    expect([...RESPONSIBILITY_ROLES]).toEqual(["primary", "backup1", "backup2"]);
  });
});
