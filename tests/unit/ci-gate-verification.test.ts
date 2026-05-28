import { describe, it, expect } from "vitest";

// TEMPORARY: verifies the GitHub Actions required checks actually run and block
// merges. This test deliberately fails. Remove together with this branch.
describe("CI gate verification (temporary)", () => {
  it("deliberately fails to prove the required check blocks merges", () => {
    expect(1).toBe(2);
  });
});
