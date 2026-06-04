/**
 * Task #974 — Budget-Exposure-Report gegen Fehlklassifizierung absichern.
 *
 * Reine Tests des Klassifizierungs-Kerns (`report-budget-exposure-core.ts`).
 * Gesichert wird, dass der Pre-Publish-Report keine stillen Fehler macht:
 *   - aktiver Topf mit 0 € ⇒ erschöpft;
 *   - inaktiver / außerhalb-Fenster-Topf ⇒ NICHT erschöpft (auch bei 0 €);
 *   - gesamt erschöpft nur, wenn ≥1 aktiver Topf existiert;
 *   - Selbstzahler ⇒ uncapped, aus jeder Zählung ausgenommen;
 *   - CSV-Zeile entspricht der (denselben MonthEval speisenden) Konsolenausgabe.
 */
import { describe, it, expect } from "vitest";
import type {
  PotAvailability,
  UnifiedBudgetAvailability,
  CappedBudgetPot,
} from "../../server/storage/budget/unified-reader";
import {
  evalPot,
  buildMonthEval,
  buildCustomerReport,
  classifyKind,
  potCell,
  toCsv,
  csvRowForMonth,
  CSV_HEADER,
  eurCsv,
  type MonthSlot,
  type CustomerReportBase,
} from "../../server/scripts/report-budget-exposure-core";

function pot(
  budgetType: CappedBudgetPot,
  opts: { enabled?: boolean; inRange?: boolean; availableCents: number },
): PotAvailability {
  const available = opts.availableCents;
  return {
    budgetType,
    enabled: opts.enabled ?? true,
    inRange: opts.inRange ?? true,
    allocatedCents: Math.max(0, available),
    consumedNetCents: 0,
    holdsActiveCents: 0,
    capRemainingCents: Infinity,
    availableCents: available,
  };
}

function unified(
  pots: {
    p45b: PotAvailability;
    p45a: PotAvailability;
    p39: PotAvailability;
  },
  asOfDate = "2026-06-30",
): UnifiedBudgetAvailability {
  const active = (p: PotAvailability) => (p.enabled && p.inRange ? p.availableCents : 0);
  const total45b = active(pots.p45b);
  const total45a = active(pots.p45a);
  const total39_42a = active(pots.p39);
  return {
    customerId: 1,
    asOfDate,
    pots: {
      entlastungsbetrag_45b: pots.p45b,
      umwandlung_45a: pots.p45a,
      ersatzpflege_39_42a: pots.p39,
    },
    total45b,
    total45a,
    total39_42a,
    totalCents: total45b + total45a + total39_42a,
    totalHoldsCents: 0,
  };
}

const SLOT: MonthSlot = { label: "2026-06", asOfDate: "2026-06-30" };

describe("evalPot — Topf-Erschöpfungs-Klassifizierung", () => {
  it("aktiver Topf mit 0 € ⇒ erschöpft", () => {
    const e = evalPot(pot("entlastungsbetrag_45b", { availableCents: 0 }));
    expect(e.active).toBe(true);
    expect(e.remainingCents).toBe(0);
    expect(e.exhausted).toBe(true);
  });

  it("aktiver Topf mit negativem Saldo ⇒ erschöpft", () => {
    const e = evalPot(pot("umwandlung_45a", { availableCents: -500 }));
    expect(e.active).toBe(true);
    expect(e.exhausted).toBe(true);
  });

  it("aktiver Topf mit Restbudget ⇒ NICHT erschöpft", () => {
    const e = evalPot(pot("ersatzpflege_39_42a", { availableCents: 12345 }));
    expect(e.active).toBe(true);
    expect(e.remainingCents).toBe(12345);
    expect(e.exhausted).toBe(false);
  });

  it("inaktiver Topf (enabled=false) mit 0 € ⇒ NICHT erschöpft, remaining=0", () => {
    const e = evalPot(
      pot("umwandlung_45a", { enabled: false, availableCents: 0 }),
    );
    expect(e.active).toBe(false);
    expect(e.remainingCents).toBe(0);
    expect(e.exhausted).toBe(false);
  });

  it("Topf außerhalb des Fensters (inRange=false) mit 0 € ⇒ NICHT erschöpft", () => {
    const e = evalPot(
      pot("entlastungsbetrag_45b", { inRange: false, availableCents: 0 }),
    );
    expect(e.active).toBe(false);
    expect(e.exhausted).toBe(false);
  });

  it("inaktiver Topf maskiert auch ein vorhandenes Guthaben (remaining=0)", () => {
    const e = evalPot(
      pot("ersatzpflege_39_42a", { enabled: false, availableCents: 9999 }),
    );
    expect(e.active).toBe(false);
    expect(e.remainingCents).toBe(0);
  });
});

