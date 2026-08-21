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
// ── DIE GRENZE: Indirektion sieht er NICHT ─────────────────────────────────
// Gemessen am 20.08.2026 in `server/scripts/`: 15 Skripte schreiben so, dass
// dieser Waechter es sieht — 12 weitere schreiben ueber importierte
// Storage-/Service-Helfer (`rebookAppointmentConsumption`,
// `stornoInvoiceDocumentOnly`, PDF-Orchestrator …). Die Datei selbst enthaelt
// dann kein einziges `.update(`, und statische Textsuche kann das nicht
// aufloesen, ohne den Importgraphen zu verfolgen.
//
// Zwei davon sind GoBD-nah: `reconcile-forbidden-private-invoices.ts` und
// `reconcile-phantom-pot-invoices.ts` erzeugen ueber einen Helfer
// STORNORECHNUNGEN. Fuer sie ist dieser Waechter blind.
//
// Rohes SQL (`db.execute(sql\`UPDATE …\`)`) ist seit dem Review mit drin —
// `fix-customer-182-budget-cap.ts` schrieb so, ohne jeden Guard.
//
// Der belastbare Riegel gegen JEDE Indirektion ist eine Laufzeit-Sperre im
// gemeinsamen db-Write-Layer (Kontext-Flag, gesetzt von
// `assertProdWriteAllowedOrThrow`). Die gehoert in einen eigenen PR — sie
// fasst den Schreibpfad der ganzen App an. Bis dahin gilt: dieser Waechter
// deckt den direkten Weg ab, nicht den indirekten. Wer ein Wellen-Skript
// anfasst, prueft von Hand, ob es ueber einen Helfer schreibt.
//
// ── Was er NICHT kann (ehrlich, wie beim bash-gate) ────────────────────────
// Ein Mensch kann einen Eintrag hinzufügen. Verhindern lässt sich das nicht —
// sichtbar machen schon: `BEKANNTE_LOECHER` muss zur Listenlänge passen, jede
// Ergänzung ändert also die Zahl im Diff.
//
// Eine Einschraenkung dazu, die im Review aufkam und stimmt: wer im SELBEN PR
// ein Skript gatet (Eintrag faellt raus) und ein neues eintraegt, haelt die
// Laenge konstant — die ZAHL verraet den Tausch dann nicht. Die Liste selbst
// steht natuerlich im Diff, ein neuer Dateiname darin ist sichtbar. Aber die
// Zahl allein traegt die Aussage nicht, und genau dieser Fall ist der
// Normalfall der Wellen-PRs. Stolperdraht, keine Sandbox.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { quelltextSchreibt } from "@shared/db-write-statements";

// BEIDE Skript-Verzeichnisse. `scripts/` fehlte in der ersten Fassung —
// `audit-duplicate-wizard-carryovers.ts` (erzeugt Storno-Allokationen) und
// `verify-advice-backfill.ts` (schreibt laut Kopfkommentar gegen Prod) lagen
// damit ganz ausserhalb der Reichweite des Waechters.
const SKRIPT_DIRS = ["server/scripts", "scripts"] as const;
const GATE = "assertProdWriteAllowedOrThrow";
/**
 * Zweite gueltige Form: das Dual-Target-Gate fuer Skripte, die legitim in Dev
 * UND Prod laufen (`server/scripts/lib/dual-target-gate.ts`). Es delegiert an
 * genau dieselben zwei Gates und ist deshalb kein Zweitbegriff, sondern eine
 * Auswahl davor.
 */
const DUAL_GATE = "assertDualTargetOrThrow";

/**
 * Die Erkennung teilt sich die SSoT mit der Laufzeit-Sperre
 * (`@shared/db-write-statements`). Zwei Pruefer, EINE Antwort auf „schreibt
 * das?" — liefen sie auseinander, meldete der eine ein Skript als harmlos,
 * waehrend der andere es sperrt (oder schlimmer: umgekehrt).
 *
 * Dass das kein theoretisches Risiko ist, hat der Umbau selbst gezeigt: das
 * Muster hatte ein abschliessendes `\b` hinter `UPDATE\s+\w`, wodurch
 * `UPDATE invoices …` NICHT traf (nur `UPDATE i`). Beide Pruefer waren fuer
 * rohes UPDATE blind, bis Mutationstest 4 es aufdeckte.
 */
/**
 * Gepinnter Schnappschuss der bekannten Löcher. **Diese Liste schrumpft nur.**
 * Wellenplan: W1 = die zwei kaputt-gegateten (nur Host), W2 = hoher
 * Blast-Radius, W3+ = Rest.
 *
 * Jeder Eintrag traegt den SHA-256 seines Inhalts: wird die Datei geaendert,
 * passt der Hash nicht mehr und Test 3 wird rot. Die Liste duldet BESTEHENDEN
 * ungegateten Code, nicht WACHSENDEN.
 */
