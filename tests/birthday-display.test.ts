import { describe, it, expect } from "vitest";
import {
  getBirthdayYear,
  getDaysLabel,
  getDaysColor,
  compareBirthdays,
  computeBirthdayStats,
  type EnrichedBirthday,
} from "../client/src/features/birthdays/lib/birthday-display";

const FIXED_TODAY = new Date(2026, 4, 13);

function entry(partial: Partial<EnrichedBirthday>): EnrichedBirthday {
  return {
    id: 1,
    type: "customer",
    name: "Test",
    geburtsdatum: "1950-05-13",
    daysUntil: 0,
    age: 76,
    address: undefined,
    birthdayYear: 2026,
    cardSent: false,
    cardSentAt: null,
    ...partial,
  };
}

describe("birthday-display: getBirthdayYear", () => {
  it("zukünftiger Geburtstag im selben Jahr", () => {
    expect(getBirthdayYear({ daysUntil: 5 }, FIXED_TODAY)).toBe(2026);
  });
  it("Geburtstag heute zählt zum aktuellen Jahr", () => {
    expect(getBirthdayYear({ daysUntil: 0 }, FIXED_TODAY)).toBe(2026);
  });
  it("zukünftiger Geburtstag rollt in nächstes Jahr (Dezember -> Januar)", () => {
    expect(getBirthdayYear({ daysUntil: 360 }, FIXED_TODAY)).toBe(2027);
  });
  it("überfälliger Geburtstag (negativ) bleibt im aktuellen Kalenderjahr", () => {
    expect(getBirthdayYear({ daysUntil: -1 }, FIXED_TODAY)).toBe(2026);
    expect(getBirthdayYear({ daysUntil: -120 }, FIXED_TODAY)).toBe(2026);
  });
});

describe("birthday-display: getDaysLabel", () => {
  it("Heute / Morgen / in N Tagen", () => {
    expect(getDaysLabel(0)).toBe("Heute");
    expect(getDaysLabel(1)).toBe("Morgen");
    expect(getDaysLabel(5)).toBe("in 5 Tagen");
  });
  it("negative Werte: 'vor X Tagen' (Singular für 1)", () => {
    expect(getDaysLabel(-1)).toBe("vor 1 Tag");
    expect(getDaysLabel(-3)).toBe("vor 3 Tagen");
    expect(getDaysLabel(-90)).toBe("vor 90 Tagen");
  });
});

describe("birthday-display: getDaysColor", () => {
  it("versendet ist immer grün, auch bei überfällig", () => {
    expect(getDaysColor(-5, true)).toBe("text-green-600");
    expect(getDaysColor(20, true)).toBe("text-green-600");
  });
  it("überfällig + nicht versendet ist rot/fett", () => {
    expect(getDaysColor(-1, false)).toBe("text-red-700 font-semibold");
  });
  it("Eskalations-Farben bleiben für zukünftige Werte erhalten", () => {
    expect(getDaysColor(2, false)).toBe("text-red-600 font-semibold");
    expect(getDaysColor(5, false)).toBe("text-orange-600 font-medium");
    expect(getDaysColor(10, false)).toBe("text-amber-600");
    expect(getDaysColor(20, false)).toBe("text-muted-foreground");
  });
});

describe("birthday-display: compareBirthdays sort", () => {
  it("überfällige + nicht versendete stehen ganz oben, versendete unten", () => {
    const list = [
      entry({ id: 1, daysUntil: 5, cardSent: false }),
      entry({ id: 2, daysUntil: -2, cardSent: false }),
      entry({ id: 3, daysUntil: 3, cardSent: true }),
      entry({ id: 4, daysUntil: -10, cardSent: false }),
      entry({ id: 5, daysUntil: -5, cardSent: true }),
    ];
    const sorted = [...list].sort(compareBirthdays).map((e) => e.id);
    expect(sorted).toEqual([4, 2, 1, 5, 3]);
  });
});

describe("birthday-display: computeBirthdayStats", () => {
  it("zählt overdue, urgent (nur zukünftig), upcoming, sent, pending korrekt", () => {
    const list = [
      entry({ id: 1, daysUntil: -3, cardSent: false }),
      entry({ id: 2, daysUntil: -1, cardSent: true }),
      entry({ id: 3, daysUntil: 0, cardSent: false }),
      entry({ id: 4, daysUntil: 5, cardSent: false }),
      entry({ id: 5, daysUntil: 20, cardSent: true }),
      entry({ id: 6, daysUntil: 60, cardSent: false }),
    ];
    const s = computeBirthdayStats(list);
    expect(s.total).toBe(6);
    expect(s.sent).toBe(2);
    expect(s.pending).toBe(4);
    expect(s.upcoming).toBe(3);
    expect(s.urgent).toBe(2);
    expect(s.overdue).toBe(1);
  });
});
