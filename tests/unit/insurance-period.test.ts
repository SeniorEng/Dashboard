/**
 * Task #1893 — Zeitraum-Semantik der Kostenträger-Zuordnung (pure Domain).
 *
 * Deckt die drei Regeln ab, auf denen der Stichtags-Resolver aufsetzt:
 * Stichtag = Ende des Abrechnungszeitraums, Wechsel nur zum Monatsersten,
 * Fenster überlappungs- und lückenfrei.
 */
import { describe, it, expect } from "vitest";
import {
  billingPeriodAsOfISO,
  dayBeforeISO,
  firstInsuranceAnchorISO,
  isMonthStartISO,
  pickInsuranceWindowAt,
  validateInsuranceWindow,
  validateInsuranceWindows,
  INSURANCE_WINDOW_MUST_START_ON_FIRST,
} from "@shared/domain/insurance-period";

describe("billingPeriodAsOfISO — Stichtag ist das Ende des Zeitraums", () => {
  it("liefert den letzten Tag des Abrechnungsmonats", () => {
    expect(billingPeriodAsOfISO(2026, 5)).toBe("2026-05-31");
    expect(billingPeriodAsOfISO(2026, 6)).toBe("2026-06-30");
    expect(billingPeriodAsOfISO(2026, 2)).toBe("2026-02-28");
  });

  it("berücksichtigt Schaltjahre", () => {
    expect(billingPeriodAsOfISO(2028, 2)).toBe("2028-02-29");
  });

  it("ein explizites dateTo (Teilmonat) hat Vorrang", () => {
    expect(billingPeriodAsOfISO(2026, 5, "2026-05-15")).toBe("2026-05-15");
  });

  it("ignoriert ein unbrauchbares dateTo und fällt auf das Monatsende zurück", () => {
    expect(billingPeriodAsOfISO(2026, 5, null)).toBe("2026-05-31");
    expect(billingPeriodAsOfISO(2026, 5, "")).toBe("2026-05-31");
    expect(billingPeriodAsOfISO(2026, 5, "kaputt")).toBe("2026-05-31");
  });
});

describe("dayBeforeISO — Vorgängerfenster schließt lückenlos", () => {
  it("liefert für einen Monatsersten den letzten Tag des Vormonats", () => {
    expect(dayBeforeISO("2026-06-01")).toBe("2026-05-31");
    expect(dayBeforeISO("2026-03-01")).toBe("2026-02-28");
    expect(dayBeforeISO("2026-01-01")).toBe("2025-12-31");
  });
});

describe("isMonthStartISO", () => {
  it("erkennt Monatserste", () => {
    expect(isMonthStartISO("2026-06-01")).toBe(true);
    expect(isMonthStartISO("2026-06-02")).toBe(false);
    expect(isMonthStartISO("2026-06-30")).toBe(false);
  });
});

describe("validateInsuranceWindow — 01.-Erzwingung", () => {
  it("akzeptiert den Monatsersten", () => {
    expect(validateInsuranceWindow({ validFrom: "2026-06-01", validTo: null })).toBeNull();
  });

  it("lehnt jeden anderen Tag mit deutscher Meldung ab", () => {
    expect(validateInsuranceWindow({ validFrom: "2026-06-15", validTo: null }))
      .toBe(INSURANCE_WINDOW_MUST_START_ON_FIRST);
  });

  it("lehnt ein rückwärts laufendes Fenster ab", () => {
    const err = validateInsuranceWindow({ validFrom: "2026-06-01", validTo: "2026-05-01" });
    expect(err).toContain("liegt vor");
  });

  it("lehnt unbrauchbare Datumsangaben ab", () => {
    expect(validateInsuranceWindow({ validFrom: "kaputt", validTo: null })).toContain("kein gültiges Datum");
    expect(validateInsuranceWindow({ validFrom: "2026-06-01", validTo: "kaputt" })).toContain("kein gültiges Datum");
  });
});

describe("validateInsuranceWindows — Kette überlappungs- und lückenfrei", () => {
  it("akzeptiert eine saubere Kette mit offenem Ende", () => {
    expect(validateInsuranceWindows([
      { validFrom: "2025-01-01", validTo: "2026-05-31" },
      { validFrom: "2026-06-01", validTo: null },
    ])).toBeNull();
  });

  it("lehnt Überlappung ab", () => {
    const err = validateInsuranceWindows([
      { validFrom: "2025-01-01", validTo: "2026-06-30" },
      { validFrom: "2026-06-01", validTo: null },
    ]);
    expect(err).toContain("überschneiden");
  });

  it("lehnt eine Lücke ab und nennt das erwartete Ende", () => {
    const err = validateInsuranceWindows([
      { validFrom: "2025-01-01", validTo: "2026-04-30" },
      { validFrom: "2026-06-01", validTo: null },
    ]);
    expect(err).toContain("Lücke");
    expect(err).toContain("2026-05-31");
  });

  it("lehnt ein zweites offenes Ende ab", () => {
    const err = validateInsuranceWindows([
      { validFrom: "2025-01-01", validTo: null },
      { validFrom: "2026-06-01", validTo: null },
    ]);
    expect(err).toContain("Nur die jüngste Zuordnung darf offen bleiben");
  });

  it("lehnt zwei Zuordnungen mit demselben Beginn ab", () => {
    const err = validateInsuranceWindows([
      { validFrom: "2026-06-01", validTo: "2026-08-31" },
      { validFrom: "2026-06-01", validTo: null },
    ]);
    expect(err).toContain("selben Tag");
  });

  it("erzwingt die 01.-Regel auch in der Kette", () => {
    expect(validateInsuranceWindows([
      { validFrom: "2026-06-15", validTo: null },
    ])).toBe(INSURANCE_WINDOW_MUST_START_ON_FIRST);
  });
});

