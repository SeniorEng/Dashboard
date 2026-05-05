import { describe, it, expect } from "vitest";
import { computeSollIst } from "../server/lib/team-workload";

describe("computeSollIst", () => {
  const baseRow = {
    avgMonthlyHwMinutes: 0,
    avgMonthlyAllMinutes: 0,
    monthsConsidered: 3,
    monthlyWorkHours: 100 as number | null,
  };

  it("liefert null-Kennzahlen wenn monthlyWorkHours fehlt (UI zeigt Hinweis)", () => {
    const r = computeSollIst({ ...baseRow, monthlyWorkHours: null }, 5);
    expect(r.auslastungPct).toBeNull();
    expect(r.freieStunden).toBeNull();
    expect(r.moeglicheZusatzKunden).toBeNull();
    expect(r.istHours).toBe(0);
  });

  it("liefert null-Kennzahlen wenn monthlyWorkHours = 0", () => {
    const r = computeSollIst({ ...baseRow, monthlyWorkHours: 0 }, 5);
    expect(r.auslastungPct).toBeNull();
    expect(r.freieStunden).toBeNull();
    expect(r.moeglicheZusatzKunden).toBeNull();
  });

  it("rechnet Auslastung % korrekt: 60h Ist bei 100h Soll = 60%", () => {
    const r = computeSollIst(
      { ...baseRow, avgMonthlyHwMinutes: 60 * 40, avgMonthlyAllMinutes: 60 * 20, monthlyWorkHours: 100 },
      5,
    );
    expect(r.istHours).toBe(60);
    expect(r.auslastungPct).toBe(60);
    expect(r.freieStunden).toBe(40);
    expect(r.moeglicheZusatzKunden).toBe(8); // floor(40 / 5)
  });

  it("kappt freie Stunden auf 0 und Zusatzkunden auf 0 bei Überlastung (Ist > Soll)", () => {
    const r = computeSollIst(
      { ...baseRow, avgMonthlyHwMinutes: 60 * 80, avgMonthlyAllMinutes: 60 * 50, monthlyWorkHours: 100 },
      5,
    );
    expect(r.istHours).toBe(130);
    expect(r.auslastungPct).toBe(130);
    expect(r.freieStunden).toBe(0);
    expect(r.moeglicheZusatzKunden).toBe(0);
  });

  it("liefert Zusatzkunden = null wenn globaler Ø-Wert 0 ist (keine Datenbasis)", () => {
    const r = computeSollIst(
      { ...baseRow, avgMonthlyHwMinutes: 60 * 40, avgMonthlyAllMinutes: 0, monthlyWorkHours: 100 },
      0,
    );
    expect(r.freieStunden).toBe(60);
    expect(r.moeglicheZusatzKunden).toBeNull();
  });

  it("monthsConsidered = 0 (komplett im Urlaub) → Auslastung null, freie Stunden = Soll", () => {
    const r = computeSollIst(
      { ...baseRow, monthsConsidered: 0, monthlyWorkHours: 100 },
      5,
    );
    expect(r.istHours).toBe(0);
    expect(r.auslastungPct).toBeNull();
    expect(r.freieStunden).toBe(100);
    expect(r.moeglicheZusatzKunden).toBeNull();
  });

  it("Minijobber (35h) und SV-pflichtige (160h) werden identisch behandelt — nur Soll unterscheidet sich", () => {
    const ist = { avgMonthlyHwMinutes: 60 * 20, avgMonthlyAllMinutes: 60 * 5, monthsConsidered: 3 };
    const minijob = computeSollIst({ ...ist, monthlyWorkHours: 35 }, 5);
    const svPflicht = computeSollIst({ ...ist, monthlyWorkHours: 160 }, 5);

    // Beide werden mit derselben Formel gerechnet, nur das Soll unterscheidet sich.
    expect(minijob.istHours).toBe(svPflicht.istHours);
    expect(minijob.istHours).toBe(25);
    expect(minijob.freieStunden).toBe(10);
    expect(svPflicht.freieStunden).toBe(135);
    expect(minijob.moeglicheZusatzKunden).toBe(2);
    expect(svPflicht.moeglicheZusatzKunden).toBe(27);
  });

  it("rundet mögliche Zusatzkunden ab (floor), nie hoch", () => {
    const r = computeSollIst(
      { avgMonthlyHwMinutes: 0, avgMonthlyAllMinutes: 0, monthsConsidered: 3, monthlyWorkHours: 14 },
      5,
    );
    // 14h frei / 5h pro Kunde = 2.8 → 2 Kunden
    expect(r.moeglicheZusatzKunden).toBe(2);
  });
});
