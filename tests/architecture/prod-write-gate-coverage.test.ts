// ---------------------------------------------------------------------------
// Prod-Schreib-Gate: schreibende Skripte MÜSSEN ihr Ziel deklarieren
//
// Der Fehl-Dry-Run vom 18.08.2026 lief gegen `heliumdb` statt `neondb`, weil
// `helium` in Dev wie Prod derselbe interne Hostname ist. Die Härtung war ein
// zweiteiliges `--confirm-target=<host>/<datenbank>`, dessen Datenbankname aus
// der OFFENEN Verbindung kommt (`current_database()`), nicht aus der URL.
//
// Nur: die SSoT dafür (`server/scripts/lib/prod-write-gate.ts`) hatte danach
// GENAU EINEN Aufrufer. Gemessen beim Aufräumen: 18 von 19 schreibenden
// Skripten hatten kein Ziel-Gate, zwei davon eine handgeschriebene „nur
// Host"-Prüfung — also genau die Formulierung, die am Vorfall gescheitert ist.
//
// ── Was dieser Wächter ERSETZT ─────────────────────────────────────────────
// „Jedes Skript denkt selbst daran." Das ist keine Absicherung, das ist eine
// Hoffnung. Ab hier ist ein schreibendes Skript ohne Gate ein roter Test.
//
// ── Warum eine Allowlist, und warum sie NUR schrumpft ──────────────────────
// Ohne sie müssten alle 15 bekannten Löcher in einem Zug gestopft werden —
// ein Groß-PR quer durch Abrechnung, Verschlüsselung und §45b, den niemand
// ernsthaft reviewen kann. Mit ihr ist die Regel ab Tag 1 fail-closed für
// alles NEUE, und die bekannten Löcher werden in Wellen abgetragen. Dieselbe
// Disziplin wie beim gepinnten Churn-Fingerprint des Release-Steps.
//
// Jeder Eintrag trägt den SHA-256 seines Inhalts. Das ist der Unterschied
// zwischen „bekannte Altlast" und „Freibrief":
//   * Wird das Skript GEÄNDERT, passt der Hash nicht mehr → rot. Die Allowlist
//     kann also nicht zum Unterstand werden, unter dem ungegateter Code
//     weiterwächst.
//   * Wird es GEGATET, greift Test 2 → Eintrag muss raus.
//   * Wird es GELÖSCHT, greift Test 1 → Eintrag muss raus.
// Damit schrumpft die Liste von selbst und kann nicht stillstehen.
//
// ── Was er NICHT kann (ehrlich, wie beim bash-gate) ────────────────────────
// Ein Mensch kann einen Eintrag hinzufügen. Verhindern lässt sich das nicht —
// sichtbar machen schon: `BEKANNTE_LOECHER` muss zur Listenlänge passen, jede
// Ergänzung ändert also die Zahl im Diff. Ein wachsendes „15 → 16" ist im
// Review nicht zu übersehen. Das ist ein Stolperdraht, keine Sandbox.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SKRIPT_DIR = path.resolve(process.cwd(), "server/scripts");
const GATE = "assertProdWriteAllowedOrThrow";

