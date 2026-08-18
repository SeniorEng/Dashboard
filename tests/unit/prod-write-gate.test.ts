import { describe, expect, it, afterEach } from "vitest";
import {
  dbHostOf,
  parseProdWriteArgs,
  assertApplyTargetIsProdPrimaryOrThrow,
} from "../../server/scripts/lib/prod-write-gate";

/**
 * Der Ziel-Zaun für schreibende Einmal-Skripte auf Produktion.
 *
 * ── Warum diese Datei existiert ─────────────────────────────────────────
 * Der Status-Umbau hat das Gate mit dem Argument aus dem Migrations-Skript
 * herausgezogen, es mache den Schreibpfad untestbar. Das Gate selbst landete
 * dabei ohne einen einzigen Test — obwohl es reine Funktionen sind und obwohl
 * es die letzte Schranke vor einem `--apply` gegen die falsche Datenbank ist.
 *
 * Die Dev-DB ist laut CLAUDE.md eine PROD-KOPIE mit echten Provider-Tokens.
 * Ein Zaun, der dort stillschweigend durchlässt, ist schlimmer als keiner.
 */

const GESICHERT = { ...process.env };

afterEach(() => {
  process.env = { ...GESICHERT };
});

function umgebung(url: string, extra: Record<string, string> = {}) {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = url;
  delete process.env.TEST_DATABASE_URLS;
  Object.assign(process.env, extra);
}

describe("Prod-Schreib-Gate", () => {
  describe("Ziel-Prüfung — fail-closed", () => {
    it("lässt die bestätigte Prod-Primary durch", () => {
      umgebung("postgres://u:p@db.prod.example.com:5432/careconnect");
      expect(() => assertApplyTargetIsProdPrimaryOrThrow("db.prod.example.com")).not.toThrow();
      // Groß-/Kleinschreibung ist beidseitig normalisiert.
      expect(() => assertApplyTargetIsProdPrimaryOrThrow("DB.PROD.EXAMPLE.COM")).not.toThrow();
    });

    it("verweigert alles, was nicht die bestätigte Prod-Primary ist", () => {
      const faelle: Array<[string, string, string | undefined, RegExp]> = [
        ["Wegwerf-DB", "postgres://u:p@db.prod.example.com/cc_test_careconnect", "db.prod.example.com", /Wegwerf/],
        ["lokal", "postgres://u:p@localhost:5432/careconnect", "localhost", /lokal/],
        ["IPv4-Loopback", "postgres://u:p@127.0.0.1:5432/careconnect", "127.0.0.1", /lokal/],
        ["Read-Replica", "postgres://u:p@db-replica.prod.example.com/careconnect", "db-replica.prod.example.com", /Replica/],
        ["Ziel unbestätigt", "postgres://u:p@db.prod.example.com/careconnect", undefined, /confirm-target/],
        ["falsches Ziel", "postgres://u:p@db.prod.example.com/careconnect", "db.anders.example.com", /confirm-target/],
        ["leere URL", "", "irgendwas", /nicht ermittelbar/],
        ["unparsebare URL", "kein-url-format", "irgendwas", /nicht ermittelbar/],
      ];
      for (const [name, url, ziel, muster] of faelle) {
        umgebung(url);
        expect(() => assertApplyTargetIsProdPrimaryOrThrow(ziel), name).toThrow(muster);
      }
    });

    it("verweigert IPv6-Loopback — die Klammern des URL-Parsers zaehlen nicht als Ausnahme", () => {
      // `new URL(…).hostname` liefert fuer IPv6 `"[::1]"` MIT Klammern. Ein
      // Muster, das auf `::1` am Zeilenanfang prueft, greift dann nicht.
      umgebung("postgres://u:p@[::1]:5432/careconnect");
      expect(() => assertApplyTargetIsProdPrimaryOrThrow("[::1]")).toThrow(/lokal/);
    });

    it("verweigert ausserhalb von NODE_ENV=production und in Ephemeral-Umgebungen", () => {
      umgebung("postgres://u:p@db.prod.example.com/careconnect", { NODE_ENV: "development" });
      expect(() => assertApplyTargetIsProdPrimaryOrThrow("db.prod.example.com")).toThrow(/NODE_ENV/);

      umgebung("postgres://u:p@db.prod.example.com/careconnect", { TEST_DATABASE_URLS: "postgres://x/y" });
      expect(() => assertApplyTargetIsProdPrimaryOrThrow("db.prod.example.com")).toThrow(/Ephemeral/);
    });
  });

  describe("dbHostOf", () => {
    it("liefert den kleingeschriebenen Host, sonst null", () => {
      expect(dbHostOf("postgres://u:p@DB.Prod.Example.COM:5432/x")).toBe("db.prod.example.com");
      // `null` statt Wurf: der Aufrufer bricht darauf ab (fail-closed).
      expect(dbHostOf("")).toBeNull();
      expect(dbHostOf("nonsense")).toBeNull();
    });
  });

  describe("Argument-Auswertung", () => {
    it("liest die Flags und weist eine unbrauchbare User-Id ab", () => {
      const a = parseProdWriteArgs([
        "node", "skript.ts", "--apply",
        "--user=42", '--reason=Statusmodell umstellen', "--confirm-target=db.prod",
      ]);
      expect(a).toEqual({
        apply: true, userId: 42,
        reason: "Statusmodell umstellen", confirmTarget: "db.prod",
      });

      // `--user=abc` ⇒ `NaN`. Ohne die Pruefung landete das als
      // `audit_log.user_id` und kippte erst spaeter an der Fremdschluessel-
      // Bedingung — mitten in der Transaktion.
      expect(parseProdWriteArgs(["node", "s.ts", "--apply", "--user=abc"]).userId).toBeUndefined();
    });

    it("ohne Flags ist nichts gesetzt — insbesondere kein Default-Verantwortlicher", () => {
      const a = parseProdWriteArgs(["node", "skript.ts"]);
      expect(a.apply).toBe(false);
      // Der frühere Default `1` war der Grund, diesen Zaun ueberhaupt zu bauen.
      expect(a.userId).toBeUndefined();
      expect(a.reason).toBeUndefined();
    });
  });
});
