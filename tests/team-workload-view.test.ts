import { describe, it, expect } from "vitest";
import {
  selectTeamWorkloadViewState,
  selectTeamWorkloadRows,
  safeName,
  metricsFromEntry,
  emptyEntry,
} from "../client/src/features/team/team-workload-view";
import type {
  TeamWorkloadEmployee,
  TeamWorkloadEntry,
  TeamWorkloadResponse,
} from "../client/src/features/team/use-team-workload";

/**
 * Task #370 — Regressionsschutz für die View-States der Seite
 * `/team-auslastung`. Die Seite unterscheidet vier Zustände, die manuell
 * leicht versehentlich wieder zusammenfallen können:
 *  1. Loading
 *  2. API-Fehler (mit Retry-Button)
 *  3. "gar keine Mitarbeiter da" (Datenbank leer)
 *  4. "kein Mitarbeiter passt zum Filter" (Filter zu strikt)
 *
 * Zusätzlich wird die defensive null-Behandlung für `displayName` beim
 * Sortieren (Name A–Z) abgesichert — ein fehlender Display-Name darf nicht
 * zu einem Crash beim localeCompare führen.
 */

function makeEmployee(
  overrides: Partial<TeamWorkloadEmployee> = {},
): TeamWorkloadEmployee {
  return {
    id: 1,
    displayName: "Anna Beispiel",
    vorname: "Anna",
    nachname: "Beispiel",
    telefon: null,
    roles: ["hauswirtschaft"],
    isActive: true,
    isTeamLead: false,
    ...overrides,
  };
}

function makeData(
  employees: TeamWorkloadEmployee[],
  workload: TeamWorkloadResponse["workload"] = {},
): TeamWorkloadResponse {
  return {
    employees,
    workload,
    globalAvgHoursPerCustomerPerMonth: 5,
  };
}

