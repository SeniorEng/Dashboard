import { describe, it, expect } from "vitest";

  // TEMPORARY — Task #786 gate verification. This test is DESIGNED to fail to
  // prove the CI 'tests' gate actually runs vitest and blocks merge on red.
  // Remove this file after the gate is confirmed.
  describe("ci-gate-verification-786", () => {
    it("intentionally fails to prove the test gate is real", () => {
      expect(1).toBe(2);
    });
  });
  