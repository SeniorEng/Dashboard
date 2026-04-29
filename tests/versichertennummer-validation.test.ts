import { describe, it, expect } from "vitest";
import {
  validateVersichertennummerFor,
  versichertennummerFlexSchema,
  versichertennummerSchema,
} from "../shared/schema/common";

describe("Versichertennummer-Validierung", () => {
  describe("Privatpatient (Flex-Format)", () => {
    const opts = { billingType: "pflegekasse_privat" as const };

    it("akzeptiert Debeka-Format mit Punkt (z.B. 6163938.1)", () => {
      const result = validateVersichertennummerFor("6163938.1", opts);
      expect(result.ok).toBe(true);
      expect(versichertennummerFlexSchema.safeParse("6163938.1").success).toBe(true);
    });

    it("akzeptiert reine Ziffern", () => {
      expect(validateVersichertennummerFor("123456789", opts).ok).toBe(true);
    });

    it("akzeptiert Bindestriche und Schrägstriche", () => {
      expect(validateVersichertennummerFor("AB-12/345", opts).ok).toBe(true);
    });

    it("lehnt Sonderzeichen ab (z.B. Leerzeichen)", () => {
      const result = validateVersichertennummerFor("616 39 38.1", opts);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(/Buchstaben.*Ziffern.*Punkte/);
      }
    });

    it("lehnt zu kurze Eingabe ab", () => {
      expect(versichertennummerFlexSchema.safeParse("AB").success).toBe(false);
    });

    it("lehnt zu lange Eingabe ab", () => {
      expect(versichertennummerFlexSchema.safeParse("A".repeat(21)).success).toBe(false);
    });
  });

  describe("Gesetzlich versichert (GKV-Format)", () => {
    const opts = { billingType: "pflegekasse" as const };

    it("akzeptiert Standard-GKV-Format", () => {
      expect(validateVersichertennummerFor("A123456789", opts).ok).toBe(true);
    });

    it("lehnt Punkt-Format bei GKV ab", () => {
      const result = validateVersichertennummerFor("6163938.1", opts);
      expect(result.ok).toBe(false);
    });

    it("verlangt führenden Großbuchstaben", () => {
      expect(versichertennummerSchema.safeParse("a123456789").success).toBe(false);
    });
  });

  describe("Privater Anbieter via isPrivateProvider-Flag", () => {
    it("schaltet auch ohne pflegekasse_privat-billingType auf Flex um", () => {
      expect(
        validateVersichertennummerFor("6163938.1", { isPrivateProvider: true }).ok,
      ).toBe(true);
    });
  });
});