describe("pickInsuranceWindowAt — spiegelt das SQL-Prädikat", () => {
  const alt = { id: 1, validFrom: "2025-01-01", validTo: "2026-05-31" };
  const neu = { id: 2, validFrom: "2026-06-01", validTo: null };
  const windows = [alt, neu];

  it("Mai-Stichtag trifft die alte Kasse", () => {
    expect(pickInsuranceWindowAt(windows, "2026-05-31")?.id).toBe(1);
  });

  it("Juni-Stichtag trifft die neue Kasse", () => {
    expect(pickInsuranceWindowAt(windows, "2026-06-30")?.id).toBe(2);
  });

  it("die Grenze ist beidseitig inklusiv", () => {
    expect(pickInsuranceWindowAt(windows, "2026-06-01")?.id).toBe(2);
    expect(pickInsuranceWindowAt(windows, "2026-05-30")?.id).toBe(1);
  });

  it("vor dem ersten Fenster gibt es keine Zuordnung", () => {
    expect(pickInsuranceWindowAt(windows, "2024-12-31")).toBeUndefined();
  });

  it("bei überlappenden Altdaten gewinnt das jüngste validFrom", () => {
    const dirty = [
      { id: 1, validFrom: "2025-01-01", validTo: null },
      { id: 2, validFrom: "2026-06-01", validTo: null },
    ];
    expect(pickInsuranceWindowAt(dirty, "2026-07-15")?.id).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Task #1898 — Erstzuordnung normalisieren, Wechsel NICHT.
// ---------------------------------------------------------------------------
describe("firstInsuranceAnchorISO — Anker der Erstzuordnung", () => {
  it("rundet den frueheren von (Vertragsbeginn, heute) auf den Monatsersten ab", () => {
    // Vertragsbeginn liegt zurueck -> er gewinnt das Minimum.
    expect(firstInsuranceAnchorISO("2026-07-15", "2026-08-04")).toBe("2026-07-01");
  });

  it("nimmt heute, wenn der Vertragsbeginn spaeter liegt", () => {
    expect(firstInsuranceAnchorISO("2026-09-20", "2026-08-14")).toBe("2026-08-01");
  });

  it("liegt NIE in der Zukunft — auch nicht bei zukuenftigem Vertragsbeginn", () => {
    const anchor = firstInsuranceAnchorISO("2027-01-01", "2026-08-14");
    expect(anchor <= "2026-08-14").toBe(true);
    expect(anchor).toBe("2026-08-01");
  });

  it("liegt NIE nach dem Vertragsbeginn — sonst entstuende eine Kassen-Luecke", () => {
    for (const [start, today] of [
      ["2026-07-15", "2026-08-04"],
      ["2026-08-01", "2026-08-31"],
      ["2026-02-29", "2026-03-01"],
    ] as const) {
      expect(firstInsuranceAnchorISO(start, today) <= start).toBe(true);
    }
  });

  it("kommt ohne Vertragsbeginn aus (Monatserster von heute)", () => {
    expect(firstInsuranceAnchorISO(null, "2026-08-14")).toBe("2026-08-01");
    expect(firstInsuranceAnchorISO(undefined, "2026-08-14")).toBe("2026-08-01");
    expect(firstInsuranceAnchorISO("", "2026-08-14")).toBe("2026-08-01");
  });

  it("ist idempotent auf einem Monatsersten", () => {
    expect(firstInsuranceAnchorISO("2026-08-01", "2026-08-20")).toBe("2026-08-01");
  });

  it("liefert immer einen Monatsersten — den der harte Wechsel-Check akzeptiert", () => {
    for (const [start, today] of [
      ["2026-07-15", "2026-08-04"],
      [null, "2026-12-31"],
      ["2024-02-29", "2026-08-04"],
    ] as const) {
      const anchor = firstInsuranceAnchorISO(start, today);
      expect(isMonthStartISO(anchor)).toBe(true);
      expect(validateInsuranceWindow({ validFrom: anchor, validTo: null })).toBeNull();
    }
  });
});
