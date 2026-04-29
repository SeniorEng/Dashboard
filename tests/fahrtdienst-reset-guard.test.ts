import { describe, it, expect } from "vitest";
import { shouldResetFahrtdienst } from "@/features/appointments/utils";

/**
 * Diese Tests sichern die Race-Condition-Schutzlogik des
 * Fahrtdienst-Reset-Effekts ab. Der Reset darf NIEMALS feuern, solange der
 * Servicekatalog (`/api/services`) noch nicht geladen ist – sonst würde ein
 * gespeicherter Fahrtdienst-Block beim Bearbeiten eines Termins verloren
 * gehen, wenn `/api/services` etwas später als die Termin-Services antwortet.
 *
 * Hintergrund: `hasAlltagsbegleitung` wird aus `services` × `catalogServices`
 * berechnet. Solange der Katalog leer ist, ist `hasAlltagsbegleitung = false`
 * – auch wenn der Termin in Wahrheit eine Alltagsbegleitung enthält. Würde
 * der Reset in diesem Fenster greifen, wäre der Fahrtdienst weg.
 */
describe("shouldResetFahrtdienst – Race-Condition-Schutz", () => {
  describe("Edit-Flow (fahrtdienstInitialized erforderlich)", () => {
    it("setzt NICHT zurück, solange der Servicekatalog noch lädt – auch wenn hasAlltagsbegleitung kurzzeitig false ist", () => {
      // Simuliert das ungünstige Lade-Timing:
      // - Termin + Services geladen → fahrtdienstInitialized = true
      // - Fahrtdienst aus Termin übernommen → fahrtdienstEnabled = true
      // - /api/services hängt noch → catalogLoaded = false, also
      //   hasAlltagsbegleitung = false (kann nicht aufgelöst werden)
      const result = shouldResetFahrtdienst({
        catalogLoaded: false,
        fahrtdienstInitialized: true,
        hasAlltagsbegleitung: false,
        fahrtdienstEnabled: true,
      });
      expect(result).toBe(false);
    });

    it("setzt NICHT zurück, bevor der Fahrtdienst aus dem Termin initialisiert wurde", () => {
      const result = shouldResetFahrtdienst({
        catalogLoaded: true,
        fahrtdienstInitialized: false,
        hasAlltagsbegleitung: false,
        fahrtdienstEnabled: false,
      });
      expect(result).toBe(false);
    });

    it("setzt zurück, wenn Katalog geladen UND Fahrtdienst initialisiert UND Alltagsbegleitung tatsächlich entfernt wurde", () => {
      // User hat den Alltagsbegleitung-Service entfernt → Reset ist gewollt.
      const result = shouldResetFahrtdienst({
        catalogLoaded: true,
        fahrtdienstInitialized: true,
        hasAlltagsbegleitung: false,
        fahrtdienstEnabled: true,
      });
      expect(result).toBe(true);
    });

    it("setzt nicht zurück, wenn Alltagsbegleitung weiterhin gewählt ist", () => {
      const result = shouldResetFahrtdienst({
        catalogLoaded: true,
        fahrtdienstInitialized: true,
        hasAlltagsbegleitung: true,
        fahrtdienstEnabled: true,
      });
      expect(result).toBe(false);
    });

    it("setzt nicht zurück, wenn Fahrtdienst gar nicht aktiviert ist", () => {
      const result = shouldResetFahrtdienst({
        catalogLoaded: true,
        fahrtdienstInitialized: true,
        hasAlltagsbegleitung: false,
        fahrtdienstEnabled: false,
      });
      expect(result).toBe(false);
    });
  });

  describe("New-Flow (fahrtdienstInitialized hat Default true)", () => {
    it("setzt NICHT zurück, solange der Servicekatalog noch lädt", () => {
      // Im New-Flow wird der Katalog beim ersten Render auch noch geladen.
      // Hätte der User per URL-Param o. ä. bereits Fahrtdienst aktiv, würde
      // ein vorzeitiger Reset diesen ebenfalls aushebeln.
      const result = shouldResetFahrtdienst({
        catalogLoaded: false,
        hasAlltagsbegleitung: false,
        fahrtdienstEnabled: true,
      });
      expect(result).toBe(false);
    });

    it("setzt zurück, sobald Katalog geladen ist und Alltagsbegleitung fehlt", () => {
      const result = shouldResetFahrtdienst({
        catalogLoaded: true,
        hasAlltagsbegleitung: false,
        fahrtdienstEnabled: true,
      });
      expect(result).toBe(true);
    });

    it("verhält sich neutral, wenn Fahrtdienst nie aktiviert war", () => {
      const result = shouldResetFahrtdienst({
        catalogLoaded: true,
        hasAlltagsbegleitung: false,
        fahrtdienstEnabled: false,
      });
      expect(result).toBe(false);
    });
  });

  describe("Realistische Lade-Sequenz im Edit-Flow", () => {
    it("durchläuft Schritt für Schritt das verzögerte /api/services-Szenario, ohne den Fahrtdienst zu verlieren", () => {
      // Schritt 1: Termin lädt, Termin-Services lädt, Fahrtdienst wird aus
      // dem Termin initialisiert. /api/services hängt noch.
      const step1 = shouldResetFahrtdienst({
        catalogLoaded: false,
        fahrtdienstInitialized: true,
        hasAlltagsbegleitung: false, // catalogServices leer → false
        fahrtdienstEnabled: true,
      });
      expect(step1, "Schritt 1: Reset darf während Katalog-Lücke nicht greifen").toBe(false);

      // Schritt 2: /api/services trifft ein, hasAlltagsbegleitung wird true.
      const step2 = shouldResetFahrtdienst({
        catalogLoaded: true,
        fahrtdienstInitialized: true,
        hasAlltagsbegleitung: true,
        fahrtdienstEnabled: true,
      });
      expect(step2, "Schritt 2: Reset darf nicht greifen, Alltagsbegleitung ist da").toBe(false);

      // Schritt 3: User entfernt jetzt aktiv die Alltagsbegleitung – jetzt
      // soll der Reset wirken.
      const step3 = shouldResetFahrtdienst({
        catalogLoaded: true,
        fahrtdienstInitialized: true,
        hasAlltagsbegleitung: false,
        fahrtdienstEnabled: true,
      });
      expect(step3, "Schritt 3: Reset soll greifen, wenn User AB entfernt").toBe(true);
    });
  });
});
