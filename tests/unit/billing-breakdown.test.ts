/**
 * Task #1453 — PURE unit tests für die Abrechnungs-Breakdown-Domäne.
 *
 * Zwei Garantien werden geprüft:
 *  1. FIX des 0,0h-Bugs: abgerechnete/bezahlte Einheiten (Late-Stage) liefern
 *     ihre Stunden weiterhin aus `invoice_line_items.duration_minutes` via
 *     `computeMinutesByInvoiceStage` — die Stunden-Spalten sind NICHT 0.
 *  2. €-Konservierung: die Σ der Breakdown-Zeilen entspricht EXAKT der
 *     Stufen-Summe der Pipeline (`summarizePipelineCents().stageTotalCents`),
 *     weil nur `stage`-Einheiten einfließen (keine Doppelzählung).
 */
import { describe, it, expect } from "vitest";
import {
  categorizeServiceCode,
  computeMinutesByInvoiceStage,
  aggregateBreakdownUnits,
  groupBillingBreakdown,
  summarizeBreakdownRows,
  type BreakdownSourceUnit,
} from "@shared/domain/billing-breakdown";
import { summarizePipelineCents, type PipelineAtomicUnit } from "@shared/domain/billing-pipeline";

describe("categorizeServiceCode", () => {
  it("ordnet Katalog-Codes ihrer Leistungsart zu, km-Codes haben Vorrang", () => {
    expect(categorizeServiceCode("hauswirtschaft")).toBe("hauswirtschaft");
    expect(categorizeServiceCode("alltagsbegleitung")).toBe("alltagsbegleitung");
    expect(categorizeServiceCode("travel_km")).toBe("km");
    expect(categorizeServiceCode("customer_km")).toBe("km");
    expect(categorizeServiceCode("unbekannt")).toBe("sonstige");
    expect(categorizeServiceCode(null)).toBe("sonstige");
  });
});

describe("computeMinutesByInvoiceStage (0,0h-Fix)", () => {
  it("aggregiert Minuten je Leistungsart und km roh aus Rechnungs-Lines", () => {
    const breakdown = computeMinutesByInvoiceStage([
      { serviceCode: "hauswirtschaft", durationMinutes: 90 },
      { serviceCode: "hauswirtschaft", durationMinutes: 30 },
      { serviceCode: "alltagsbegleitung", durationMinutes: 60 },
      { serviceCode: "travel_km", durationMinutes: 0, quantityRaw: 12.5 },
      { serviceCode: null, durationMinutes: 15 },
    ]);
    expect(breakdown.hauswirtschaftMinutes).toBe(120);
    expect(breakdown.alltagsbegleitungMinutes).toBe(60);
    expect(breakdown.kmRaw).toBeCloseTo(12.5, 6);
    expect(breakdown.sonstigeMinutes).toBe(15);
  });
});

