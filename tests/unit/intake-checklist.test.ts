/**
 * Task #1177 (Phase 3) — Unit-Tests für die Intake-Checklisten-SSoT.
 *
 * Pinnt die Ableitung des Anlage-Fortschritts aus vorhandenen Daten fest:
 * Schritt-Applicability je billingType/Pflegegrad, done/open-Status und die
 * abgeleiteten Aggregate (doneCount/applicableCount/complete/inIntake).
 */
import { describe, it, expect } from "vitest";
import {
  computeIntakeChecklist,
  INTAKE_STEP_ORDER,
  type IntakeStepKey,
  type IntakeStepStatus,
} from "@shared/domain/customers/intake-checklist";

function statusOf(
  input: Parameters<typeof computeIntakeChecklist>[0],
  key: IntakeStepKey,
): IntakeStepStatus {
  const step = computeIntakeChecklist(input).steps.find((s) => s.key === key);
  if (!step) throw new Error(`Schritt ${key} fehlt`);
  return step.status;
}

describe("computeIntakeChecklist", () => {
  it("liefert die Schritte in der kanonischen Reihenfolge", () => {
    const result = computeIntakeChecklist({ billingType: "pflegekasse_gesetzlich" });
    expect(result.steps.map((s) => s.key)).toEqual([...INTAKE_STEP_ORDER]);
  });

  it("frisch minimal angelegter Pflegekasse-Kunde (PG 3): nur personal done, Rest offen", () => {
    const input = {
      billingType: "pflegekasse_gesetzlich" as const,
      pflegegrad: 3,
      hasPersonalData: true,
      budgetSetupMissing: true,
    };
    const result = computeIntakeChecklist(input);
    expect(statusOf(input, "personal")).toBe("done");
    expect(statusOf(input, "insurance")).toBe("open");
    expect(statusOf(input, "contract")).toBe("open");
    expect(statusOf(input, "budgets")).toBe("open");
    expect(result.doneCount).toBe(1);
    expect(result.applicableCount).toBe(6);
    expect(result.complete).toBe(false);
    expect(result.inIntake).toBe(true);
  });

  it("Selbstzahler: Versicherung und Budgets sind not_applicable", () => {
    const input = { billingType: "selbstzahler" as const, hasPersonalData: true };
    expect(statusOf(input, "insurance")).toBe("not_applicable");
    expect(statusOf(input, "budgets")).toBe("not_applicable");
    const result = computeIntakeChecklist(input);
    expect(result.applicableCount).toBe(4); // personal, contract, matching, documents
  });

  it("Pflegekasse PG 1: Budgets not_applicable (Cap-Schwelle PG >= 2)", () => {
    const input = { billingType: "pflegekasse_gesetzlich" as const, pflegegrad: 1, hasPersonalData: true };
    expect(statusOf(input, "budgets")).toBe("not_applicable");
    expect(statusOf(input, "insurance")).toBe("open");
  });

  it("Budget-Schritt: budgetSetupMissing=false ⇒ done, =true ⇒ open (PG 4)", () => {
    const base = { billingType: "pflegekasse_gesetzlich" as const, pflegegrad: 4, hasPersonalData: true };
    expect(statusOf({ ...base, budgetSetupMissing: true }, "budgets")).toBe("open");
    expect(statusOf({ ...base, budgetSetupMissing: false }, "budgets")).toBe("done");
  });

  it("vollständig versorgter Selbstzahler ist complete und nicht mehr in Anlage", () => {
    const result = computeIntakeChecklist({
      billingType: "selbstzahler",
      hasPersonalData: true,
      hasContract: true,
      hasPrimaryEmployee: true,
      hasDocuments: true,
    });
    expect(result.complete).toBe(true);
    expect(result.inIntake).toBe(false);
    expect(result.doneCount).toBe(result.applicableCount);
  });

  it("vollständig versorgter Pflegekasse-Kunde (PG 5) ist complete", () => {
    const result = computeIntakeChecklist({
      billingType: "pflegekasse_privat",
      pflegegrad: 5,
      hasPersonalData: true,
      hasInsurance: true,
      hasContract: true,
      budgetSetupMissing: false,
      hasPrimaryEmployee: true,
      hasDocuments: true,
    });
    expect(result.complete).toBe(true);
    expect(result.inIntake).toBe(false);
    expect(result.applicableCount).toBe(6);
  });

  it("leerer/unbekannter billingType: insurance/budgets not_applicable, kein Crash", () => {
    const result = computeIntakeChecklist({ billingType: "" });
    expect(result.steps.find((s) => s.key === "insurance")?.status).toBe("not_applicable");
    expect(result.steps.find((s) => s.key === "budgets")?.status).toBe("not_applicable");
    expect(result.inIntake).toBe(true);
  });
});