describe("buildMonthEval — Gesamt-Erschöpfung", () => {
  it("≥1 aktiver Topf und totalCents ≤ 0 ⇒ overallExhausted", () => {
    const u = unified({
      p45b: pot("entlastungsbetrag_45b", { availableCents: 0 }),
      p45a: pot("umwandlung_45a", { enabled: false, availableCents: 0 }),
      p39: pot("ersatzpflege_39_42a", { enabled: false, availableCents: 0 }),
    });
    const m = buildMonthEval(SLOT, u);
    expect(m.activePots).toBe(1);
    expect(m.overallRemainingCents).toBe(0);
    expect(m.overallExhausted).toBe(true);
    expect(m.p45b.exhausted).toBe(true);
    expect(m.p45a.exhausted).toBe(false);
  });

  it("KEIN aktiver Topf (alle inaktiv) ⇒ NICHT overallExhausted trotz totalCents=0", () => {
    const u = unified({
      p45b: pot("entlastungsbetrag_45b", { enabled: false, availableCents: 0 }),
      p45a: pot("umwandlung_45a", { inRange: false, availableCents: 0 }),
      p39: pot("ersatzpflege_39_42a", { enabled: false, availableCents: 0 }),
    });
    const m = buildMonthEval(SLOT, u);
    expect(m.activePots).toBe(0);
    expect(m.overallRemainingCents).toBe(0);
    expect(m.overallExhausted).toBe(false);
  });

  it("aktiver Topf mit Restbudget ⇒ NICHT overallExhausted", () => {
    const u = unified({
      p45b: pot("entlastungsbetrag_45b", { availableCents: 10000 }),
      p45a: pot("umwandlung_45a", { enabled: false, availableCents: 0 }),
      p39: pot("ersatzpflege_39_42a", { enabled: false, availableCents: 0 }),
    });
    const m = buildMonthEval(SLOT, u);
    expect(m.activePots).toBe(1);
    expect(m.overallExhausted).toBe(false);
  });

  it("mehrere aktive Töpfe: nur der leere ist exhausted, gesamt > 0 ⇒ nicht overallExhausted", () => {
    const u = unified({
      p45b: pot("entlastungsbetrag_45b", { availableCents: 0 }),
      p45a: pot("umwandlung_45a", { availableCents: 5000 }),
      p39: pot("ersatzpflege_39_42a", { enabled: false, availableCents: 0 }),
    });
    const m = buildMonthEval(SLOT, u);
    expect(m.activePots).toBe(2);
    expect(m.p45b.exhausted).toBe(true);
    expect(m.p45a.exhausted).toBe(false);
    expect(m.overallRemainingCents).toBe(5000);
    expect(m.overallExhausted).toBe(false);
  });
});

describe("classifyKind / buildCustomerReport — Selbstzahler-Routing", () => {
  it("classifyKind: 'selbstzahler' ⇒ selbstzahler, sonst statutory", () => {
    expect(classifyKind("selbstzahler")).toBe("selbstzahler");
    expect(classifyKind("pflegekasse")).toBe("statutory");
    expect(classifyKind("")).toBe("statutory");
  });

  it("Selbstzahler ⇒ uncapped: leere Monate, anyExhausted=false, keine Indizes", () => {
    const base: CustomerReportBase = {
      id: 7,
      name: "Selbst Zahler",
      billingType: "selbstzahler",
      acceptsPrivatePayment: true,
      kind: "selbstzahler",
    };
    // Selbst wenn Monats-Evals mit Erschöpfung übergeben würden:
    const exhaustedMonth = buildMonthEval(
      SLOT,
      unified({
        p45b: pot("entlastungsbetrag_45b", { availableCents: 0 }),
        p45a: pot("umwandlung_45a", { enabled: false, availableCents: 0 }),
        p39: pot("ersatzpflege_39_42a", { enabled: false, availableCents: 0 }),
      }),
    );
    const r = buildCustomerReport(base, [exhaustedMonth]);
    expect(r.months).toEqual([]);
    expect(r.anyExhausted).toBe(false);
    expect(r.firstOverallIdx).toBeNull();
    expect(r.first45bIdx).toBeNull();
  });

  it("statutory ⇒ Indizes & anyExhausted aus den Monats-Evals abgeleitet", () => {
    const base: CustomerReportBase = {
      id: 3,
      name: "Stat Utory",
      billingType: "pflegekasse",
      acceptsPrivatePayment: false,
      kind: "statutory",
    };
    const ok = buildMonthEval(
      SLOT,
      unified({
        p45b: pot("entlastungsbetrag_45b", { availableCents: 10000 }),
        p45a: pot("umwandlung_45a", { enabled: false, availableCents: 0 }),
        p39: pot("ersatzpflege_39_42a", { enabled: false, availableCents: 0 }),
      }),
    );
    const empty = buildMonthEval(
      { label: "2026-07", asOfDate: "2026-07-31" },
      unified({
        p45b: pot("entlastungsbetrag_45b", { availableCents: 0 }),
        p45a: pot("umwandlung_45a", { enabled: false, availableCents: 0 }),
        p39: pot("ersatzpflege_39_42a", { enabled: false, availableCents: 0 }),
      }),
    );
    const r = buildCustomerReport(base, [ok, empty]);
    expect(r.firstOverallIdx).toBe(1);
    expect(r.first45bIdx).toBe(1);
    expect(r.first45aIdx).toBeNull();
    expect(r.anyExhausted).toBe(true);
  });
});

