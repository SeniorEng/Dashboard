import { describe, it, expect } from "vitest";
import {
  selectTeamWorkloadViewState,
  selectTeamWorkloadRows,
  safeName,
  deriveSollIst,
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
 * Task #372 — Regressionsschutz für die Hinweis-Branches auf den Karten unter
 * `/team-auslastung`. Diese defensive Verzweigungen sind im UI leicht zu
 * übersehen, weil sie nur erscheinen, wenn bestimmte Datenkombinationen
 * vorliegen. Wenn ein zukünftiges Refactor zwei Branches versehentlich
 * zusammenfasst, sehen Admins entweder gar keinen Hinweis mehr oder einen
 * falschen — beides ist im Tagesbetrieb schwer zu bemerken. Daher pinnt
 * dieser Test die `sollIst`-Felder pro Szenario.
 */
function makeWorkload(
  overrides: Partial<TeamWorkloadEntry> = {},
): TeamWorkloadEntry {
  return { ...emptyEntry(), ...overrides };
}

describe("Task #372 — deriveSollIst Hinweis-Branches", () => {
  it("monthlyWorkHours = null → Karte zeigt Branch 'Vertragsstunden fehlen'", () => {
    const wl = makeWorkload({
      monthlyWorkHours: null,
      monthsConsidered: 3,
      avgMonthlyHwMinutes: 60,
      avgMonthlyAllMinutes: 0,
    });
    const sollIst = deriveSollIst(wl, 5);
    // sollHours === null + monthlyWorkHours === null ⇒ UI rendert
    // den "Vertragsstunden fehlen"-Branch (mit Link "jetzt ergänzen").
    expect(sollIst.sollHours).toBeNull();
    expect(wl.monthlyWorkHours).toBeNull();
    expect(sollIst.auslastungPct).toBeNull();
    expect(sollIst.freieStunden).toBeNull();
    expect(sollIst.moeglicheZusatzKunden).toBeNull();
  });

  it("monthlyWorkHours = 0 → Karte zeigt Branch 'Soll/Ist: n/a (kein Soll hinterlegt)'", () => {
    const wl = makeWorkload({
      monthlyWorkHours: 0,
      monthsConsidered: 3,
      avgMonthlyHwMinutes: 120,
      avgMonthlyAllMinutes: 0,
    });
    const sollIst = deriveSollIst(wl, 5);
    // sollHours === null aber monthlyWorkHours !== null ⇒ UI rendert
    // den "kein Soll hinterlegt"-Branch (anderer Hinweistext, kein Link).
    expect(sollIst.sollHours).toBeNull();
    expect(wl.monthlyWorkHours).toBe(0);
    expect(sollIst.auslastungPct).toBeNull();
    expect(sollIst.freieStunden).toBeNull();
    expect(sollIst.moeglicheZusatzKunden).toBeNull();
  });

  it("monthsConsidered = 0 (komplett im Urlaub) → 'Auslastung n/a' + freie Stunden = Soll, Zusatzkunden n/a", () => {
    const wl = makeWorkload({
      monthlyWorkHours: 80,
      monthsConsidered: 0,
      avgMonthlyHwMinutes: 0,
      avgMonthlyAllMinutes: 0,
    });
    const sollIst = deriveSollIst(wl, 5);
    expect(sollIst.sollHours).toBe(80);
    expect(sollIst.istHours).toBe(0);
    expect(sollIst.auslastungPct).toBeNull();
    expect(sollIst.freieStunden).toBe(80);
    expect(sollIst.moeglicheZusatzKunden).toBeNull();
  });

  it("globalAvg = 0 bei vorhandenem Soll → 'Zusatzkunden n/a' (Auslastung wird normal berechnet)", () => {
    const wl = makeWorkload({
      monthlyWorkHours: 80,
      monthsConsidered: 3,
      avgMonthlyHwMinutes: 60 * 30,
      avgMonthlyAllMinutes: 0,
    });
    const sollIst = deriveSollIst(wl, 0);
    expect(sollIst.sollHours).toBe(80);
    expect(sollIst.istHours).toBe(30);
    expect(sollIst.auslastungPct).toBeCloseTo((30 / 80) * 100, 5);
    expect(sollIst.freieStunden).toBe(50);
    // globalAvg <= 0 ⇒ UI rendert "Zusatzkunden n/a".
    expect(sollIst.moeglicheZusatzKunden).toBeNull();
  });

  it("auslastungPct >= 100 → 'überlastet'-Klassifizierung (gerundet)", () => {
    // Ist exakt = Soll → 100 % → überlastet.
    const exact = deriveSollIst(
      makeWorkload({
        monthlyWorkHours: 80,
        monthsConsidered: 3,
        avgMonthlyHwMinutes: 60 * 80,
        avgMonthlyAllMinutes: 0,
      }),
      5,
    );
    expect(exact.auslastungPct).not.toBeNull();
    expect(Math.round(exact.auslastungPct as number)).toBeGreaterThanOrEqual(
      100,
    );

    // Ist > Soll → klar überlastet.
    const over = deriveSollIst(
      makeWorkload({
        monthlyWorkHours: 80,
        monthsConsidered: 3,
        avgMonthlyHwMinutes: 60 * 100,
        avgMonthlyAllMinutes: 0,
      }),
      5,
    );
    expect(Math.round(over.auslastungPct as number)).toBeGreaterThanOrEqual(
      100,
    );

    // Knapp darunter (99,4 %) → noch nicht überlastet (Rundung erst ab 99,5).
    const justUnder = deriveSollIst(
      makeWorkload({
        monthlyWorkHours: 100,
        monthsConsidered: 3,
        avgMonthlyHwMinutes: 60 * 99,
        avgMonthlyAllMinutes: 0,
      }),
      5,
    );
    expect(Math.round(justUnder.auslastungPct as number)).toBeLessThan(100);
  });
});
