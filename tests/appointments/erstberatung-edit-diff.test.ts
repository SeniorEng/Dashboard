import { describe, it, expect } from "vitest";
import { computeErstberatungUpdateFields } from "../../client/src/features/appointments/lib/edit-diff";

// Task #595: Reine Notiz-Änderungen auf einer bereits gestarteten Erstberatung
// durften nicht in einem 403 "Zeit und Datum können nur bei geplanten
// Terminen geändert werden" landen, nur weil `scheduledEnd-scheduledStart`
// in der DB von `durationPromised` driftet. Der Diff vergleicht jetzt gegen
// die initialen Mount-Werte, nicht gegen `durationPromised`.
describe("computeErstberatungUpdateFields", () => {
  const base = {
    originalDate: "2026-05-26",
    originalNotes: "alte Notiz",
    originalAssignedEmployeeId: 42,
    initialTime: "09:00",
    initialDuration: 60,
    date: "2026-05-26",
    time: "09:00",
    duration: 60,
    notes: "alte Notiz",
    assignedEmployeeId: "42",
  };

  it("liefert leeres Diff, wenn nichts geändert wurde", () => {
    expect(computeErstberatungUpdateFields(base)).toEqual({});
  });

  it("sendet bei reiner Notiz-Änderung NUR notes — auch wenn initialDuration von der DB driftet", () => {
    // Simuliert das Real-World-Szenario aus Prod: bereits gestartete EB, bei
    // der scheduledEnd-scheduledStart (z.B. 45 min) von durationPromised
    // (z.B. 60 min in der DB) abweicht. initialDuration spiegelt den im UI
    // sichtbaren Wert (45 min aus end-start).
    const result = computeErstberatungUpdateFields({
      ...base,
      initialDuration: 45,
      duration: 45,
      notes: "neue Notiz",
    });
    expect(result).toEqual({ notes: "neue Notiz" });
    expect(result).not.toHaveProperty("durationPromised");
    expect(result).not.toHaveProperty("scheduledEnd");
    expect(result).not.toHaveProperty("scheduledStart");
  });

  it("sendet scheduledStart + scheduledEnd bei aktiver Zeit-Änderung", () => {
    const result = computeErstberatungUpdateFields({
      ...base,
      time: "10:00",
    });
    expect(result.scheduledStart).toBe("10:00");
    expect(result.scheduledEnd).toBe("11:00");
    expect(result).not.toHaveProperty("durationPromised");
  });

  it("sendet durationPromised + scheduledEnd bei aktiver Dauer-Änderung", () => {
    const result = computeErstberatungUpdateFields({
      ...base,
      duration: 90,
    });
    expect(result.durationPromised).toBe(90);
    expect(result.scheduledEnd).toBe("10:30");
    expect(result).not.toHaveProperty("scheduledStart");
  });

  it("sendet date bei Datumsänderung", () => {
    const result = computeErstberatungUpdateFields({
      ...base,
      date: "2026-05-27",
    });
    expect(result).toEqual({ date: "2026-05-27" });
  });

  it("sendet assignedEmployeeId bei Mitarbeiterwechsel", () => {
    const result = computeErstberatungUpdateFields({
      ...base,
      assignedEmployeeId: "7",
    });
    expect(result).toEqual({ assignedEmployeeId: 7 });
  });

  it("ignoriert leeren oder ungültigen assignedEmployeeId-Wert", () => {
    expect(
      computeErstberatungUpdateFields({ ...base, assignedEmployeeId: "" }),
    ).toEqual({});
    expect(
      computeErstberatungUpdateFields({ ...base, assignedEmployeeId: "abc" }),
    ).toEqual({});
  });

  it("setzt notes auf null bei geleertem Notiz-Feld", () => {
    const result = computeErstberatungUpdateFields({
      ...base,
      notes: "",
    });
    expect(result).toEqual({ notes: null });
  });
});
