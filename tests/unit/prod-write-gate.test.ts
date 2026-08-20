import { describe, expect, it, afterEach, vi } from "vitest";
import {
  dbHostOf,
  parseProdWriteArgs,
  assertApplyTargetIsProdPrimaryOrThrow,
  assertProdWriteAllowedOrThrow,
  REASON_MIN_LAENGE,
} from "../../server/scripts/lib/prod-write-gate";

// Der Datenbankname wird an der offenen Verbindung erfragt; fuer die reinen
// Ziel-Pruefungen wird er gestubbt.
//
// Die erste Fassung dieses Kommentars behauptete, der echte Weg sei „in
// `status-migration` abgedeckt". Das stimmte nicht — jene Datei importiert
// `migriereStatusModell` direkt und beruehrt das Gate nie. Der Mock pruefte
// damit exakt die Annahme, die er belegen sollte. Der echte Treiber-Pfad liegt
// jetzt in `tests/startup/prod-write-gate-db-name.test.ts`.
vi.mock("../../server/lib/db", () => ({
  db: { execute: async () => ({ rows: [{ db: DB_NAME.wert }] }) },
}));
const DB_NAME = { wert: "neondb" };

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
    it("lässt die bestätigte Prod-Primary durch", async () => {
      umgebung("postgres://u:p@db.prod.example.com:5432/neondb");
      DB_NAME.wert = "neondb";
      await expect(assertApplyTargetIsProdPrimaryOrThrow("db.prod.example.com/neondb")).resolves.toBeUndefined();
      // Groß-/Kleinschreibung ist beidseitig normalisiert.
      await expect(assertApplyTargetIsProdPrimaryOrThrow("DB.PROD.EXAMPLE.COM/NEONDB")).resolves.toBeUndefined();
    });

    it("blockt den Fall, der real passiert ist: gleicher Host, falsche Datenbank", async () => {
      // Auf Replit heisst der interne Postgres-Host in Dev und Prod gleich
      // (`helium`). Die erste Fassung des Gates verglich nur ihn — und liess
      // einen Lauf gegen `heliumdb` durch, waehrend Prod `neondb` ist.
      umgebung("postgres://u:p@helium:5432/heliumdb");
      DB_NAME.wert = "heliumdb";
      await expect(assertApplyTargetIsProdPrimaryOrThrow("helium/neondb"))
        .rejects.toThrow(/Verbunden mit Datenbank 'heliumdb'.*bestätigt wurde 'neondb'/s);
    });

    it("lehnt die alte einteilige Form ab, statt sie still zu akzeptieren", async () => {
      umgebung("postgres://u:p@helium:5432/neondb");
      DB_NAME.wert = "neondb";
      // Genau diese Form hat den Fehlgriff durchgelassen. Sie muss laut werden.
      await expect(assertApplyTargetIsProdPrimaryOrThrow("helium"))
        .rejects.toThrow(/<host>\/<datenbank>/);
    });

    it("verweigert alles, was nicht die bestätigte Prod-Primary ist", async () => {
      DB_NAME.wert = "neondb";
      const faelle: Array<[string, string, string | undefined, RegExp]> = [
        ["Wegwerf-DB", "postgres://u:p@db.prod.example.com/cc_test_careconnect", "db.prod.example.com/cc_test_careconnect", /Wegwerf/],
        ["lokal", "postgres://u:p@localhost:5432/neondb", "localhost/neondb", /lokal/],
        ["IPv4-Loopback", "postgres://u:p@127.0.0.1:5432/neondb", "127.0.0.1/neondb", /lokal/],
        ["Read-Replica", "postgres://u:p@db-replica.prod.example.com/neondb", "db-replica.prod.example.com/neondb", /Replica/],
        ["Ziel unbestätigt", "postgres://u:p@db.prod.example.com/neondb", undefined, /confirm-target/],
        ["falscher Host", "postgres://u:p@db.prod.example.com/neondb", "db.anders.example.com/neondb", /Host stimmt nicht/],
        ["leere URL", "", "irgendwas/neondb", /nicht ermittelbar/],
        ["unparsebare URL", "kein-url-format", "irgendwas/neondb", /nicht ermittelbar/],
      ];
      for (const [name, url, ziel, muster] of faelle) {
        umgebung(url);
        await expect(assertApplyTargetIsProdPrimaryOrThrow(ziel), name).rejects.toThrow(muster);
      }
    });

    it("verweigert IPv6-Loopback — die Klammern des URL-Parsers zaehlen nicht als Ausnahme", async () => {
      // `new URL(…).hostname` liefert fuer IPv6 `"[::1]"` MIT Klammern. Ein
      // Muster, das auf `::1` am Zeilenanfang prueft, greift dann nicht.
      umgebung("postgres://u:p@[::1]:5432/neondb");
      await expect(assertApplyTargetIsProdPrimaryOrThrow("[::1]/neondb")).rejects.toThrow(/lokal/);
    });

    it("verweigert ausserhalb von NODE_ENV=production und in Ephemeral-Umgebungen", async () => {
      umgebung("postgres://u:p@db.prod.example.com/neondb", { NODE_ENV: "development" });
      await expect(assertApplyTargetIsProdPrimaryOrThrow("db.prod.example.com/neondb")).rejects.toThrow(/NODE_ENV/);

      umgebung("postgres://u:p@db.prod.example.com/neondb", { TEST_DATABASE_URLS: "postgres://x/y" });
      await expect(assertApplyTargetIsProdPrimaryOrThrow("db.prod.example.com/neondb")).rejects.toThrow(/Ephemeral/);
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

/**
 * Die ZUSAMMENSETZENDE Funktion — bis hierhin ungetestet.
 *
 * Der Architektur-Waechter `prod-write-gate-coverage` erzwingt genau diesen
 * Symbolnamen. Nachdem das letzte Einmal-Skript, das ihn aufrief, abgelegt
 * wurde, hat sie im Repo NULL Aufrufer. Ein Gate ohne Aufrufer und ohne Test
 * ist eine Behauptung: waere das `await` vor
 * `assertApplyTargetIsProdPrimaryOrThrow` verlorengegangen — wovor der
 * Dateikopf selbst warnt, und `no-floating-promises` greift hier nicht —,
 * bliebe alles gruen und der Ziel-Zaun waere still weg.
 */
describe("assertProdWriteAllowedOrThrow — das komponierte Gate", () => {
  it("verlangt --user, bevor irgendetwas anderes geprueft wird", async () => {
    umgebung("postgres://u:p@helium/neondb");
    await expect(
      assertProdWriteAllowedOrThrow({ apply: true, reason: "lang genug fuer den Audit-Log" }, "Zweck"),
    ).rejects.toThrow(/--user=<superadmin-id>/);
  });

  it("verlangt eine Begruendung von Mindestlaenge", async () => {
    umgebung("postgres://u:p@helium/neondb");
    await expect(
      assertProdWriteAllowedOrThrow({ apply: true, userId: 1, reason: "zu kurz" }, "Zweck"),
    ).rejects.toThrow(new RegExp(`mindestens ${REASON_MIN_LAENGE} Zeichen`));
  });

  it("prueft das ZIEL — ohne --confirm-target kein Scharflauf", async () => {
    // Der eigentliche Punkt: das `await` vor der Ziel-Pruefung. Faellt es weg,
    // laeuft die Funktion durch und der Fehl-Dry-Run vom 18.08. waere wieder
    // moeglich.
    umgebung("postgres://u:p@helium/neondb");
    await expect(
      assertProdWriteAllowedOrThrow(
        { apply: true, userId: 1, reason: "lang genug fuer den Audit-Log" },
        "Zweck",
      ),
    ).rejects.toThrow(/--confirm-target/);
  });

  it("ein FALSCHER Datenbankname im --confirm-target bricht ab", async () => {
    // Genau der Vorfall: `helium` stimmt, `heliumdb` statt `neondb` nicht.
    umgebung("postgres://u:p@helium/neondb");
    await expect(
      assertProdWriteAllowedOrThrow(
        {
          apply: true,
          userId: 1,
          reason: "lang genug fuer den Audit-Log",
          confirmTarget: "helium/heliumdb",
        },
        "Zweck",
      ),
    ).rejects.toThrow();
  });
});
