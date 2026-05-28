/**
 * Task #708 — Sicherstellt, dass die zentrale Excel-„Art" → Service-Kategorie
 * Mapping-Funktion alle Schreibweisen aus realen Excel-Dateien abdeckt.
 * Driftet eine Importroute zur Direkt-Stringvergleichs-Logik zurück, bricht
 * dieser Test sofort.
 */
import { describe, it, expect } from "vitest";
import {
  excelServiceArtToCategory,
  isHauswirtschaftArt,
  isAlltagsbegleitungArt,
} from "@shared/domain/excel-service-art";

describe("excelServiceArtToCategory", () => {
  it("erkennt 'Hauswirtschaft' und Synonyme als hauswirtschaft", () => {
    expect(excelServiceArtToCategory("Hauswirtschaft")).toBe("hauswirtschaft");
    expect(excelServiceArtToCategory("hauswirtschaft")).toBe("hauswirtschaft");
    expect(excelServiceArtToCategory("HAUSWIRTSCHAFT")).toBe("hauswirtschaft");
    expect(excelServiceArtToCategory(" HW ")).toBe("hauswirtschaft");
    expect(excelServiceArtToCategory("hw")).toBe("hauswirtschaft");
  });

  it("erkennt 'Alltagsbegleitung' und Synonyme als alltagsbegleitung", () => {
    expect(excelServiceArtToCategory("Alltagsbegleitung")).toBe("alltagsbegleitung");
    expect(excelServiceArtToCategory("alltagsbegleitung")).toBe("alltagsbegleitung");
    expect(excelServiceArtToCategory("AB")).toBe("alltagsbegleitung");
    expect(excelServiceArtToCategory(" ab ")).toBe("alltagsbegleitung");
  });

  it("liefert null für unbekannte / leere Werte", () => {
    expect(excelServiceArtToCategory(null)).toBeNull();
    expect(excelServiceArtToCategory(undefined)).toBeNull();
    expect(excelServiceArtToCategory("")).toBeNull();
    expect(excelServiceArtToCategory("Pflege")).toBeNull();
  });

  it("isHauswirtschaftArt / isAlltagsbegleitungArt sind komplementär für bekannte Werte", () => {
    for (const v of ["Hauswirtschaft", "hw", "HW"]) {
      expect(isHauswirtschaftArt(v)).toBe(true);
      expect(isAlltagsbegleitungArt(v)).toBe(false);
    }
    for (const v of ["Alltagsbegleitung", "ab", "AB"]) {
      expect(isHauswirtschaftArt(v)).toBe(false);
      expect(isAlltagsbegleitungArt(v)).toBe(true);
    }
    expect(isHauswirtschaftArt("xyz")).toBe(false);
    expect(isAlltagsbegleitungArt("xyz")).toBe(false);
  });
});
