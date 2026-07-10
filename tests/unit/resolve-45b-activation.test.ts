import { describe, it, expect } from "vitest";
import { resolve45bActivation } from "@shared/domain/budgets";

// BUG-19 (Facette A) — SSoT „ist der §45b-Entlastungsbetrag zum Stichtag aktiv?".
//
// Kern-Regression: eine VORHANDENE, aber DEAKTIVIERTE §45b-Zeile
// (`enabled=false`) darf NICHT wie eine FEHLENDE Zeile behandelt werden. Früher
// suchte der Code die Zeile mit `&& s.enabled` → eine deaktivierte Zeile sah aus
// wie „keine Zeile" → griff die Default-Aktivierung → ein bewusst abgeschalteter
// §45b-Topf (0 €) erschien als aktiv und löste die falsche „Budget
// überschritten"-Warnung aus (Prod-Kunde „Seidel, Wolfgang").
describe("resolve45bActivation — §45b-Aktivität (BUG-19 Facette A)", () => {
  it("persistierte DEAKTIVIERTE Zeile (Pflegekasse) ⇒ inaktiv (der Prod-Bug)", () => {
    const r = resolve45bActivation({
      setting: { enabled: false, validFrom: "2026-01-01", validTo: null },
      billingType: "pflegekasse_gesetzlich",
      asOfDate: "2026-07-10",
    });
    expect(r.enabled).toBe(false);
    expect(r.active).toBe(false);
  });

  it("fehlende Zeile + anspruchsberechtigt (Pflegekasse) ⇒ Default aktiv", () => {
    const r = resolve45bActivation({
      setting: undefined,
      billingType: "pflegekasse_gesetzlich",
      asOfDate: "2026-07-10",
    });
    expect(r.enabled).toBe(true);
    expect(r.inRange).toBe(true);
    expect(r.active).toBe(true);
  });

  it("fehlende Zeile + Selbstzahler ⇒ Default inaktiv (kein Anspruch)", () => {
    const r = resolve45bActivation({
      setting: undefined,
      billingType: "selbstzahler",
      asOfDate: "2026-07-10",
    });
    expect(r.enabled).toBe(false);
    expect(r.active).toBe(false);
  });

  it("persistierte AKTIVE Zeile im Fenster ⇒ aktiv", () => {
    const r = resolve45bActivation({
      setting: { enabled: true, validFrom: "2026-01-01", validTo: null },
      billingType: "pflegekasse_gesetzlich",
      asOfDate: "2026-07-10",
    });
    expect(r.enabled).toBe(true);
    expect(r.inRange).toBe(true);
    expect(r.active).toBe(true);
  });

  it("persistierte AKTIVE Zeile, Stichtag VOR validFrom ⇒ inaktiv (out of range)", () => {
    const r = resolve45bActivation({
      setting: { enabled: true, validFrom: "2026-08-01", validTo: null },
      billingType: "pflegekasse_gesetzlich",
      asOfDate: "2026-07-10",
    });
    expect(r.enabled).toBe(true);
    expect(r.inRange).toBe(false);
    expect(r.active).toBe(false);
  });

  it("persistierte AKTIVE Zeile, Stichtag NACH validTo ⇒ inaktiv (out of range)", () => {
    const r = resolve45bActivation({
      setting: { enabled: true, validFrom: "2026-01-01", validTo: "2026-06-30" },
      billingType: "pflegekasse_gesetzlich",
      asOfDate: "2026-07-10",
    });
    expect(r.enabled).toBe(true);
    expect(r.inRange).toBe(false);
    expect(r.active).toBe(false);
  });

  it("DEAKTIVIERTE Zeile schlägt die Default-Aktivierung (kein Silent-Fallback)", () => {
    // Auch wenn der billingType-Default aktiv wäre, gewinnt die explizite
    // enabled=false-Zeile — genau das war der Bug.
    const r = resolve45bActivation({
      setting: { enabled: false, validFrom: null, validTo: null },
      billingType: "pflegekasse_gesetzlich",
      asOfDate: "2026-07-10",
    });
    expect(r.inRange).toBe(true);
    expect(r.active).toBe(false);
  });
});
