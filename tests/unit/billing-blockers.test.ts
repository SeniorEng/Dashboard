import { describe, it, expect } from "vitest";
import {
  isDocumentationOverdue48h,
  buildDocumentationBlockers,
  selectBudgetBlockers,
  OVERDUE_DOCUMENTATION_DAYS,
} from "@shared/domain/billing-blockers";

const NOW = new Date("2026-06-26T00:00:00");

describe("isDocumentationOverdue48h", () => {
  it("ist überfällig ab zwei Tagen Rückstand", () => {
    expect(isDocumentationOverdue48h({ date: "2026-06-24" }, NOW)).toBe(true);
    expect(OVERDUE_DOCUMENTATION_DAYS).toBe(2);
  });

  it("ist nicht überfällig bei einem Tag oder weniger", () => {
    expect(isDocumentationOverdue48h({ date: "2026-06-25" }, NOW)).toBe(false);
    expect(isDocumentationOverdue48h({ date: "2026-06-26" }, NOW)).toBe(false);
    expect(isDocumentationOverdue48h({ date: "2026-06-27" }, NOW)).toBe(false);
  });
});

describe("buildDocumentationBlockers", () => {
  const employees = [
    {
      displayName: "Anna Muster",
      openAppointments: [
        { id: 10, date: "2026-06-25", scheduledStart: "09:00", status: "scheduled", customerName: "Kunde A" },
      ],
      unsignedAppointments: [
        { id: 11, date: "2026-06-20", scheduledStart: "10:00", status: "completed", customerName: "Kunde B" },
      ],
    },
    {
      displayName: null,
      openAppointments: [
        { id: 12, date: "2026-06-30", scheduledStart: null, status: "scheduled", customerName: "Kunde C" },
      ],
      unsignedAppointments: [],
    },
  ];

  it("fasst offene und unsignierte Termine zusammen, sortiert nach Alter", () => {
    const items = buildDocumentationBlockers(employees, NOW);
    expect(items.map((i) => i.appointmentId)).toEqual([11, 10, 12]);
  });

  it("setzt Überfälligkeits-Flag und Mitarbeiter-Fallback", () => {
    const items = buildDocumentationBlockers(employees, NOW);
    const overdue = items.find((i) => i.appointmentId === 11)!;
    expect(overdue.overdue).toBe(true);
    expect(overdue.daysOverdue).toBe(6);
    expect(overdue.employeeName).toBe("Anna Muster");

    const open = items.find((i) => i.appointmentId === 10)!;
    expect(open.overdue).toBe(false);

    const future = items.find((i) => i.appointmentId === 12)!;
    expect(future.daysOverdue).toBeLessThan(0);
    expect(future.employeeName).toBe("Unbekannt");
  });
});

describe("selectBudgetBlockers", () => {
  const names = new Map<number, string>([
    [1, "Kunde A"],
    [2, "Kunde B"],
  ]);

  const potRows = [
    { customerId: 1, budgetType: "entlastungsbetrag_45b", allocatedCents: 10000, netConsumedCents: 13000, overdrawn: true },
    { customerId: 2, budgetType: "umwandlung_45a", allocatedCents: 5000, netConsumedCents: 5500, overdrawn: true },
    { customerId: 1, budgetType: "ersatzpflege_39_42a", allocatedCents: 8000, netConsumedCents: 7000, overdrawn: false },
    { customerId: 9, budgetType: "entlastungsbetrag_45b", allocatedCents: 1000, netConsumedCents: 9999, overdrawn: true },
  ];

  it("liefert nur überzogene Töpfe aktiver Kunden, sortiert nach Fehlbetrag", () => {
    const items = selectBudgetBlockers(potRows, names);
    expect(items.map((i) => i.customerId)).toEqual([1, 2]);
    expect(items[0].shortfallCents).toBe(3000);
    expect(items[1].shortfallCents).toBe(500);
  });

  it("ignoriert Kunden außerhalb des Zeitraums und nicht-überzogene Töpfe", () => {
    const items = selectBudgetBlockers(potRows, names);
    expect(items.some((i) => i.customerId === 9)).toBe(false);
    expect(items.some((i) => i.budgetType === "ersatzpflege_39_42a")).toBe(false);
  });
});
