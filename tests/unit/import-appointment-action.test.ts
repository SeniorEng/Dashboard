import { describe, expect, it } from "vitest";
import {
  actionWhenSelected,
  classifyImportAction,
  determineImportAction,
  type ImportActionInput,
} from "@shared/domain/import-appointment-action";

/**
 * Task #1602 — Absicherung, dass bereits abgerechnete Bestandstermine
 * (`billedProtected`) auf KEINEM UI-Kontrollpfad zu einer Mutation gesetzt
 * werden können. Diese reine Klassifikations-Logik ist die Single-Source, die
 * die Import-Oberfläche für BEIDE Kontrollpfade nutzt:
 *   - `determineImportAction`  → Default-Aktion + Alle-auswählen-Massenaktion
 *   - `actionWhenSelected`     → Einzel-Checkbox-Aktivierung
 * Zusammen mit dem im UI deaktivierten Aktions-Dropdown (nur `skip` sichtbar)
 * und dem Server-trusted Snapshot im Execute-Endpoint ist damit jeder Pfad
 * abgedeckt, über den ein Nutzer `update`/`upgrade` auslösen könnte.
 */

const STATUSES: ImportActionInput["status"][] = [
  "new",
  "duplicate",
  "upgrade",
  "beyond_cutoff",
  "error",
];

describe("Task #1602: abgerechnete Termine bleiben unmutierbar", () => {
  it("classifyImportAction: billedProtected ⇒ IMMER noop (jeder Status, mit/ohne Diff)", () => {
    for (const status of STATUSES) {
      for (const hasDiff of [true, false]) {
        expect(
          classifyImportAction({ status, hasDiff, billedProtected: true }),
        ).toBe("noop");
      }
    }
  });

  it("determineImportAction: billedProtected ⇒ IMMER skip (Default- + Massenaktion)", () => {
    for (const status of STATUSES) {
      for (const hasDiff of [true, false]) {
        expect(
          determineImportAction({ status, hasDiff, billedProtected: true }),
        ).toBe("skip");
      }
    }
  });

  it("actionWhenSelected: billedProtected ⇒ IMMER skip (auch bei duplicate/upgrade, wo es sonst update/upgrade wäre)", () => {
    for (const status of STATUSES) {
      expect(actionWhenSelected(status, true)).toBe("skip");
    }
    // Gegenprobe: ohne Schutz würde genau hier update/upgrade entstehen.
    expect(actionWhenSelected("duplicate", false)).toBe("update");
    expect(actionWhenSelected("upgrade", false)).toBe("upgrade");
  });

  it("Regression: ohne billedProtected bleibt das bisherige Verhalten erhalten", () => {
    expect(classifyImportAction({ status: "new", hasDiff: false })).toBe("create");
    expect(classifyImportAction({ status: "duplicate", hasDiff: true })).toBe("update");
    expect(classifyImportAction({ status: "duplicate", hasDiff: false })).toBe("noop");
    expect(classifyImportAction({ status: "upgrade", hasDiff: false })).toBe("update");

    expect(determineImportAction({ status: "new", hasDiff: false })).toBe("import");
    expect(determineImportAction({ status: "duplicate", hasDiff: true })).toBe("update");
    expect(determineImportAction({ status: "upgrade", hasDiff: false })).toBe("upgrade");
    expect(determineImportAction({ status: "duplicate", hasDiff: false })).toBe("skip");
  });
});
