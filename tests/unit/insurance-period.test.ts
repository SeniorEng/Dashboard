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
  isIsoDate,
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
describe("isIsoDate / isMonthStartISO — Form UND Kalender", () => {
  it("weist form-korrekte, aber nicht existierende Daten ab", () => {
    for (const bogus of ["2026-13-45", "2026-02-30", "2025-02-29", "2026-00-10", "2026-04-31"]) {
      expect(isIsoDate(bogus), bogus).toBe(false);
      expect(isMonthStartISO(bogus), bogus).toBe(false);
    }
  });

  it("laesst echte Daten inkl. Schaltjahr durch", () => {
    for (const good of ["2026-08-14", "2024-02-29", "2026-12-31", "2026-01-01"]) {
      expect(isIsoDate(good), good).toBe(true);
    }
    expect(isMonthStartISO("2026-01-01")).toBe(true);
    expect(isMonthStartISO("2026-01-02")).toBe(false);
  });

  it("verwirft Nicht-Strings und falsche Formate", () => {
    for (const bad of [null, undefined, "", "14.08.2026", "2026-8-14", "2026-08-14T00:00:00Z"]) {
      expect(isIsoDate(bad), String(bad)).toBe(false);
    }
  });
});

describe("firstInsuranceAnchorISO — Anker der Erstzuordnung", () => {
  const T = "2026-08-14"; // heute, mitten im Monat

  it("rundet ein angefragtes Datum mitten im Monat auf den 1. ab", () => {
    expect(firstInsuranceAnchorISO(T, null, T)).toBe("2026-08-01");
  });

  it("zieht auf den Vertragsbeginn zurueck, wenn der frueher liegt", () => {
    expect(firstInsuranceAnchorISO(T, "2026-07-15", T)).toBe("2026-07-01");
  });

  it("BLOCKER-Regression: datiert NICHT auf einen alten Vertrag zurueck, den der Aufrufer nicht mitgibt", () => {
    // Bestandskunde seit 2019, erste Kassenzuordnung heute. Ohne den
    // angefragten Wert im Anker landete hier `2019-03-01` — und ordnete damit
    // JEDEN vergangenen Abrechnungsmonat rueckwirkend dieser Kasse zu.
    expect(firstInsuranceAnchorISO(T, null, T)).toBe("2026-08-01");
  });

  it("verschiebt ein frueher angefragtes Datum NICHT nach vorn (kein Deckungsverlust)", () => {
    // Nacherfassung: angefragt 2024-03-05, Vertrag erst 2026-01-01.
    expect(firstInsuranceAnchorISO("2024-03-05", "2026-01-01", T)).toBe("2024-03-01");
  });

  // Fachliche Entscheidung Alrik, 04.08.2026: ein angefragtes Zukunftsdatum
  // wird HONORIERT. Die Vorgaengerfassung nahm `heute` als harten Startwert und
  // zog ein Fenster ab 15.01.2027 auf den 01.08.2026 zurueck — die Kasse bekam
  // fuenf Monate zugeordnet, in denen sie nicht zustaendig war (derselbe
  // GoBD-Schaden wie die Rueckdatierung, nur aus der Gegenrichtung).
  it("BLOCKER-Regression: honoriert ein angefragtes Zukunftsdatum, statt es auf heute zurueckzuziehen", () => {
    expect(firstInsuranceAnchorISO("2027-01-15", null, T)).toBe("2027-01-01");
  });

  it("honoriert auch einen zukuenftigen Vertragsbeginn, wenn er frueher als das angefragte Datum liegt", () => {
    // Beide in der Zukunft: das Minimum gewinnt, `heute` mischt sich nicht ein.
    expect(firstInsuranceAnchorISO("2027-05-09", "2027-01-01", T)).toBe("2027-01-01");
  });

  it("laesst den Wizard-Fall unveraendert: validFrom=heute ergibt den Monatsersten von heute", () => {
    // Der Pfad, der den Prod-Blocker ausgeloest hat. Ein zukuenftiger
    // Vertragsbeginn darf ihn NICHT nach vorn schieben — `heute` ist frueher
    // und gewinnt das Minimum.
    expect(firstInsuranceAnchorISO(T, null, T)).toBe("2026-08-01");
    expect(firstInsuranceAnchorISO(T, "2026-12-01", T)).toBe("2026-08-01");
  });

  // Die Gegenzusage zur Zukunfts-Honorierung: nach hinten bleibt es zu.
  it("RUECKWAERTS-BOUND: greift nie in einen Monat vor Anfrage UND Vertrag", () => {
    const cases = [
      { req: T, start: null, floor: "2026-08-01" },
      { req: T, start: "2026-07-15", floor: "2026-07-01" },
      { req: "2024-03-05", start: "2026-01-01", floor: "2024-03-01" },
      { req: "2027-01-15", start: null, floor: "2027-01-01" },
    ] as const;
    for (const { req, start, floor } of cases) {
      // `floor` ist der Monatserste des FRUEHESTEN Kandidaten. Der Anker darf
      // ihn nie unterschreiten — sonst reichte die Erstzuordnung in
      // Zeitraeume, die niemand angefragt hat und die u.U. abgerechnet sind.
      expect(firstInsuranceAnchorISO(req, start, T) >= floor).toBe(true);
      expect(firstInsuranceAnchorISO(req, start, T)).toBe(floor);
    }
  });

  it("RUECKWAERTS-BOUND: `heute` zieht den Anker nicht in bereits abgerechnete Monate", () => {
    // Nacherfassung im August fuer einen Kunden ohne bekannten Vertragsbeginn:
    // Juni und Juli sind laengst abgerechnet und muessen unberuehrt bleiben.
    expect(firstInsuranceAnchorISO("2026-08-01", null, T)).toBe("2026-08-01");
    // Auch ein spaeter Aufruf mit spaetem `heute` darf nicht zurueckgreifen.
    expect(firstInsuranceAnchorISO("2026-08-20", undefined, "2026-12-31")).toBe("2026-08-01");
  });

  it("liegt NIE nach dem Vertragsbeginn", () => {
    for (const start of ["2026-07-15", "2026-08-01", "2020-02-29"] as const) {
      expect(firstInsuranceAnchorISO(T, start, T) <= start).toBe(true);
    }
  });

  it("kommt ohne Vertragsbeginn aus und vertraegt kaputte Eingaben", () => {
    expect(firstInsuranceAnchorISO(T, undefined, T)).toBe("2026-08-01");
    expect(firstInsuranceAnchorISO(T, "", T)).toBe("2026-08-01");
    // Form stimmt, Datum gibt es nicht: KEIN Kandidat. Sonst entstuende hier
    // der „Monatserste" 2026-13-01, den `validateInsuranceWindow` durchlaesst
    // und erst Postgres mit einem 500 ablehnt.
    expect(firstInsuranceAnchorISO("2026-13-45", null, T)).toBe("2026-08-01");
    expect(firstInsuranceAnchorISO("2026-02-30", null, T)).toBe("2026-08-01");
    expect(firstInsuranceAnchorISO(T, "2026-02-30", T)).toBe("2026-08-01");
  });

  it("ist idempotent auf einem Monatsersten", () => {
    expect(firstInsuranceAnchorISO("2026-08-01", null, T)).toBe("2026-08-01");
  });

  it("liefert immer einen Monatsersten — den der harte Wechsel-Check akzeptiert", () => {
    for (const [req, start] of [[T, null], ["2024-03-05", "2026-01-01"], [T, "2019-03-05"]] as const) {
      const anchor = firstInsuranceAnchorISO(req, start, T);
      expect(isMonthStartISO(anchor)).toBe(true);
      expect(validateInsuranceWindow({ validFrom: anchor, validTo: null })).toBeNull();
    }
  });
});
