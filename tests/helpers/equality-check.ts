/**
 * Task #427 — Drift-Detektor-Harness "Anzeige == Buchung".
 *
 * Wiederverwendbarer Helper, der für eine Liste von Szenarien zwei echte
 * Code-Pfade ausführt:
 *   - `read(ctx)`  — die "Anzeige"-Seite (z.B. ein GET-Endpoint, eine
 *     Summary-Funktion, ein Banner).
 *   - `write(ctx)` — die "Buchungs"-Seite (z.B. eine Mutation,
 *     `createCascadeConsumption`, ein POST-Endpoint).
 *
 * Anschließend extrahiert der Helper aus beiden Ergebnissen die für die
 * Konsistenz relevante Kennzahl (`extractDisplayed` / `extractBooked`) und
 * prüft, dass sie identisch ist. Bei Abweichung wird ein lesbarer Diff
 * ausgegeben.
 *
 * Wichtig: Die Harness mockt nichts. Beide Pfade müssen die echte
 * Berechnungslogik ausführen — sonst entkoppelt sich der Test von dem Bug,
 * den er fangen soll (siehe Task #423).
 */
import { expect } from "vitest";

export interface EqualityScenario<Ctx, Read, Write, Value> {
  /** Menschlich lesbarer Name (taucht in der Fehlermeldung auf). */
  name: string;
  /** Setzt den Test-Kontext auf (z.B. legt einen Kunden mit Budgets an). */
  setup: () => Promise<Ctx>;
  /** Optionales Cleanup nach dem Szenario. */
  cleanup?: (ctx: Ctx) => Promise<void>;
  /** Liest die "Anzeige"-Größe aus einem Read-API. */
  read: (ctx: Ctx) => Promise<Read>;
  /** Führt die "Buchung" aus (Mutation, Konsum, Berechnung). */
  write: (ctx: Ctx) => Promise<Write>;
  /** Extrahiert die zu vergleichende Zahl aus dem Read-Ergebnis. */
  extractDisplayed: (read: Read, ctx: Ctx) => number;
  /** Extrahiert die zu vergleichende Zahl aus dem Write-Ergebnis. */
  extractBooked: (write: Write, ctx: Ctx) => number;
  /** Optional: Toleranz in Cents/Einheiten (Default 0 = exakt gleich). */
  tolerance?: number;
}

export interface EqualityCheckOptions<Ctx, Read, Write, Value> {
  /** Domäne, gegen die die Equality läuft (taucht im Failure-Header auf). */
  domain: string;
  /** Reihenfolge: read zuerst, write danach? Manche Szenarien brauchen das andersrum. */
  order?: "read-then-write" | "write-then-read";
  scenarios: Array<EqualityScenario<Ctx, Read, Write, Value>>;
}

export interface EqualityResult {
  scenarioName: string;
  displayed: number;
  booked: number;
  delta: number;
  passed: boolean;
}

/**
 * Führt alle Szenarien sequentiell aus und vergleicht display- und
 * booking-Pfad. Wirft (via expect.fail), sobald eine Abweichung größer als
 * die zulässige Toleranz auftritt.
 */
export async function assertDisplayEqualsBooking<Ctx, Read, Write, Value>(
  opts: EqualityCheckOptions<Ctx, Read, Write, Value>,
): Promise<EqualityResult[]> {
  const order = opts.order ?? "read-then-write";
  const results: EqualityResult[] = [];
  const failures: string[] = [];

  for (const sc of opts.scenarios) {
    const ctx = await sc.setup();
    try {
      let readResult: Read;
      let writeResult: Write;

      if (order === "read-then-write") {
        readResult = await sc.read(ctx);
        writeResult = await sc.write(ctx);
      } else {
        writeResult = await sc.write(ctx);
        readResult = await sc.read(ctx);
      }

      const displayed = sc.extractDisplayed(readResult, ctx);
      const booked = sc.extractBooked(writeResult, ctx);
      const delta = Math.abs(displayed - booked);
      const tolerance = sc.tolerance ?? 0;
      const passed = delta <= tolerance;

      results.push({ scenarioName: sc.name, displayed, booked, delta, passed });

      if (!passed) {
        failures.push(
          `[${opts.domain}] "${sc.name}":\n` +
          `  Anzeige (read) = ${displayed}\n` +
          `  Buchung (write) = ${booked}\n` +
          `  Δ = ${delta} (Toleranz ${tolerance})`,
        );
      }
    } finally {
      if (sc.cleanup) {
        await sc.cleanup(ctx).catch((err) => {
          // Cleanup-Fehler dürfen den Test nicht maskieren, aber sichtbar sein.
          console.warn(`[equality-check] cleanup für '${sc.name}' fehlgeschlagen:`, err);
        });
      }
    }
  }

  if (failures.length > 0) {
    expect.fail(
      `${failures.length} Drift-Verletzung(en) entdeckt — Anzeige weicht von Buchung ab:\n\n` +
      failures.join("\n\n"),
    );
  }

  return results;
}
