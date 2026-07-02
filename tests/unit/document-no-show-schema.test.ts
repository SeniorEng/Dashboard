/**
 * Task #1575 — Schutz-Test für die origin-gated Fahrzeit-Pflicht in
 * `documentNoShowSchema`.
 *
 * Task #167 hat das No-Show-Schema an `documentAppointmentSchema` angeglichen:
 * kommt der/die MA von einem anderen Termin (`travelOriginType='appointment'`),
 * ist `travelMinutes` Pflicht — sonst würde die origin-gated Leerfahrt-Lohnzeit
 * stillschweigend als 0 berechnet. Diese superRefine-Regel hatte bislang keinen
 * dedizierten Test; ein späteres Schema-Refactoring könnte sie unbemerkt
 * entfernen. Dieser Test verriegelt das Verhalten.
 */
import { describe, it, expect } from "vitest";
import { documentNoShowSchema } from "@shared/schema/appointments";

const baseNoShow = {
  actualStart: "09:00",
  travelKilometers: 12,
  noShowReason: "nicht_angetroffen" as const,
};

describe("Task #1575: documentNoShowSchema Fahrzeit-Pflicht (origin='appointment')", () => {
  it("lehnt origin='appointment' mit fehlender travelMinutes (undefined) ab", () => {
    const result = documentNoShowSchema.safeParse({
      ...baseNoShow,
      travelOriginType: "appointment",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.join(".") === "travelMinutes",
      );
      expect(issue).toBeDefined();
    }
  });

  it("lehnt origin='appointment' mit travelMinutes=null ab", () => {
    const result = documentNoShowSchema.safeParse({
      ...baseNoShow,
      travelOriginType: "appointment",
      travelMinutes: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.join(".") === "travelMinutes",
      );
      expect(issue).toBeDefined();
    }
  });

  it("akzeptiert origin='appointment' mit gesetzter travelMinutes", () => {
    const result = documentNoShowSchema.safeParse({
      ...baseNoShow,
      travelOriginType: "appointment",
      travelMinutes: 20,
    });
    expect(result.success).toBe(true);
  });

  it("akzeptiert origin='home' ohne travelMinutes", () => {
    const result = documentNoShowSchema.safeParse({
      ...baseNoShow,
      travelOriginType: "home",
    });
    expect(result.success).toBe(true);
  });
});
