// @ts-nocheck
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  countSignatureInkPixels,
  MIN_SIGNATURE_INK_PIXELS,
} from "../client/src/components/ui/signature-pad";

/**
 * Task #752 — Diese Tests bauen das Canvas-2D-Context-API selbst nach,
 * weil jsdom keinen echten 2D-Renderer mitliefert. Die zu testende
 * Funktion `countSignatureInkPixels` braucht aber nur `getContext("2d")`
 * + `getImageData(...).data`, also reicht ein minimaler Stub.
 */
function makeFakeCanvas(
  width: number,
  height: number,
  fillAlphaPixels: number,
): HTMLCanvasElement {
  const totalPixels = width * height;
  const data = new Uint8ClampedArray(totalPixels * 4);
  for (let p = 0; p < Math.min(fillAlphaPixels, totalPixels); p++) {
    data[p * 4 + 3] = 255;
  }
  const canvas = {
    width,
    height,
    getContext: (kind: string) => {
      if (kind !== "2d") return null;
      return {
        getImageData: () => ({ data, width, height }),
      };
    },
  } as unknown as HTMLCanvasElement;
  return canvas;
}

describe("countSignatureInkPixels — Frontend-Heuristik leeres Unterschriftsfeld (Task #752)", () => {
  it("returns 0 for a completely empty (fully transparent) canvas", () => {
    expect(countSignatureInkPixels(makeFakeCanvas(300, 200, 0))).toBe(0);
  });

  it("returns 0 for null/undefined input (guards against missing ref)", () => {
    expect(countSignatureInkPixels(null)).toBe(0);
    expect(countSignatureInkPixels(undefined)).toBe(0);
  });

  it("returns 0 when getContext returns null (no 2D support / detached canvas)", () => {
    const canvas = { width: 10, height: 10, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(countSignatureInkPixels(canvas)).toBe(0);
  });

  it("counts every pixel with alpha > 0 as ink", () => {
    expect(countSignatureInkPixels(makeFakeCanvas(20, 20, 400))).toBe(400);
  });

  it("flags a canvas with fewer than MIN_SIGNATURE_INK_PIXELS painted pixels as empty (matches server EMPTY_SIGNATURE)", () => {
    const ink = countSignatureInkPixels(makeFakeCanvas(300, 200, MIN_SIGNATURE_INK_PIXELS - 1));
    expect(ink).toBeLessThan(MIN_SIGNATURE_INK_PIXELS);
  });

  it("accepts a real-sized scribble as having enough ink", () => {
    const ink = countSignatureInkPixels(makeFakeCanvas(300, 200, MIN_SIGNATURE_INK_PIXELS + 10));
    expect(ink).toBeGreaterThanOrEqual(MIN_SIGNATURE_INK_PIXELS);
  });
});
