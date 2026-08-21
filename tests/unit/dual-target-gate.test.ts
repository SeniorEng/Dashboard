/**
 * Dual-Target-Gate — für Skripte, die legitim in Dev UND Prod laufen.
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────
 * `reencrypt-company-secrets.ts` rotiert den `ENCRYPTION_KEY` und muss das in
 * beiden Umgebungen können. Sein bisheriger Ausweg war ein eigenes
 * `--confirm-db=<name>` — und das verglich den Namen aus der `DATABASE_URL`,
 * nicht aus der offenen Verbindung. Genau der Defekt vom 18.08.2026.
 *
 * ── Was hier bewiesen wird ──────────────────────────────────────────────
 * Dass die Klasse GENANNT werden muss und nicht abgeleitet wird. Würde sie
 * abgeleitet („`--confirm-target` gesetzt ⇒ Prod"), hinge die Sicherheitsstufe
 * an einem vergessenen Flag: wer es vergisst, bekäme still die schwächere
 * Prüfung.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { assertDualTargetOrThrow } from "../../server/scripts/lib/dual-target-gate";
import { parseProdWriteArgs } from "../../server/scripts/lib/prod-write-gate";
import { freigabeZuruecksetzen } from "../../server/lib/prod-write-lock";

// Der Datenbankname kommt bei BEIDEN Wegen aus der offenen Verbindung; hier
// gestubbt, damit die Auswahl-Logik ohne DB prüfbar ist. `DB_NAME` ist genau
// die Stelle, an der sich „aus der Verbindung" von „aus der URL" unterscheidet.
vi.mock("../../server/lib/db", () => ({
  db: {
    execute: async () => ({ rows: [{ db: DB_NAME.wert }] }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            { id: 1, isSuperAdmin: true, isActive: true, displayName: "Testadmin" },
          ],
        }),
      }),
    }),
  },
}));
const DB_NAME = { wert: "neondb" };

const GESICHERT = { ...process.env };
afterEach(() => {
  process.env = { ...GESICHERT };
  DB_NAME.wert = "neondb";
  freigabeZuruecksetzen();
});

function argsAus(...flags: string[]) {
  return parseProdWriteArgs(["node", "s.ts", "--apply", ...flags]);
}

describe("Dual-Target-Gate — die Klasse muss genannt werden", () => {
  it("ohne --target wirft es (fail-closed, keine Herabstufung)", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    process.env.PROD_DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    await expect(
      assertDualTargetOrThrow(
        argsAus("--user=1", "--reason=lang genug fuer den Audit", "--confirm-target=ep-x.neon.tech/neondb"),
        "Zweck",
      ),
    ).rejects.toThrow(/--target=prod oder --target=dev/);
  });

  it("ein unbekannter --target-Wert wirft ebenfalls", async () => {
    await expect(assertDualTargetOrThrow(argsAus("--target=beides"), "Zweck")).rejects.toThrow(
      /--target=prod oder --target=dev/,
    );
  });
});

describe("Dual-Target-Gate — --target=prod", () => {
  it("ohne --confirm-target wirft es", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    process.env.PROD_DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    await expect(
      assertDualTargetOrThrow(
        argsAus("--target=prod", "--user=1", "--reason=lang genug fuer den Audit"),
        "Zweck",
      ),
    ).rejects.toThrow(/--confirm-target/);
  });

  it("mit vollstaendiger Angabe geht es durch und meldet die Klasse", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    process.env.PROD_DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    const v = await assertDualTargetOrThrow(
      argsAus(
        "--target=prod",
        "--user=1",
        "--reason=lang genug fuer den Audit",
        "--confirm-target=ep-x.neon.tech/neondb",
      ),
      "Zweck",
    );
    expect(v.klasse).toBe("prod");
    expect(v.displayName).toBe("Testadmin");
  });

  it("der Datenbankname kommt aus der VERBINDUNG, nicht aus der URL", async () => {
    // Die URL sagt `sieht_harmlos_aus`, die Verbindung meldet `neondb`.
    // Genau daran lief das alte `--confirm-db` vorbei.
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://u:p@ep-x.neon.tech/sieht_harmlos_aus";
    process.env.PROD_DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    DB_NAME.wert = "neondb";
    await expect(
      assertDualTargetOrThrow(
        argsAus(
          "--target=prod",
          "--user=1",
          "--reason=lang genug fuer den Audit",
          "--confirm-target=ep-x.neon.tech/sieht_harmlos_aus",
        ),
        "Zweck",
      ),
    ).rejects.toThrow(/Verbunden mit Datenbank 'neondb'/);
  });
});

describe("Dual-Target-Gate — --target=dev", () => {
  it("gegen eine PROD-DB wirft es (Dev-Gate + Prod-Reject aus #118)", async () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    process.env.PROD_DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    process.env.DEV_WRITE_CONFIRM_TARGET = "ep-x.neon.tech/neondb";
    DB_NAME.wert = "neondb";
    await expect(assertDualTargetOrThrow(argsAus("--target=dev"), "Zweck")).rejects.toThrow(
      /DATABASE_URL == PROD_DATABASE_URL|IST die Produktionsdatenbank/,
    );
  });

  it("ohne DEV_WRITE_CONFIRM_TARGET wirft es", async () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgres://u:p@dev-host/careconnect_dev";
    process.env.PROD_DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    delete process.env.DEV_WRITE_CONFIRM_TARGET;
    await expect(assertDualTargetOrThrow(argsAus("--target=dev"), "Zweck")).rejects.toThrow(
      /DEV_WRITE_CONFIRM_TARGET/,
    );
  });

  it("ohne PROD_DATABASE_URL wirft der Dev-Zweig — strenger als bei reinen Dev-Skripten", async () => {
    // Fuer die reinen Dev-Wartungsskripte (#118) ist ihr Fehlen ein bewusst
    // offener Restrand. Bei einem Skript, das BEIDE Klassen bedient, ist die
    // Verwechslung dagegen der wahrscheinlichste Fehler: wer `--target=dev`
    // tippt, waehrend die Shell auf Prod zeigt, haette ohne PROD_DATABASE_URL
    // keinen Prod-Reject.
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    process.env.DEV_WRITE_CONFIRM_TARGET = "ep-x.neon.tech/neondb";
    delete process.env.PROD_DATABASE_URL;
    DB_NAME.wert = "neondb";
    await expect(assertDualTargetOrThrow(argsAus("--target=dev"), "Zweck")).rejects.toThrow(
      /--target=dev erfordert ein gesetztes PROD_DATABASE_URL/,
    );
  });

  it("mehrfaches --target gewinnt vorne — die Angabe muss eindeutig sein", async () => {
    // `argv.find` nimmt das erste Vorkommen. `--target=dev --target=prod`
    // ergibt also `dev`, die SCHWAECHERE Klasse. Das ist festgehalten, damit
    // niemand es fuer eine Ueberschreibung haelt.
    const a = parseProdWriteArgs(["node", "s.ts", "--apply", "--target=dev", "--target=prod"]);
    expect(a.target).toBe("dev");
  });

  it("eine echte Dev-DB geht durch", async () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgres://u:p@dev-host/careconnect_dev";
    process.env.DEV_WRITE_CONFIRM_TARGET = "dev-host/careconnect_dev";
    process.env.PROD_DATABASE_URL = "postgres://u:p@ep-x.neon.tech/neondb";
    DB_NAME.wert = "careconnect_dev";
    const v = await assertDualTargetOrThrow(argsAus("--target=dev"), "Zweck");
    expect(v.klasse).toBe("dev");
    expect(v.ziel).toBe("dev-host/careconnect_dev");
  });
});
