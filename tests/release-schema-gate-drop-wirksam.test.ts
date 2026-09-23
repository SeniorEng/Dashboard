import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";

/**
 * Wird ein nicht freigegebener DROP vom Release-Gate wirklich noch
 * zurückgewiesen? — end-to-end, gegen eine echte Datenbank.
 *
 * ── Warum es diesen Test gibt ───────────────────────────────────────────
 * Alle bisherigen Tests des Drop-Gates sind **reine Funktionstests** auf
 * fest eingetippten Anweisungslisten (`release-schema-gate-statements`,
 * `schema-change-manifest`). Sie prüfen, ob `findeFreigabepflichtige` eine
 * DROP-Zeile erkennt — nicht, ob das Skript sie an einer laufenden DB
 * überhaupt zu sehen bekommt und daraufhin rot wird.
 *
 * Genau dazwischen sitzt `anstehendeAnweisungen()`: der `pushSchema`-
 * Trockenlauf samt der Drossel (`GLEICHZEITIG_MAX`), die die Katalog-
 * Abfragen auf vier gleichzeitige begrenzt. Ein Eingriff in die
 * Parallelität eines Riegels, dessen Wirksamkeit niemand end-to-end prüft,
 * ist dieselbe Lage wie eine Assertion, die nicht rot werden kann: die
 * Sicherung sieht unverändert aus, und ob sie noch sichert, weiß keiner.
 *
 * Der Handlauf vom 23.09.2026 hat gezeigt, dass sie es tut
 * (`column:invoices.zz_drop_probe` → „keine Freigabe", exit 1). Ein
 * Handlauf hält aber nur bis zum nächsten Umbau.
 *
 * ── Beide Richtungen ────────────────────────────────────────────────────
 * Ohne den Gegenfall wäre „bricht ab" auch dadurch zu erfüllen, dass das
 * Gate immer abbricht — und ein Riegel, der jeden Deploy blockiert, wird
 * genauso sicher entfernt wie einer, der nichts blockiert.
 */

const WURZEL = path.resolve(__dirname, "..");
const PROBE_SPALTE = "zz_drop_gate_probe";

function gateFahren(): Promise<{ code: number; ausgabe: string }> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["tsx", "scripts/release-schema-gate.ts", "--drop-gate"],
      {
        cwd: WURZEL,
        env: {
          ...process.env,
          // Der Gate-Pfad ist einer der drei legitimen Nicht-Wegwerf-Wege.
          ALLOW_NON_EPHEMERAL_DB_WRITE: "1",
          DB_DRIVER: "pg",
        },
        maxBuffer: 20 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof (err as { code?: unknown }).code === "number"
            ? (err as unknown as { code: number }).code
            : 0,
          ausgabe: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

describe("Release-Gate — ein nicht freigegebener DROP wird zurückgewiesen", () => {
  it("DG-1 – eine Spalte, die das Ziel-Schema nicht kennt, bricht den Release ab", async () => {
    await db.execute(sql.raw(
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ${PROBE_SPALTE} text`,
    ));
    try {
      const { code, ausgabe } = await gateFahren();

      expect(code, "das Gate winkt einen nicht freigegebenen DROP durch").not.toBe(0);
      expect(ausgabe, "der Abbruch nennt den Grund nicht").toContain("RELEASE ABGEBROCHEN");
      expect(
        ausgabe,
        "der Abbruch nennt die betroffene Spalte nicht — dann weiß niemand, was freizugeben wäre",
      ).toContain(`column:invoices.${PROBE_SPALTE}`);
    } finally {
      await db.execute(sql.raw(
        `ALTER TABLE invoices DROP COLUMN IF EXISTS ${PROBE_SPALTE}`,
      ));
    }
  }, 180_000);

  it("DG-2 – ein deckungsgleiches Schema läuft durch", async () => {
    // Der Gegenfall. Ein Push gegen ein deckungsgleiches Schema erzeugt
    // regelmäßig ~8 `DROP CONSTRAINT` (drizzle legt Fremdschlüssel mit
    // abgeschnittenen Namen neu an) — ein Riegel auf „DROP" würde hier
    // blockieren und damit jeden Deploy.
    const { code, ausgabe } = await gateFahren();

    expect(code, `das Gate blockiert einen harmlosen Push:\n${ausgabe}`).toBe(0);
    expect(ausgabe).toContain("keine davon ist freigabepflichtig");
  }, 180_000);
});
