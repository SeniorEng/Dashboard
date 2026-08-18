import { describe, expect, it } from "vitest";
import { collectScanFiles, stripComments } from "./guard-helpers";
import {
  INVOICE_STATUS_REVERSAL_TRANSITIONS,
  INVOICE_STATUS_TRANSITIONS,
  isAllowedInvoiceStatusTransition,
  statusesAllowedToReverseTo,
  statusesAllowedToTransitionTo,
} from "@shared/domain/invoice-status";
import { INVOICE_STATUSES, LEGACY_INVOICE_STATUSES } from "@shared/schema/billing";

/**
 * EIN Übergangs-Regime für alle Schreibpfade (Ziel-Spec, Abschnitt 4).
 *
 * ── Der Zustand, den das ablöst ─────────────────────────────────────────
 * Bis zum Status-Umbau gab es ZWEI Regime: der manuelle Weg
 * (`PATCH /billing/:id/status`, `POST /bulk-status`) ging über
 * `isAllowedInvoiceStatusTransition`, der Zahlungsabgleich über sechs eigene
 * Direkt-Updates mit handgeschriebener Statusliste — inklusive Werten, die es
 * nach dem Umbau nicht mehr gibt.
 *
 * Die Übergangs-SSoT beschrieb damit nur die halbe Wirklichkeit. Wer sie las
 * und für vollständig hielt, irrte (Bestandsaufnahme, W3).
 *
 * ── Was dieser Wächter prüft ────────────────────────────────────────────
 * Nicht, dass jeder Schreibpfad durch dieselbe FUNKTION geht — die
 * Compare-and-Swap-Pfade des Zahlungsabgleichs behalten bewusst ihr
 * `WHERE status IN (…)`-Muster, weil es atomar ist. Geprüft wird, dass die
 * LISTE der zulässigen Ausgangs-Status nirgends mehr handgeschrieben steht.
 */

/** Dateien, in denen eine Status-Literalliste legitim ist. */
const ERLAUBT = new Set<string>([
  // Die SSoT selbst.
  "shared/domain/invoice-status.ts",
  // Das Enum und die Grenze.
  "shared/schema/billing.ts",
  // Der Einmal-Lauf bildet ausdrücklich Altwerte ab.
  "server/scripts/migrate-invoice-status-model.ts",
  // Der manuelle Status-Endpoint: sein Zod-Schema zählt auf, welche Ziele ein
  // MENSCH überhaupt anfragen darf — eine engere Frage als „welche Übergänge
  // sind zulässig". `storniert` läuft über den Storno-Flow, `abgeschlossen`
  // entsteht nur bei Storno-Dokumenten; beide gehören nicht in ein
  // Eingabe-Schema. Der eigentliche Übergang wird danach trotzdem über die
  // SSoT geprüft.
  "server/routes/billing.ts",
]);

/**
 * Eine Aufzählung von zwei oder mehr Status-Literalen in einem Array —
 * das Muster der handgeschriebenen Liste.
 *
 * Bewusst nur die EINDEUTIGEN Status: `abgeschlossen` und `storniert` sind
 * zugleich Cluster-Werte (der Status sagt WARUM etwas fertig ist, der Cluster
 * DASS). Eine Liste aus nur diesen beiden — etwa die eingeklappten Cluster der
 * Rechnungsliste — ist keine Status-Liste, und der Wächter hat sie in der
 * ersten Fassung fälschlich gemeldet.
 */
/**
 * Status, die AUSSCHLIESSLICH Status sind.
 *
 * `storniert` und `abgeschlossen` fehlen bewusst: sie sind zugleich
 * Cluster-Werte (der Status sagt WARUM etwas fertig ist, der Cluster DASS).
 * Eine Liste aus nur diesen beiden — etwa die eingeklappten Cluster der
 * Rechnungsliste — ist keine Status-Liste, und die erste Fassung des Wächters
 * hat sie fälschlich gemeldet.
 *
 * Aus den KONSTANTEN gebaut, nicht abgeschrieben. Die frühere Fassung führte
 * die Namen als Literal-String; sie wäre einer Änderung an `INVOICE_STATUSES`
 * oder `LEGACY_INVOICE_STATUSES` nicht gefolgt — derselbe Zweitbegriff, gegen
 * den der Wächter selbst gerichtet ist.
 */