/** `.update(`, `.insert(`, `.delete(` — dieselbe Erkennung wie bei der Erhebung. */
const SCHREIBT = /\.\s*(?:update|insert|delete)\s*\(/;

/**
 * Gepinnter Schnappschuss der bekannten Löcher. **Diese Liste schrumpft nur.**
 * Wellenplan: W1 = die zwei kaputt-gegateten (nur Host), W2 = hoher
 * Blast-Radius, W3+ = Rest.
 */
const ALTLAST: readonly { datei: string; sha256: string }[] = [
  { datei: "server/scripts/apply-vacation-policy-2026.ts", sha256: "37dcf9af44d0ae6d" },
  { datei: "server/scripts/b3-quantify-exposure.ts", sha256: "ad122b582faf1605" },
  { datei: "server/scripts/backfill-missing-import-consumption.ts", sha256: "ab6fb319b8f00d4d" },
  { datei: "server/scripts/cleanup-duplicate-carryovers.ts", sha256: "0dd1cd68ca804ec5" },
  { datei: "server/scripts/cleanup-duplicate-monthly-proofs.ts", sha256: "f4718563d7a688e0" },
  { datei: "server/scripts/cleanup-orphan-appointments.ts", sha256: "9865c82d2fd47bc2" },
  { datei: "server/scripts/cleanup-selbstzahler-statutory-budgets.ts", sha256: "edced74152e2c84b" },
  { datei: "server/scripts/reconcile-billed-appointment-import-drift.ts", sha256: "68ea413d0cdcacd2" },
  { datei: "server/scripts/reconcile-import-from-excel.ts", sha256: "e5fa5d19206aeb1c" },
  { datei: "server/scripts/reconcile-km-drift.ts", sha256: "0c1b45563cac5e45" },
  { datei: "server/scripts/reconcile-phantom-stornos.ts", sha256: "a01239e0e7fda5ce" },
  { datei: "server/scripts/reconcile-reversal-chains.ts", sha256: "34af822d4f0cca67" },
  { datei: "server/scripts/reconcile-trimmed-imports.ts", sha256: "5852ae1ce11cc0fc" },
  { datei: "server/scripts/reencrypt-company-secrets.ts", sha256: "630437941645c519" },
  { datei: "server/scripts/reissue-selbstzahler-vat-invoices.ts", sha256: "c22147a672a8a1be" },
];

/** Muss zur Listenlänge passen — macht jede Ergänzung im Diff sichtbar. */
const BEKANNTE_LOECHER = 15;

function schreibendeSkripte(): string[] {
  return readdirSync(SKRIPT_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `server/scripts/${f}`)
    .filter((rel) => SCHREIBT.test(readFileSync(path.resolve(process.cwd(), rel), "utf8")))
    .sort();
}

function inhalt(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

/**
 * Fehlt die Datei, ist das Test 1s Befund — Test 2 und 3 duerfen daran nicht
 * mit einem ENOENT-Stacktrace zerschellen und auf die falsche Ursache zeigen.
 * Gegengeprueft: ein geloeschtes Altlast-Skript ergab vorher DREI rote Tests,
 * zwei davon mit unbrauchbarer Meldung.
 */
function vorhandeneEintraege(): { datei: string; sha256: string }[] {
  return ALTLAST.filter((e) => existsSync(path.resolve(process.cwd(), e.datei)));
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

describe("server/scripts/** — schreibende Skripte deklarieren ihr Ziel", () => {
  it("jedes schreibende Skript hat das Gate ODER steht als bekannte Altlast drin", () => {
    const bekannt = new Set(ALTLAST.map((e) => e.datei));
    const ungegatet = schreibendeSkripte().filter(
      (rel) => !inhalt(rel).includes(GATE) && !bekannt.has(rel),
    );
    expect(
      ungegatet,
      `Diese Skripte schreiben in die DB, ohne ihr Ziel zu deklarieren.\n` +
        `Ein Schreibzugriff ohne \`--confirm-target=<host>/<datenbank>\` kann in\n` +
        `der falschen Datenbank landen — genau das ist am 18.08.2026 passiert.\n` +
        `Nimm \`${GATE}\` aus server/scripts/lib/prod-write-gate.ts.\n` +
        `Die Altlast-Liste ist KEIN Ablageort fuer Neues:\n  ${ungegatet.join("\n  ")}`,
    ).toEqual([]);
  });

  it("Test 1 — kein Altlast-Eintrag zeigt auf eine geloeschte Datei", () => {
    const vorhanden = new Set(schreibendeSkripte());
    const verwaist = ALTLAST.filter((e) => !vorhanden.has(e.datei)).map((e) => e.datei);
    expect(
      verwaist,
      `Diese Eintraege sind stale — Datei geloescht oder schreibt nicht mehr.\n` +
        `Raus damit, sonst legitimiert die Liste Gespenster:\n  ${verwaist.join("\n  ")}`,
    ).toEqual([]);
  });

  it("Test 2 — kein Altlast-Eintrag ist laengst gegatet", () => {
    const erledigt = vorhandeneEintraege()
      .filter((e) => inhalt(e.datei).includes(GATE))
      .map((e) => e.datei);
    expect(
      erledigt,
      `Diese Skripte haben das Gate inzwischen — Eintrag entfernen, damit die\n` +
        `Liste den echten Restbestand zeigt:\n  ${erledigt.join("\n  ")}`,
    ).toEqual([]);
  });

  it("Test 3 — ein Altlast-Skript darf sich nicht veraendern (kein Unterstand)", () => {
    // Der eigentliche Riegel gegen Missbrauch: die Liste duldet BESTEHENDEN
    // ungegateten Code, nicht WACHSENDEN. Wer eine dieser Dateien anfasst,
    // muss sie gaten — oder den Hash bewusst neu pinnen, und das steht dann
    // im Diff.
    const veraendert = vorhandeneEintraege()
      .filter((e) => hash(inhalt(e.datei)) !== e.sha256)
      .map((e) => e.datei);
    expect(
      veraendert,
      `Diese Altlast-Skripte wurden geaendert, ohne das Gate einzubauen.\n` +
        `Wer ein ungegatetes Skript anfasst, gatet es — die Liste ist fuer\n` +
        `Bestand da, nicht fuer Zuwachs:\n  ${veraendert.join("\n  ")}`,
    ).toEqual([]);
  });

  it("Test 4 — die Liste kann nicht still wachsen", () => {
    expect(ALTLAST.length).toBe(BEKANNTE_LOECHER);
    expect(new Set(ALTLAST.map((e) => e.datei)).size).toBe(ALTLAST.length);
    // Sortiert, damit ein Zuwachs nicht in der Mitte untergeht.
    expect([...ALTLAST.map((e) => e.datei)].sort()).toEqual(ALTLAST.map((e) => e.datei));
  });

  it("die Gate-SSoT existiert und wird wirklich benutzt", () => {
    // Gegenprobe: der Waechter waere wertlos, wenn der Gate-Name nie vorkaeme
    // (Tippfehler, umbenannte Funktion) — dann waere jede Datei „ungegatet"
    // oder, schlimmer, die Suche liefe ins Leere.
    const ssot = inhalt("server/scripts/lib/prod-write-gate.ts");
    expect(ssot).toContain(`export async function ${GATE}`);
  });
});