describe("Task #370 — selectTeamWorkloadViewState", () => {
  it("liefert kind=loading solange isLoading=true ist", () => {
    const { state, rows } = selectTeamWorkloadViewState({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      searchQuery: "",
      roleFilter: "alle",
      sortKey: "auslastung-desc",
    });
    expect(state.kind).toBe("loading");
    expect(rows).toEqual([]);
  });

  it("API-Erfolg mit aktiven Mitarbeitern → kind=rows mit den passenden Karten", () => {
    const emp1 = makeEmployee({ id: 11, displayName: "Anna" });
    const emp2 = makeEmployee({ id: 22, displayName: "Berta" });
    const { state, rows } = selectTeamWorkloadViewState({
      data: makeData([emp1, emp2]),
      isLoading: false,
      isError: false,
      error: null,
      searchQuery: "",
      roleFilter: "alle",
      sortKey: "name-asc",
    });
    expect(state.kind).toBe("rows");
    if (state.kind !== "rows") throw new Error("unreachable");
    expect(state.rows.map((r) => r.employee.id)).toEqual([11, 22]);
    expect(rows).toBe(state.rows);
  });

  it("API-Fehler (z. B. 500) → kind=error mit konkreter Fehlermeldung, NICHT empty-no-employees", () => {
    const { state } = selectTeamWorkloadViewState({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("Request failed with status 500"),
      searchQuery: "",
      roleFilter: "alle",
      sortKey: "auslastung-desc",
    });
    expect(state.kind).toBe("error");
    if (state.kind !== "error") throw new Error("unreachable");
    expect(state.message).toBe("Request failed with status 500");
    // Wichtig: ein Fehler darf nie als "Keine Mitarbeiter gefunden" maskiert werden.
    expect(state.kind).not.toBe("empty-no-employees");
  });

  it("API-Fehler ohne Message → fällt auf freundlichen Default-Hinweis zurück", () => {
    const { state } = selectTeamWorkloadViewState({
      data: undefined,
      isLoading: false,
      isError: true,
      error: "irgendein non-Error Wert",
      searchQuery: "",
      roleFilter: "alle",
      sortKey: "auslastung-desc",
    });
    expect(state.kind).toBe("error");
    if (state.kind !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/erneut versuchen/i);
  });

  it("leere employees-Liste → kind=empty-no-employees ('Keine Mitarbeiter gefunden')", () => {
    const { state } = selectTeamWorkloadViewState({
      data: makeData([]),
      isLoading: false,
      isError: false,
      error: null,
      searchQuery: "",
      roleFilter: "alle",
      sortKey: "auslastung-desc",
    });
    expect(state.kind).toBe("empty-no-employees");
  });

  it("nur deaktivierte Mitarbeiter vorhanden → kind=empty-filtered (Liste an sich nicht leer)", () => {
    const inactive = makeEmployee({ id: 1, isActive: false });
    const { state } = selectTeamWorkloadViewState({
      data: makeData([inactive]),
      isLoading: false,
      isError: false,
      error: null,
      searchQuery: "",
      roleFilter: "alle",
      sortKey: "auslastung-desc",
    });
    // employees.length > 0 (auch wenn inaktiv) → das ist semantisch ein
    // Filter-Treffer-Problem, nicht "die DB ist leer".
    expect(state.kind).toBe("empty-filtered");
  });

  it("Rollenfilter ohne Treffer → kind=empty-filtered ('Keine Mitarbeiter passen zu den aktuellen Filtern')", () => {
    const emp = makeEmployee({ roles: ["hauswirtschaft"] });
    const { state } = selectTeamWorkloadViewState({
      data: makeData([emp]),
      isLoading: false,
      isError: false,
      error: null,
      searchQuery: "",
      roleFilter: "alltagsbegleitung",
      sortKey: "auslastung-desc",
    });
    expect(state.kind).toBe("empty-filtered");
  });

  it("Suchbegriff ohne Treffer → kind=empty-filtered, nicht empty-no-employees", () => {
    const emp = makeEmployee({ displayName: "Anna" });
    const { state } = selectTeamWorkloadViewState({
      data: makeData([emp]),
      isLoading: false,
      isError: false,
      error: null,
      searchQuery: "Zacharias",
      roleFilter: "alle",
      sortKey: "auslastung-desc",
    });
    expect(state.kind).toBe("empty-filtered");
  });
});

describe("Task #370 — defensive null-Behandlung beim Sortieren (Name A–Z)", () => {
  it("crasht nicht, wenn ein Mitarbeiter weder displayName noch vorname/nachname hat — fällt auf 'Unbenannt' zurück", () => {
    const namedB = makeEmployee({
      id: 1,
      displayName: "Berta",
      vorname: "Berta",
      nachname: "B",
    });
    const namedA = makeEmployee({
      id: 2,
      displayName: "Anna",
      vorname: "Anna",
      nachname: "A",
    });
    const noName = makeEmployee({
      id: 3,
      displayName: null,
      vorname: null,
      nachname: null,
    });
    const onlyVorname = makeEmployee({
      id: 4,
      displayName: "   ",
      vorname: "Clara",
      nachname: null,
    });

    expect(safeName(noName)).toBe("Unbenannt");
    expect(safeName(onlyVorname)).toBe("Clara");

    const rows = selectTeamWorkloadRows({
      data: makeData([namedB, namedA, noName, onlyVorname]),
      searchQuery: "",
      roleFilter: "alle",
      sortKey: "name-asc",
    });

    // Reihenfolge nach localeCompare("de"): Anna, Berta, Clara, Unbenannt.
    expect(rows.map((r) => r.employee.displayName)).toEqual([
      "Anna",
      "Berta",
      "Clara",
      "Unbenannt",
    ]);
  });
});

