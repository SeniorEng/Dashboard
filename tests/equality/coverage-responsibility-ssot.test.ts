/**
 * Parity: die SSoT `shared/domain/customer-responsibility.ts` === die beiden
 * Inline-Implementierungen, die sie im Coverage-Check ("Kunden ohne Termin",
 * `server/routes/appointments.ts`) ERSETZT hat.
 *
 * Der Endpunkt speist das Dashboard-Banner UND die Admin-Cockpit-Kachel. Fällt
 * durch die Umstellung auch nur ein Kunde aus der Auswahl oder bekommt eine
 * andere Rolle angehängt, sieht eine Pflegekraft einen Kunden nicht mehr, für
 * den sie zuständig ist — ohne dass irgendwo ein Fehler auftaucht. Deshalb
 * werden hier BEIDE ersetzten Stellen gegen ihre Originale gespiegelt:
 *
 *  1. die Where-Bedingung (`or(...)`) — über das kompilierte SQL inkl. Parameter,
 *  2. die Rollen-Ableitung (`getRole()`) — über die vollständige 3×3×3-Matrix
 *     aller Belegungen der Verantwortungs-Kette.
 *
 * Beide Originale stehen unten als wortgetreue Kopien des Stands vor der
 * Umstellung. Sie sind bewusst dupliziert: der Test soll rot werden, wenn
 * jemand die SSoT ändert, nicht stillschweigend mitwandern.
 */
import { describe, it, expect } from "vitest";
import { eq, or } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { customers } from "@shared/schema";
import {
  responsibilityRole,
  responsibilityCondition,
  type CustomerCoverage,
} from "@shared/domain/customer-responsibility";

const dialect = new PgDialect();
const EMP = 42;
const OTHER = 7;

/** Kopie des Originals: die handgeschriebene Where-Bedingung vor der Umstellung. */
function legacyCondition(effectiveEmployeeId: number) {
  return or(
    eq(customers.primaryEmployeeId, effectiveEmployeeId),
    eq(customers.backupEmployeeId, effectiveEmployeeId),
    eq(customers.backupEmployeeId2, effectiveEmployeeId),
  );
}

/**
 * Kopie des Originals: die lokale `getRole()` vor der Umstellung. Beachte den
 * Durchfall auf "backup2" — sie wurde nur auf bereits gefilterten Kunden
 * aufgerufen und hätte einen nicht-zuständigen Kunden falsch beschriftet.
 */
function legacyGetRole(c: CustomerCoverage, effectiveEmployeeId: number): "primary" | "backup1" | "backup2" {
  if (c.primaryEmployeeId === effectiveEmployeeId) return "primary";
  if (c.backupEmployeeId === effectiveEmployeeId) return "backup1";
  return "backup2";
}

/** JS-Pendant der Original-Where-Bedingung — für den "fällt jemand raus?"-Vergleich. */
function legacyMatches(c: CustomerCoverage, effectiveEmployeeId: number): boolean {
  return c.primaryEmployeeId === effectiveEmployeeId
    || c.backupEmployeeId === effectiveEmployeeId
    || c.backupEmployeeId2 === effectiveEmployeeId;
}

/** Alle 27 Belegungen der Kette aus {EMP, OTHER, null}. */
const SLOT_VALUES = [EMP, OTHER, null] as const;
const ALL_COVERAGES: CustomerCoverage[] = SLOT_VALUES.flatMap((primaryEmployeeId) =>
  SLOT_VALUES.flatMap((backupEmployeeId) =>
    SLOT_VALUES.map((backupEmployeeId2) => ({ primaryEmployeeId, backupEmployeeId, backupEmployeeId2 })),
  ),
);

describe("responsibilityCondition === die ersetzte or(...)-Bedingung", () => {
  it("erzeugt identisches SQL inkl. Parameter", () => {
    const next = dialect.sqlToQuery(responsibilityCondition(EMP));
    const legacy = dialect.sqlToQuery(legacyCondition(EMP)!);
    expect(next.sql).toBe(legacy.sql);
    expect(next.params).toEqual(legacy.params);
  });
});

describe("responsibilityRole === die ersetzte getRole()", () => {
  it("deckt die Matrix vollständig ab (Selbsttest der Fixture)", () => {
    expect(ALL_COVERAGES).toHaveLength(27);
  });

  it("kein Kunde fällt raus: Bedingung trifft ⟺ Rolle ist nicht null", () => {
    for (const c of ALL_COVERAGES) {
      expect({ c, matches: responsibilityRole(c, EMP) !== null })
        .toEqual({ c, matches: legacyMatches(c, EMP) });
    }
  });

  it("gleiche Rolle für jeden Kunden, den die Bedingung auswählt", () => {
    const selected = ALL_COVERAGES.filter((c) => legacyMatches(c, EMP));
    expect(selected.length).toBeGreaterThan(0);
    for (const c of selected) {
      expect({ c, role: responsibilityRole(c, EMP) }).toEqual({ c, role: legacyGetRole(c, EMP) });
    }
  });

  it("die EINZIGE bewusste Abweichung: nicht-zuständige Kunden werden ausgelassen statt als 'backup2' etikettiert", () => {
    // Auf der gefilterten Menge sind alt und neu identisch (Test darüber) —
    // hier geht es um die Kunden, die die Bedingung NICHT auswählt. Die alte
    // getRole() fiel für sie auf "backup2" durch; der Endpunkt lässt sie jetzt
    // aus (`buildUncoveredEntry` liefert null). Das ist heute unerreichbar,
    // aber es ist der Unterschied, der zählt, sobald die Query gelockert wird:
    // sonst zählte ein fremder Kunde still in `vertretungCount` mit.
    const notResponsible = ALL_COVERAGES.filter((c) => !legacyMatches(c, EMP));
    expect(notResponsible.length).toBeGreaterThan(0);
    for (const c of notResponsible) {
      expect(responsibilityRole(c, EMP)).toBeNull();
      expect(legacyGetRole(c, EMP)).toBe("backup2");
    }
  });
});
