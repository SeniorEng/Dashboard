/**
 * Task #819 — Single Source of Truth für das Parsen deutscher Dezimalzahlen
 * aus Excel-/CSV-Importen.
 *
 * Hintergrund: Der Altdaten-Import (`server/services/appointment-import.ts`)
 * hat Stunden und Kilometer mit `Number(cell) || 0` geparst. `Number("10,9")`
 * ergibt `NaN` (→ `0`), weil das deutsche Dezimal-Komma kein gültiger
 * JS-Number-Separator ist. Dadurch wurden bei jeder Datei, in der ExcelJS die
 * Zelle als Text (statt als echten Number-Wert) liefert, ALLE Nachkommastellen
 * still auf 0 gerundet — ein GoBD-Verstoß (stille Datenverfälschung beim
 * Import).
 *
 * Dieser Helper MUSS für ALLE Dezimal-Spalten (km + Stunden) im Import-Pfad
 * verwendet werden. Die Fitness-Function
 * `tests/architecture/no-bare-number-in-import.test.ts` verbietet neue
 * `Number(...)`-Konvertierungen von Zellwerten in
 * `server/services/appointment-import.ts`.
 *
 * Unterstützte Eingaben:
 *   - echte JS-`number` (ExcelJS hat die Zelle als Zahl geliefert) → direkt
 *   - deutsches Format mit Dezimal-Komma:        "10,9"      → 10.9
 *   - deutsches Format mit Tausenderpunkt:       "1.234,5"   → 1234.5
 *   - englisches Format mit Dezimal-Punkt:       "10.9"      → 10.9
 *   - englisches Format mit Tausenderkomma:      "1,234.5"   → 1234.5
 *   - mit Einheiten/Whitespace:                  " 12,5 km " → 12.5
 *   - leer / null / undefined / nicht parsebar   → 0
 */

/**
 * Parst einen Zellwert in eine `number`. Deutsches Dezimal-Komma wird korrekt
 * berücksichtigt. Nicht parsebare oder leere Werte ergeben `0`.
 */
export function parseGermanDecimal(value: unknown): number {
  if (value == null) return 0;

  // ExcelJS hat die Zelle bereits als echte Zahl geliefert — kein
  // String-Parsing nötig (und kein Verlust durch Locale-Heuristik).
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value !== "string") {
    // Booleans, Objekte etc. sind keine sinnvollen Dezimalwerte.
    return 0;
  }

  // Nur Ziffern, Separatoren und Vorzeichen behalten (entfernt z. B. "km",
  // "Std", non-breaking spaces, Tausenderpunkte werden unten aufgelöst).
  let s = value.trim();
  if (s === "") return 0;

  // Vorzeichen extrahieren und vom Rest trennen.
  let sign = 1;
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  // Alles außer Ziffern, Punkt und Komma verwerfen (Einheiten, Whitespace).
  s = s.replace(/[^0-9.,]/g, "");
  if (s === "") return 0;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Beide Separatoren vorhanden — der zuletzt auftretende ist der
    // Dezimaltrenner, der andere ist Tausendertrenner.
    if (lastComma > lastDot) {
      // Deutsches Format "1.234,5" → Punkte raus, Komma → Punkt.
      normalized = s.replace(/\./g, "").replace(",", ".");
    } else {
      // Englisches Format "1,234.5" → Kommas raus.
      normalized = s.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    // Nur Komma(s). Mehrere Kommas = Tausendertrenner (z. B. "1,234,567"),
    // dann gibt es keinen Dezimalteil. Genau eines = Dezimal-Komma.
    const commaCount = (s.match(/,/g) ?? []).length;
    normalized = commaCount > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot >= 0) {
    // Nur Punkt(e). Mehrere Punkte = Tausendertrenner (z. B. "1.234.567"),
    // dann gibt es keinen Dezimalteil. Genau einer = Dezimal-Punkt.
    const dotCount = (s.match(/\./g) ?? []).length;
    normalized = dotCount > 1 ? s.replace(/\./g, "") : s;
  } else {
    normalized = s;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return sign * parsed;
}
