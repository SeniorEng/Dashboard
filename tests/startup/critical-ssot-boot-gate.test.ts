/**
 * Task #1339 — Critical-SSoT-Boot-Gate.
 *
 * Prüft die reine Entscheidungslogik `evaluateCriticalSsotGate` (DB-frei, alle
 * Branches) plus einen Integrations-Smoke, dass `runCriticalSsotBootGate` in der
 * Non-Prod-Test-Umgebung NICHT wirft (in Dev/Test wird höchstens gewarnt — die
 * Wegwerf-Test-DB läuft legitim mit leerer `prices`-Tabelle).
 */
import { describe, it, expect } from "vitest";
import {
  evaluateCriticalSsotGate,
  runCriticalSsotBootGate,
  loadBackupManifest,
  CriticalSsotDataLossError,
  type ManifestEntry,
} from "../../server/startup/critical-ssot-boot-gate";

const BASE = {
  targetTable: "prices",
  targetRowCount: 0,
  sourcesPresent: false,
  dependentCount: 5,
  manifestEntry: undefined as ManifestEntry | undefined,
  currentSchemaHash: "abc123",
  isProduction: false,
};

describe("Task #1339 — evaluateCriticalSsotGate", () => {
  it("PASS: Ziel hat Zeilen", () => {
    const d = evaluateCriticalSsotGate({ ...BASE, targetRowCount: 4, isProduction: true });
    expect(d.action).toBe("pass");
  });

  it("PASS: Ziel leer, aber Quell-Tabellen vorhanden (Befüllung kann noch laufen)", () => {
    const d = evaluateCriticalSsotGate({ ...BASE, sourcesPresent: true, isProduction: true });
    expect(d.action).toBe("pass");
  });

  it("PASS: Ziel leer & Quellen weg, aber kein Leser hängt davon ab", () => {
    const d = evaluateCriticalSsotGate({ ...BASE, dependentCount: 0, isProduction: true });
    expect(d.action).toBe("pass");
  });

  it("FAIL: gefährliche Kombination in Produktion (Ziel leer + Quellen weg + Leser)", () => {
    const d = evaluateCriticalSsotGate({ ...BASE, isProduction: true });
    expect(d.action).toBe("fail");
    expect(d.reason).toContain("prices");
  });

  it("WARN statt FAIL: gleiche Kombination außerhalb Produktion (Dev/Test)", () => {
    const d = evaluateCriticalSsotGate({ ...BASE, isProduction: false });
    expect(d.action).toBe("warn");
  });

  it("PASS: Manifest legitimiert den leeren Zustand bei passendem Schema-Hash", () => {
    const manifestEntry: ManifestEntry = {
      target: "prices",
      backupId: "prod-2026-06-17.dump",
      schemaHash: "abc123",
      timestamp: "2026-06-17T07:46:19Z",
    };
    const d = evaluateCriticalSsotGate({ ...BASE, manifestEntry, isProduction: true });
    expect(d.action).toBe("pass");
    expect(d.reason).toContain("prod-2026-06-17.dump");
  });

  it("FAIL: Manifest mit veraltetem Schema-Hash legitimiert NICHT (entwertet)", () => {
    const manifestEntry: ManifestEntry = {
      target: "prices",
      backupId: "prod-2026-06-17.dump",
      schemaHash: "STALE",
      timestamp: "2026-06-17T07:46:19Z",
    };
    const d = evaluateCriticalSsotGate({ ...BASE, manifestEntry, isProduction: true });
    expect(d.action).toBe("fail");
    expect(d.reason).toContain("veraltet");
  });
});

describe("Task #1339 — loadBackupManifest", () => {
  it("liest das committete Manifest (entries-Array, hier leer)", async () => {
    const entries = await loadBackupManifest();
    expect(Array.isArray(entries)).toBe(true);
  });
});

describe("Task #1339 — runCriticalSsotBootGate (Integration, Non-Prod)", () => {
  it("wirft in der Test-Umgebung NICHT (höchstens Warnung)", async () => {
    await expect(runCriticalSsotBootGate()).resolves.toBeUndefined();
  });

  it("CriticalSsotDataLossError ist exportiert und verständlich", () => {
    const err = new CriticalSsotDataLossError(["prices: LEER"]);
    expect(err.name).toBe("CriticalSsotDataLossError");
    expect(err.message).toContain("DATENVERLUST");
    expect(err.failures).toEqual(["prices: LEER"]);
  });
});