const MEHRDEUTIG = new Set(["storniert", "abgeschlossen"]);
const EINDEUTIGE_STATUS = [...INVOICE_STATUSES, ...LEGACY_INVOICE_STATUSES]
  .filter(s => !MEHRDEUTIG.has(s))
  .join("|");
const ALLE_STATUS = [...INVOICE_STATUSES, ...LEGACY_INVOICE_STATUSES].join("|");

/**
 * Eine Aufzählung von zwei oder mehr Status-Literalen — das Muster der
 * handgeschriebenen Liste.
 *
 * ── Was die erste Fassung nicht sah (gemessen) ──────────────────────────
 *  - `["storniert", "versendet"]` — sie verlangte, dass das ERSTE Literal
 *    eindeutig ist; steht ein mehrdeutiger Wert vorn, lief die Liste durch.
 *  - `['versendet', 'bezahlt']` — nur doppelte Anführungszeichen.
 *  - `` sql`status IN ('versendet','bezahlt')` `` — Roh-SQL ohne Array-Klammer.
 *    Der relevanteste Fall: genau diese Form ist im Repo lebendig, und eine
 *    handgeschriebene Statusliste in einem `sql`-Template ist derselbe
 *    Zweitbegriff wie eine im Array.
 *
 * Jetzt: zwei benachbarte Status-Literale in beliebiger Quote-Form, getrennt
 * nur durch ein Komma — Array wie SQL-`IN` —, wobei MINDESTENS eines der
 * beiden eindeutig sein muss.
 */
const Q = `["']`;
const LITERALLISTE = new RegExp(
  `${Q}(?:${EINDEUTIGE_STATUS})${Q}\\s*,\\s*${Q}(?:${ALLE_STATUS})${Q}` +
  `|${Q}(?:${ALLE_STATUS})${Q}\\s*,\\s*${Q}(?:${EINDEUTIGE_STATUS})${Q}`,
  "g",
);

/**
 * Wie weit vor der Liste nach einem Status-Zugriff gesucht wird.
 *
 * ── Warum es diesen Kontext-Anker überhaupt braucht ─────────────────────
 * Rechnungs-STATUS und Pipeline-STUFEN teilen sich Namen: `versendet` und
 * `bezahlt` sind beides. `PIPELINE_STAGES` listet die Stufen mehrzeilig auf und
 * enthält damit wörtlich `"versendet",\n  "bezahlt",` — für ein reines
 * Literal-Muster nicht von einer Status-Liste zu unterscheiden.
 *
 * Die erste Fassung des Wächters umging das, indem sie die Liste an die
 * ARRAY-KLAMMER band: nur ein Array, dessen ERSTES Element ein Status ist,
 * zählte. Das funktionierte (`PIPELINE_STAGES` beginnt mit `"offen"`), war aber
 * ein Zufallstreffer — und es kostete drei echte Fälle: eine Liste, die mit
 * `storniert` beginnt, einfache Anführungszeichen, und Roh-SQL ohne Klammer.
 *
 * Statt der Klammer wird deshalb am Status-ZUGRIFF verankert. Das trifft genau
 * die Frage, um die es geht („wird hier über Status gefiltert?"), und lässt
 * Stufen-Listen in Ruhe, weil dort kein `status` steht.
 */
const KONTEXT_FENSTER = 200;

/**
 * Die zwei Formen, in denen im Repo tatsächlich über Status GEFILTERT wird:
 * der Spaltenzugriff (`invoices.status`, `inArray(invoices.status, […])`) und
 * das Roh-SQL-`IN` (`sql\`status IN (…)\``).
 *
 * Bewusst NICHT das blosse Wort `status`: das stand in der ersten Fassung hier
 * und meldete `STAGE_ORDER` in `termine-tab.tsx`, nur weil zwanzig Zeilen
 * darüber ein `statusFilter`-Prop deklariert ist. Ein Wächter, der Fehlalarme
 * produziert, wird abgeschaltet — dann schützt er gar nichts mehr.
 */
