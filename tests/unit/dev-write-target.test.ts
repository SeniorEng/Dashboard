/**
 * Positive Ziel-Prüfung für schreibende Dev-Läufe.
 *
 * ── Der Anlass ──────────────────────────────────────────────────────────
 * `assertDevDatabase()` ist ein NEGATIVES Prädikat: „der Host sieht nicht nach
 * Produktion aus". Im Gate-2-Review von PR #117 gemessen — damit bestehen
 *
 *   helium                     ← der ECHTE Prod-Host
 *   ep-….eu-central-1.aws.neon.tech   ← die Neon-Prod-Form
 *   localhost
 *
 * die Prüfung glatt. „Nicht Prod" ist eben auch für eine unbekannte oder
 * fehlkonfigurierte Datenbank wahr — dasselbe NULL-Loch, das bei den
 * Geburtstagskarten schon einmal zugeschlagen hat.
 *
 * Ein negatives Prädikat darf deshalb kein Schreibrecht erteilen. Diese Datei
 * nagelt die Umkehrung fest: das Ziel muss BENANNT werden, und der
 * Datenbankname kommt aus der OFFENEN Verbindung.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  assertDevWriteTargetOrThrow,
  DEV_WRITE_CONFIRM_ENV,
} from "../../server/lib/dev-db-guard";
import { freigabeZuruecksetzen } from "../../server/lib/prod-write-lock";

// Der Datenbankname wird an der offenen Verbindung erfragt; hier gestubbt,
// damit die reine Ziel-Logik ohne DB prüfbar ist. Welchen Namen die Verbindung
// meldet, steuert `DB_NAME` — genau darin liegt der Unterschied zur URL.
vi.mock("../../server/lib/db", () => ({
  db: { execute: async () => ({ rows: [{ db: DB_NAME.wert }] }) },
}));
const DB_NAME = { wert: "careconnect_dev" };

const GESICHERT = { ...process.env };

afterEach(() => {
  process.env = { ...GESICHERT };
  DB_NAME.wert = "careconnect_dev";
  freigabeZuruecksetzen();
});

function umgebung(url: string, ziel?: string): void {
  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL = url;
  delete process.env.PROD_DATABASE_URL;
  if (ziel === undefined) delete process.env[DEV_WRITE_CONFIRM_ENV];
  else process.env[DEV_WRITE_CONFIRM_ENV] = ziel;
}

describe("assertDevWriteTargetOrThrow — die Hosts, die der negative Screen durchliess", () => {
  it.each([
    ["helium (der echte Prod-Host)", "postgres://u:p@helium/neondb"],
    ["Neon-Prod-Form", "postgres://u:p@ep-cool-1234.eu-central-1.aws.neon.tech/neondb"],
    ["localhost", "postgres://u:p@localhost:5432/careconnect"],
  ])("%s wirft jetzt, weil kein Ziel benannt ist", async (_name, url) => {
    umgebung(url);
    await expect(assertDevWriteTargetOrThrow()).rejects.toThrow(
      new RegExp(DEV_WRITE_CONFIRM_ENV),
    );
  });

  it("ein FALSCH benanntes Ziel wirft — der Name kommt aus der Verbindung", async () => {
    // Der Kern: die URL sagt `neondb`, die offene Verbindung meldet etwas
    // anderes. Genau daran lief der Fehl-Dry-Run vom 18.08.2026 vorbei.
    DB_NAME.wert = "neondb";
    umgebung("postgres://u:p@helium/neondb", "helium/careconnect_dev");
    await expect(assertDevWriteTargetOrThrow()).rejects.toThrow(
      /zeigt aber auf "helium\/neondb"/,
    );
  });

  it("das RICHTIG benannte Dev-Ziel geht durch", async () => {
    umgebung("postgres://u:p@dev-host/careconnect_dev", "dev-host/careconnect_dev");
    await expect(assertDevWriteTargetOrThrow()).resolves.toBe("dev-host/careconnect_dev");
  });

  it("der billige Prod-Screen greift weiterhin ZUERST", async () => {
    // Die neue Pruefung ERSETZT `assertDevDatabase()` nicht, sie kommt davor.
    umgebung("postgres://u:p@prod-db/careconnect", "prod-db/careconnect_dev");
    await expect(assertDevWriteTargetOrThrow()).rejects.toThrow(/sieht nach Produktion aus/);
  });

  it("NODE_ENV=production wirft, egal wie das Ziel benannt ist", async () => {
    umgebung("postgres://u:p@dev-host/careconnect_dev", "dev-host/careconnect_dev");
    process.env.NODE_ENV = "production";
    await expect(assertDevWriteTargetOrThrow()).rejects.toThrow(/NODE_ENV=production/);
  });
});
