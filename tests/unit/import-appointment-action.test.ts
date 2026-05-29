import { describe, it, expect } from "vitest";
import {
  classifyImportAction,
  determineImportAction,
  actionWhenSelected,
} from "@shared/domain/import-appointment-action";

describe("classifyImportAction", () => {
  it("classifies a brand-new row as create", () => {
    expect(classifyImportAction({ status: "new", hasDiff: false })).toBe("create");
  });

  it("classifies a duplicate with a field diff as update", () => {
    expect(classifyImportAction({ status: "duplicate", hasDiff: true })).toBe("update");
  });

  it("classifies an identical duplicate as noop", () => {
    expect(classifyImportAction({ status: "duplicate", hasDiff: false })).toBe("noop");
  });

  it("classifies an upgradable planned appointment as update (regardless of diff)", () => {
    expect(classifyImportAction({ status: "upgrade", hasDiff: false })).toBe("update");
    expect(classifyImportAction({ status: "upgrade", hasDiff: true })).toBe("update");
  });

  it("classifies cutoff-protected and error rows as noop", () => {
    expect(classifyImportAction({ status: "beyond_cutoff", hasDiff: false })).toBe("noop");
    expect(classifyImportAction({ status: "error", hasDiff: false })).toBe("noop");
  });
});

describe("determineImportAction", () => {
  it("maps create → import", () => {
    expect(determineImportAction({ status: "new", hasDiff: false })).toBe("import");
  });

  it("maps an identical duplicate (noop) → skip", () => {
    expect(determineImportAction({ status: "duplicate", hasDiff: false })).toBe("skip");
  });

  it("maps a changed duplicate → update", () => {
    expect(determineImportAction({ status: "duplicate", hasDiff: true })).toBe("update");
  });

  it("maps an upgradable row → upgrade", () => {
    expect(determineImportAction({ status: "upgrade", hasDiff: false })).toBe("upgrade");
  });

  it("maps cutoff/error rows → skip", () => {
    expect(determineImportAction({ status: "beyond_cutoff", hasDiff: false })).toBe("skip");
    expect(determineImportAction({ status: "error", hasDiff: false })).toBe("skip");
  });
});

describe("actionWhenSelected", () => {
  it("returns upgrade for upgrade rows, update for duplicates, import otherwise", () => {
    expect(actionWhenSelected("upgrade")).toBe("upgrade");
    expect(actionWhenSelected("duplicate")).toBe("update");
    expect(actionWhenSelected("new")).toBe("import");
  });
});