const STATUS_ZUGRIFF = /\.status\b|\bstatus\s+in\s*\(/i;

/**
 * Sucht in BEIDE Richtungen.
 *
 * Die erste Fassung sah nur rueckwaerts — und uebersah damit die
 * natuerlichste Form einer handgeschriebenen Statusliste ueberhaupt: die
 * modul-globale Konstante, die ueber ihrer Verwendung steht.
 *
 *   const OFFENE = ["versendet", "bezahlt"];
 *   …
 *   if (OFFENE.includes(inv.status))   // <- der Zugriff kommt DANACH
 *
 * Stufen-Listen bleiben trotzdem draussen: sie werden ueber `.stage` gelesen,
 * nicht ueber `.status`.
 */
function istStatusKontext(inhalt: string, index: number, laenge: number): boolean {
  const davor = inhalt.slice(Math.max(0, index - KONTEXT_FENSTER), index);
  const danach = inhalt.slice(index + laenge, index + laenge + KONTEXT_FENSTER);
  return STATUS_ZUGRIFF.test(davor) || STATUS_ZUGRIFF.test(danach);
}

describe("Rechnungs-Status — ein Übergangs-Regime", () => {
  it("1 — die Übergangs-Map deckt jeden Status ab", () => {
    // Ohne diese Prüfung könnte ein neuer Status ohne Eintrag bleiben und
    // `isAllowedInvoiceStatusTransition` gäbe für ihn stumm `false` zurück —
    // jeder Wechsel von ihm weg wäre verboten, ohne dass es jemand merkt.
    for (const status of INVOICE_STATUSES) {
      expect(
        Object.prototype.hasOwnProperty.call(INVOICE_STATUS_TRANSITIONS, status),
        `kein Eintrag für "${status}"`,
      ).toBe(true);
    }
  });

  it("2 — die Map nennt nur bekannte Ziele", () => {
    for (const [von, ziele] of Object.entries(INVOICE_STATUS_TRANSITIONS)) {
      for (const ziel of ziele) {
        expect(
          (INVOICE_STATUSES as readonly string[]).includes(ziel),
          `${von} -> ${ziel}`,
        ).toBe(true);
      }
    }
  });

  it("3 — `statusesAllowedToTransitionTo` ist die exakte Umkehrung", () => {
    // Die Compare-and-Swap-Pfade leiten daraus ihre Statusliste ab. Driftete
    // die Umkehrung, wäre der Guard falsch — und zwar in die gefährliche
    // Richtung: eine Rechnung könnte aus einem Zustand heraus bezahlt werden,
    // aus dem sie es nicht dürfte.
    for (const ziel of INVOICE_STATUSES) {
      const erwartet = Object.entries(INVOICE_STATUS_TRANSITIONS)
        .filter(([, ziele]) => ziele.includes(ziel))
        .map(([von]) => von)
        .sort();
      expect(statusesAllowedToTransitionTo(ziel).sort(), `Ziel ${ziel}`).toEqual(erwartet);
    }
  });

  it("4 — nach `bezahlt` führt genau ein Weg: aus `versendet`", () => {
    // Die fachlich wichtigste Zeile der Map, deshalb einzeln festgenagelt.
    // Vor dem Umbau waren es drei (`versendet`, `avis_erhalten`,
    // `teilweise_bezahlt`) — zwei davon gibt es nicht mehr.
    expect(statusesAllowedToTransitionTo("bezahlt")).toEqual(["versendet"]);
  });

  it("5 — terminale Zustände lassen niemanden mehr heraus", () => {
    expect(INVOICE_STATUS_TRANSITIONS.storniert).toEqual([]);
    // Storno-DOKUMENTE entstehen fertig und bewegen sich nicht.
    expect(INVOICE_STATUS_TRANSITIONS.abgeschlossen).toEqual([]);
    expect(isAllowedInvoiceStatusTransition("abgeschlossen", "bezahlt")).toBe(false);
    expect(isAllowedInvoiceStatusTransition("storniert", "versendet")).toBe(false);
  });

  it("7 — die Zahlungs-Ruecknahme ist eng und terminale Zustaende bleiben zu", () => {
    // `bezahlt -> versendet` ist NUR ueber das ausdrueckliche Opt-in erlaubt.
    expect(isAllowedInvoiceStatusTransition("bezahlt", "versendet")).toBe(false);
    expect(isAllowedInvoiceStatusTransition("bezahlt", "versendet", { zahlungsRuecknahme: true })).toBe(true);

    // Und WIRKLICH nur dieser eine Uebergang. Das Opt-in darf kein Generalschluessel
    // sein: eine stornierte Rechnung liesse sich sonst ueber den Zahlungspfad
    // wiederbeleben.
    expect(isAllowedInvoiceStatusTransition("storniert", "versendet", { zahlungsRuecknahme: true })).toBe(false);
    expect(isAllowedInvoiceStatusTransition("abgeschlossen", "versendet", { zahlungsRuecknahme: true })).toBe(false);
    expect(isAllowedInvoiceStatusTransition("bezahlt", "entwurf", { zahlungsRuecknahme: true })).toBe(false);

    expect(Object.keys(INVOICE_STATUS_REVERSAL_TRANSITIONS)).toEqual(["bezahlt"]);
    expect(statusesAllowedToReverseTo("versendet")).toEqual(["bezahlt"]);
  });

  it("8 — `zahlungsRuecknahme` wird NUR an den Qonto-Ruecknahmestellen gesetzt", () => {
    // ── Warum dieser Waechter noetig ist ─────────────────────────────────
    // Die eigene Ruecknahme-Map wurde damit begruendet, die Regel NICHT fuer
    // alle aufzuweichen: `bezahlt -> versendet` ist legitim, wenn eine
    // gebundene Zahlung wegfaellt, aber nicht als Handgriff im Status-Menue,
    // sonst verschleiert er einen Zahlungseingang.
    //
    // Diese Begruendung traegt nur, solange das Flag an genau den Stellen
    // steht, die eine Zahlungsbindung loesen. Es ist aber ein Parameter am
    // BREIT genutzten Engpass `updateInvoiceStatusTx` — jeder kuenftige
    // Aufrufer koennte es mitgeben. Bis hierhin hielt das nichts fest ausser
    // Prosa.
    const ERLAUBTE_SETZER = new Set<string>([
      // Die SSoT selbst (Definition + Signatur).
      "shared/domain/invoice-status.ts",
      // Der Engpass, der den Parameter durchreicht.
      "server/storage/billing-storage.ts",
      // Der Qonto-Unmatch: loest eine Zahlungsbindung.
      "server/routes/admin/qonto.ts",
    ]);

    const treffer: string[] = [];
    for (const { rel, content } of collectScanFiles(["server", "shared", "client/src"], { includeTsx: true })) {
      if (ERLAUBTE_SETZER.has(rel)) continue;
      if (/zahlungsRuecknahme/.test(stripComments(content))) treffer.push(rel);
    }

    if (treffer.length > 0) {
      expect.fail(
        "`zahlungsRuecknahme` ausserhalb der Ruecknahme-Pfade gefunden:\n" +
        treffer.map(t => `  - ${t}`).join("\n") +
        "\n\nDas Opt-in schaltet `bezahlt -> versendet` frei — den Uebergang, den die " +
        "Uebergangs-SSoT dem manuellen Weg bewusst verwehrt. Wer es woanders braucht, " +
        "beschreibt zuerst, warum das keine Verschleierung eines Zahlungseingangs ist.",
      );
    }
  });

  it("6 — keine handgeschriebene Status-Liste ausserhalb der SSoT", () => {
    const treffer: string[] = [];
    for (const { rel, content } of collectScanFiles(["server", "shared", "client/src"], { includeTsx: true })) {
      if (ERLAUBT.has(rel)) continue;
      // Kommentare zaehlen nicht — dort duerfen Status genannt werden.
      // `stripComments` aus den guard-helpers statt Eigenbau: die frühere
      // Eigenbau-Variante strippte nur GANZE Kommentarzeilen (`^\s*//`), ein
      // NACHGESTELLTER Kommentar blieb stehen und löste Fehlalarm aus.
      const inhalt = stripComments(content);
      LITERALLISTE.lastIndex = 0;
      for (let m = LITERALLISTE.exec(inhalt); m; m = LITERALLISTE.exec(inhalt)) {
        if (istStatusKontext(inhalt, m.index, m[0].length)) { treffer.push(rel); break; }
      }
    }

    if (treffer.length > 0) {
      expect.fail(
        "Handgeschriebene Status-Liste gefunden:\n" +
        treffer.map(t => `  - ${t}`).join("\n") +
        "\n\nDie zulaessigen Ausgangs-Status kommen aus `statusesAllowedToTransitionTo` " +
        "(shared/domain/invoice-status.ts). Genau solche Listen sind beim Umbau an " +
        "sechs Stellen mit Werten stehengeblieben, die es nicht mehr gab.",
      );
    }
  });
});
