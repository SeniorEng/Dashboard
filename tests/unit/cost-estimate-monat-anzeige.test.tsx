// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CostEstimatePreview, type CostEstimate } from "@/features/appointments/components/cost-estimate-preview";

/**
 * Replit #1916 — der neue Ausgang muss auf den SCHIRM kommen, und zwar mit der
 * RICHTIGEN Zahl im Kopf.
 *
 * ── Warum dieser Test neben dem SSoT-Test steht ────────────────────────
 * Im §45b-Vorgang ist genau das zweimal schiefgegangen: der Server lieferte
 * korrekt, und der Client zeigte es nicht (bzw. zeigte eine falsche
 * Begründung). Beide Male war der Test eine Schicht zu tief angesetzt.
 *
 * Prüffrage aus der Nachbereitung: *auf welcher Schicht steht die Behauptung,
 * die der Test belegen soll — und misst er dort oder eine darunter?* Die
 * Behauptung „der Bediener sieht, dass er den Termin anlegen kann" steht auf
 * der Anzeige. Also wird hier gerendert.
 */

const BASIS: CostEstimate = {
  totalCents: 100_00,
  warning: null,
  availableCents: 47_00,
  isHardBlock: false,
};

afterEach(() => cleanup());

describe("Kostenschätzung-Anzeige — „reicht erst im Monat“", () => {
  it("MA-1 – der Kopf nennt die MONATS-Zahl, nicht die heutige", () => {
    render(
      <CostEstimatePreview
        billingType="pflegekasse_gesetzlich"
        costEstimate={{
          ...BASIS,
          kind: "erst_im_monat_gedeckt",
          projectedAvailableCents: 178_00,
          warning: "Im Termin-Monat reicht das Budget … Monat des Termins.",
        }}
      />,
    );
    const kasten = screen.getByTestId("budget-warning-monat");
    expect(kasten.textContent).toContain("im Termin-Monat verfügbar: 178,00");
    // Die heutige Zahl darf NICHT als „verfügbar" im Kopf stehen — sonst
    // stünden zwei verschiedene „verfügbar" in einem Kasten, und der Bediener
    // müsste raten, welche gilt.
    expect(kasten.textContent).not.toContain("— verfügbar: 47,00");
  });

  it("MA-2 – kein harter Block: der Kasten ist die Warnung, nicht die Sperre", () => {
    render(
      <CostEstimatePreview
        billingType="pflegekasse_gesetzlich"
        costEstimate={{
          ...BASIS,
          kind: "erst_im_monat_gedeckt",
          projectedAvailableCents: 178_00,
          warning: "Im Termin-Monat reicht das Budget.",
        }}
      />,
    );
    expect(screen.queryByTestId("budget-hard-block"), "der Termin wird weiterhin gesperrt").toBeNull();
    expect(screen.getByTestId("budget-warning-monat")).toBeTruthy();
  });

  it("MA-3 – der bestehende Privatzahler-Fall bleibt unverändert", () => {
    // Gegenprobe: die beiden nicht-blockierenden Fälle dürfen nicht
    // verschmelzen. Vorher waren sie für den Client ununterscheidbar.
    render(
      <CostEstimatePreview
        billingType="pflegekasse_gesetzlich"
        costEstimate={{
          ...BASIS,
          kind: "soft_private",
          warning: "Budget reicht nicht — 53,00 € werden privat berechnet.",
        }}
      />,
    );
    const kasten = screen.getByTestId("budget-warning");
    expect(kasten.textContent).toContain("verfügbar: 47,00");
    expect(screen.queryByTestId("budget-warning-monat")).toBeNull();
  });

  it("MA-4 – der harte Block bleibt rot und gesperrt", () => {
    render(
      <CostEstimatePreview
        billingType="pflegekasse_gesetzlich"
        costEstimate={{ ...BASIS, kind: "hard_block", isHardBlock: true, warning: "Budget reicht nicht — es fehlen 122,00 €." }}
      />,
    );
    expect(screen.getByTestId("budget-hard-block")).toBeTruthy();
  });
});