describe("Breakdown-Aggregation: Stunden > 0 für abgerechnete/bezahlte Termine", () => {
  // Eine bereits abgerechnete Rechnung (Late-Stage „rechnung_erstellt") und eine
  // bezahlte Rechnung (Late-Stage „bezahlt"). In der alten appointment-basierten
  // Sicht wären deren Stunden 0,0h — hier kommen sie aus den Line-Items.
  const invoicedLines = [
    { serviceCode: "hauswirtschaft", durationMinutes: 120 },
    { serviceCode: "travel_km", durationMinutes: 0, quantityRaw: 8 },
  ];
  const paidLines = [
    { serviceCode: "alltagsbegleitung", durationMinutes: 45 },
    { serviceCode: "hauswirtschaft", durationMinutes: 30 },
  ];

  const sources: BreakdownSourceUnit[] = [
    {
      assignment: { kind: "stage", stage: "rechnung_erstellt" },
      customerId: 1,
      customerName: "Anna Muster",
      billingType: "selbstzahler",
      cents: 5000,
      category: computeMinutesByInvoiceStage(invoicedLines),
    },
    {
      assignment: { kind: "stage", stage: "bezahlt" },
      customerId: 2,
      customerName: "Bernd Beispiel",
      billingType: "pflegekasse_gesetzlich",
      cents: 3000,
      category: computeMinutesByInvoiceStage(paidLines),
    },
    // Offener (noch nicht abgerechneter) Termin — Early-Stage.
    {
      assignment: { kind: "stage", stage: "offen" },
      customerId: 1,
      customerName: "Anna Muster",
      billingType: "selbstzahler",
      cents: 1000,
      category: {
        hauswirtschaftMinutes: 60,
        alltagsbegleitungMinutes: 0,
        kmRaw: 4,
        sonstigeMinutes: 0,
      },
    },
    // Side-Einheit (Storno) — darf NICHT in die Tabelle einfließen.
    {
      assignment: { kind: "side", state: "storniert" },
      customerId: 1,
      customerName: "Anna Muster",
      billingType: "selbstzahler",
      cents: -9999,
      category: {
        hauswirtschaftMinutes: 999,
        alltagsbegleitungMinutes: 999,
        kmRaw: 999,
        sonstigeMinutes: 0,
      },
    },
    // Excluded-Einheit (invoiced) — darf NICHT in die Tabelle einfließen.
    {
      assignment: { kind: "excluded", reason: "invoiced" },
      customerId: 2,
      customerName: "Bernd Beispiel",
      billingType: "pflegekasse_gesetzlich",
      cents: 7777,
      category: {
        hauswirtschaftMinutes: 888,
        alltagsbegleitungMinutes: 888,
        kmRaw: 888,
        sonstigeMinutes: 0,
      },
    },
  ];

  it("liefert für abgerechnete/bezahlte Einheiten Stunden > 0 (kein 0,0h)", () => {
    const units = aggregateBreakdownUnits(sources);
    const anna = units.find((u) => u.customerId === 1);
    const bernd = units.find((u) => u.customerId === 2);
    expect(anna).toBeDefined();
    expect(bernd).toBeDefined();
    // Anna: 120 (Rechnung) + 60 (offen) HW.
    expect(anna!.hauswirtschaftMinutes).toBe(180);
    expect(anna!.hauswirtschaftMinutes).toBeGreaterThan(0);
    // Bernd: bezahlte Rechnung trägt weiterhin seine Stunden bei.
    expect(bernd!.hauswirtschaftMinutes).toBe(30);
    expect(bernd!.alltagsbegleitungMinutes).toBe(45);
    expect(bernd!.alltagsbegleitungMinutes).toBeGreaterThan(0);
  });

  it("ignoriert Side-/excluded-Einheiten vollständig (Minuten + km + €)", () => {
    const units = aggregateBreakdownUnits(sources);
    const anna = units.find((u) => u.customerId === 1)!;
    const bernd = units.find((u) => u.customerId === 2)!;
    // Storno-Stunden/km (999) dürfen Anna NICHT erreichen.
    expect(anna.alltagsbegleitungMinutes).toBe(0);
    expect(anna.kmRaw).toBeCloseTo(12, 6); // 8 (Rechnung) + 4 (offen)
    expect(anna.totalCents).toBe(6000); // 5000 + 1000, ohne Storno-(-9999)
    // Excluded (888/7777) darf Bernd NICHT erreichen.
    expect(bernd.totalCents).toBe(3000);
    expect(bernd.kmRaw).toBe(0);
  });

  it("€-Konservierung: Σ Breakdown === Pipeline stageTotalCents (keine Doppelzählung)", () => {
    const pipelineUnits: PipelineAtomicUnit[] = sources.map((s) => ({
      assignment: s.assignment,
      cents: s.cents,
    }));
    const pipelineSummary = summarizePipelineCents(pipelineUnits);

    const units = aggregateBreakdownUnits(sources);
    const rowsByKunde = groupBillingBreakdown(units, "kunde");
    const rowsByKasse = groupBillingBreakdown(units, "kasse");
    const totalsKunde = summarizeBreakdownRows(rowsByKunde);
    const totalsKasse = summarizeBreakdownRows(rowsByKasse);

    expect(totalsKunde.totalCents).toBe(pipelineSummary.stageTotalCents);
    // Umschalten der Dimension verändert die Summe nicht.
    expect(totalsKasse.totalCents).toBe(totalsKunde.totalCents);
  });
});

describe("groupBillingBreakdown", () => {
  const units = [
    {
      customerId: 1,
      customerName: "Anna Muster",
      billingType: "selbstzahler",
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      kmRaw: 10.004,
      totalCents: 2000,
    },
    {
      customerId: 2,
      customerName: "Bernd Beispiel",
      billingType: "selbstzahler",
      hauswirtschaftMinutes: 30,
      alltagsbegleitungMinutes: 30,
      kmRaw: 5.006,
      totalCents: 9000,
    },
  ];

  it("gruppiert nach Kunde und sortiert absteigend nach €", () => {
    const rows = groupBillingBreakdown(units, "kunde");
    expect(rows.map((r) => r.key)).toEqual(["cust-2", "cust-1"]);
    expect(rows[0].label).toBe("Bernd Beispiel");
  });

  it("gruppiert nach Kasse und quantisiert km erst am Ende", () => {
    const rows = groupBillingBreakdown(units, "kasse");
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("kasse-selbstzahler");
    // 10.004 + 5.006 = 15.010 → quantisiert auf 2 NK = 15.01
    expect(rows[0].kmQuantized).toBeCloseTo(15.01, 6);
    expect(rows[0].totalCents).toBe(11000);
  });
});