const ALTLAST: readonly { datei: string; sha256: string }[] = [
  { datei: "scripts/audit-duplicate-wizard-carryovers.ts", sha256: "e68b65e32f201702" },
  { datei: "scripts/ci-seed-superadmin.ts", sha256: "8393502e6c045110" },
  { datei: "scripts/migrate-schema.ts", sha256: "cc2ada92e0ac3ec6" },
  { datei: "scripts/verify-advice-backfill.ts", sha256: "1584bebf75ad95a3" },
  { datei: "server/scripts/apply-vacation-policy-2026.ts", sha256: "37dcf9af44d0ae6d" },
  { datei: "server/scripts/b3-quantify-exposure.ts", sha256: "ad122b582faf1605" },
  { datei: "server/scripts/backfill-missing-import-consumption.ts", sha256: "ab6fb319b8f00d4d" },
  { datei: "server/scripts/cleanup-duplicate-carryovers.ts", sha256: "0dd1cd68ca804ec5" },
  { datei: "server/scripts/cleanup-orphan-appointments.ts", sha256: "9865c82d2fd47bc2" },
  { datei: "server/scripts/cleanup-selbstzahler-statutory-budgets.ts", sha256: "edced74152e2c84b" },
  { datei: "server/scripts/cleanup-test-data.ts", sha256: "d46beef9193c2384" },
  { datei: "server/scripts/reconcile-import-from-excel.ts", sha256: "e5fa5d19206aeb1c" },
  { datei: "server/scripts/reconcile-phantom-stornos.ts", sha256: "a01239e0e7fda5ce" },
  { datei: "server/scripts/reconcile-reversal-chains.ts", sha256: "34af822d4f0cca67" },
  { datei: "server/scripts/reconcile-trimmed-imports.ts", sha256: "5852ae1ce11cc0fc" },
];

/** Muss zur Listenlänge passen — macht jede Ergänzung im Diff sichtbar. */
const BEKANNTE_LOECHER = 15;

function schreibendeSkripte(): string[] {
  return SKRIPT_DIRS.flatMap((dir) =>
    readdirSync(path.resolve(process.cwd(), dir), { recursive: true, encoding: "utf8" })
      .filter(
        (f) =>
          /\.(?:ts|mts|cts)$/.test(f) &&
          !f.includes("__fixtures__") &&
          // `lib/` sind importierte Helfer, keine aufrufbaren Entrypoints. Der
          // statische Waechter fragt „welches SKRIPT braucht ein Ziel-Gate?" —
          // ein Helfer beantwortet das nicht, er hat keinen eigenen Aufruf.
          // Schreibt er, faengt ihn die Laufzeit-Sperre am Treiber, und zwar
          // ortsunabhaengig.
          !/(^|\/)lib\//.test(f),
      )
      .map((f) => `${dir}/${f}`),
  )
    .filter((rel) => quelltextSchreibt(readFileSync(path.resolve(process.cwd(), rel), "utf8")))
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

/** Ruft die Datei eines der beiden Ziel-Gates AUF (nicht: erwaehnt es)? */
function ruftGate(text: string): boolean {
  const ohne = entkommentiert(text);
  return new RegExp(`\\b(?:${GATE}|${DUAL_GATE})\\s*\\(`).test(ohne);
}

/** Kommentare raus — sonst erfuellt eine Erwaehnung die Regel. */
function entkommentiert(text: string): string {
  return text.replace(/\/\/[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

describe("server/scripts/** — schreibende Skripte deklarieren ihr Ziel", () => {
  it("jedes schreibende Skript hat das Gate ODER steht als bekannte Altlast drin", () => {
    const bekannt = new Set(ALTLAST.map((e) => e.datei));
    const ungegatet = schreibendeSkripte().filter(
      // AUFRUF im entkommentierten Text, nicht blosse Erwaehnung. Dieser PR
      // fuegt selbst Kommentare ein, die den Gate-Namen buchstaeblich nennen
      // ("ERSETZT durch die SSoT assertProdWriteAllowedOrThrow") — mit einer
      // reinen Textsuche waere jeder davon ein Unterstand geworden. Dieselbe
      // Falle wie bei der Parser-Regel in PR #119.
      (rel) => !ruftGate(inhalt(rel)) && !bekannt.has(rel),
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
      .filter((e) => ruftGate(inhalt(e.datei)))
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

  it("wer das Gate benutzt, liest die Flags auch aus der SSoT", () => {
    // Sonst entsteht wieder ein zweiter Leser. Der lokale
    // `argv.find(...)?.split("=")[1]` schnitt am ERSTEN `=` ab:
    // `--reason="… #1651 => Korrektur"` wurde zu `… #1651 `, blieb ueber der
    // 10-Zeichen-Schranke und landete VERSTUEMMELT im GoBD-Audit-Log.
    // `parseProdWriteArgs` benutzt `slice(praefix.length)`.
    const ohneParser = schreibendeSkripte()
      .filter((rel) => ruftGate(inhalt(rel)))
      // Auf den AUFRUF pruefen, nicht auf den Namen: ein Kommentar, der
      // `parseProdWriteArgs` erwaehnt, erfuellte eine reine Text-Suche und
      // machte die Regel wirkungslos. Genau das ist beim Gegenpruefen
      // passiert.
      .filter((rel) => !/\bparseProdWriteArgs\s*\(/.test(entkommentiert(inhalt(rel))));
    expect(
      ohneParser,
      `Diese Skripte rufen ${GATE}, lesen die gemeinsamen Flags aber selbst.\n` +
        `Nimm \`parseProdWriteArgs\` aus derselben SSoT:\n  ${ohneParser.join("\n  ")}`,
    ).toEqual([]);
  });

  it("die Gate-SSoT existiert und wird wirklich benutzt", () => {
    // Gegenprobe: der Waechter waere wertlos, wenn der Gate-Name nie vorkaeme
    // (Tippfehler, umbenannte Funktion) — dann waere jede Datei „ungegatet"
    // oder, schlimmer, die Suche liefe ins Leere.
    const ssot = inhalt("server/scripts/lib/prod-write-gate.ts");
    expect(ssot).toContain(`export async function ${GATE}`);
  });
});