/**
 * Task #1640 — Regressionsschutz für die Ableitung der Karten-Kennzahlen aus
 * einem Workload-Eintrag über die EINE SSoT (`metricsFromEntry` →
 * `computeTeamWorkload`). Diese Statusfälle steuern, welchen Verdikt-Satz die
 * Ampel-Liste rendert; sie sind im UI leicht zu übersehen, weil sie nur bei
 * bestimmten Datenkombinationen erscheinen. Daher pinnt dieser Test die
 * `metrics`-Felder pro Szenario.
 */
function makeWorkload(
  overrides: Partial<TeamWorkloadEntry> = {},
): TeamWorkloadEntry {
  return { ...emptyEntry(), ...overrides };
}

describe("Task #1640 — metricsFromEntry Status-Branches", () => {
  it("monthlyWorkHours = null → status 'no-soll' (Verdikt 'Vertragsstunden fehlen')", () => {
    const wl = makeWorkload({
      monthlyWorkHours: null,
      monthsConsidered: 3,
      avgMonthlyHwMinutes: 60,
      avgMonthlyAllMinutes: 0,
    });
    const m = metricsFromEntry(wl);
    expect(m.status).toBe("no-soll");
    expect(m.sollHours).toBeNull();
    expect(wl.monthlyWorkHours).toBeNull();
    expect(m.pct).toBeNull();
    expect(m.freeHours).toBeNull();
    expect(m.addClients).toBeNull();
  });

  it("monthlyWorkHours = 0 → status 'no-soll' (Verdikt 'Kein Soll')", () => {
    const wl = makeWorkload({
      monthlyWorkHours: 0,
      monthsConsidered: 3,
      avgMonthlyHwMinutes: 120,
      avgMonthlyAllMinutes: 0,
    });
    const m = metricsFromEntry(wl);
    expect(m.status).toBe("no-soll");
    expect(m.sollHours).toBeNull();
    expect(wl.monthlyWorkHours).toBe(0);
    expect(m.pct).toBeNull();
    expect(m.freeHours).toBeNull();
    expect(m.addClients).toBeNull();
  });

  it("monthsConsidered = 0 (keine Ist-Basis) → status 'no-basis', pct null, freie Stunden = Soll", () => {
    const wl = makeWorkload({
      monthlyWorkHours: 80,
      monthsConsidered: 0,
      avgMonthlyHwMinutes: 0,
      avgMonthlyAllMinutes: 0,
    });
    const m = metricsFromEntry(wl);
    expect(m.status).toBe("no-basis");
    expect(m.sollHours).toBe(80);
    expect(m.committedHours).toBe(0);
    expect(m.pct).toBeNull();
    expect(m.freeHours).toBe(80);
    expect(m.addClients).toBeNull();
  });

  it("normale Auslastung → pct = committed / soll, freie Stunden korrekt", () => {
    const wl = makeWorkload({
      monthlyWorkHours: 80,
      monthsConsidered: 3,
      avgMonthlyHwMinutes: 60 * 30,
      avgMonthlyAllMinutes: 0,
    });
    const m = metricsFromEntry(wl);
    expect(m.sollHours).toBe(80);
    expect(m.committedHours).toBe(30);
    expect(m.pct).toBeCloseTo((30 / 80) * 100, 5);
    expect(m.freeHours).toBe(50);
  });

  it("committed >= soll → status 'over' (überlastet)", () => {
    const exact = metricsFromEntry(
      makeWorkload({
        monthlyWorkHours: 80,
        monthsConsidered: 3,
        avgMonthlyHwMinutes: 60 * 100,
        avgMonthlyAllMinutes: 0,
      }),
    );
    expect(exact.status).toBe("over");
    expect(exact.isOverloaded).toBe(true);
    expect(exact.overHours).toBeGreaterThan(0);

    // Knapp darunter → nicht überlastet.
    const under = metricsFromEntry(
      makeWorkload({
        monthlyWorkHours: 100,
        monthsConsidered: 3,
        avgMonthlyHwMinutes: 60 * 90,
        avgMonthlyAllMinutes: 0,
      }),
    );
    expect(under.status).not.toBe("over");
    expect(under.isOverloaded).toBe(false);
  });
});