describe("CSV ↔ Konsole — gemeinsame Quelle (keine Drift)", () => {
  const base: CustomerReportBase = {
    id: 42,
    name: "Mueller Anna",
    billingType: "pflegekasse",
    acceptsPrivatePayment: false,
    kind: "statutory",
  };
  const month = buildMonthEval(
    SLOT,
    unified({
      p45b: pot("entlastungsbetrag_45b", { availableCents: 0 }),
      p45a: pot("umwandlung_45a", { availableCents: 5000 }),
      p39: pot("ersatzpflege_39_42a", { enabled: false, availableCents: 0 }),
    }),
  );
  const report = buildCustomerReport(base, [month]);

  it("CSV-Zelle spiegelt exakt die Konsolen-Klassifizierung (active/remaining/exhausted)", () => {
    const row = csvRowForMonth(report, month).split(",");
    const col = (name: (typeof CSV_HEADER)[number]) => row[CSV_HEADER.indexOf(name)];

    // §45b: aktiv, 0 €, erschöpft → Konsole zeigt "⚠".
    expect(col("p45bActive")).toBe("true");
    expect(col("p45bRemainingEur")).toBe(eurCsv(month.p45b.remainingCents));
    expect(col("p45bExhausted")).toBe("true");
    expect(potCell("§45b", month.p45b)).toContain("⚠");

    // §45a: aktiv, 50 €, nicht erschöpft.
    expect(col("p45aActive")).toBe("true");
    expect(col("p45aRemainingEur")).toBe(eurCsv(5000));
    expect(col("p45aExhausted")).toBe("false");
    expect(potCell("§45a", month.p45a)).not.toContain("⚠");

    // §39+§42a: inaktiv → CSV "n/a", Konsole "inaktiv".
    expect(col("p39Active")).toBe("false");
    expect(col("p39RemainingEur")).toBe("n/a");
    expect(potCell("§39", month.p39)).toBe("§39 inaktiv");

    // Gesamt-Spalten konsistent.
    expect(col("activePots")).toBe(String(month.activePots));
    expect(col("overallRemainingEur")).toBe(eurCsv(month.overallRemainingCents));
    expect(col("overallExhausted")).toBe(String(month.overallExhausted));
  });

  it("CSV-Komma im Namen wird escaped (eine Datenzeile bleibt eine Zeile)", () => {
    const commaReport = buildCustomerReport(
      { ...base, name: "Mueller, Anna" },
      [month],
    );
    const csv = toCsv([commaReport], [SLOT]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2); // Header + 1 Datenzeile
    expect(lines[0]).toBe(CSV_HEADER.join(","));
    expect(lines[1]).toContain('"Mueller, Anna"');
  });

  it("Selbstzahler-CSV: durchgängig uncapped/false, eine Zeile pro Monat", () => {
    const sz = buildCustomerReport(
      {
        id: 9,
        name: "Selbst Zahler",
        billingType: "selbstzahler",
        acceptsPrivatePayment: true,
        kind: "selbstzahler",
      },
      [],
    );
    const months: MonthSlot[] = [SLOT, { label: "2026-07", asOfDate: "2026-07-31" }];
    const lines = toCsv([sz], months).split("\n");
    expect(lines).toHaveLength(1 + months.length);
    for (const line of lines.slice(1)) {
      const row = line.split(",");
      const col = (name: (typeof CSV_HEADER)[number]) => row[CSV_HEADER.indexOf(name)];
      expect(col("overallExhausted")).toBe("false");
      expect(col("overallRemainingEur")).toBe("uncapped");
      expect(col("p45bExhausted")).toBe("false");
      expect(col("p45bRemainingEur")).toBe("uncapped");
    }
  });
});
