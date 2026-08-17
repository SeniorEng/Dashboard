import { describe, expect, it } from "vitest";
import { collectScanFiles } from "./guard-helpers";
import {
  INVOICE_STATUS_TRANSITIONS,
  isAllowedInvoiceStatusTransition,
  statusesAllowedToTransitionTo,
} from "@shared/domain/invoice-status";
import { INVOICE_STATUSES } from "@shared/schema/billing";

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
const EINDEUTIGE_STATUS = "entwurf|versendet|bezahlt|avis_erhalten|teilweise_bezahlt";
const LITERALLISTE = new RegExp(
  `\\[\\s*"(${EINDEUTIGE_STATUS})"\\s*,\\s*"(${EINDEUTIGE_STATUS}|storniert|abgeschlossen)"`,
);

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

  it("6 — keine handgeschriebene Status-Liste ausserhalb der SSoT", () => {
    const treffer: string[] = [];
    for (const { rel, content } of collectScanFiles(["server", "shared", "client/src"], { includeTsx: true })) {
      if (ERLAUBT.has(rel)) continue;
      // Kommentare zaehlen nicht — dort duerfen Status genannt werden.
      const inhalt = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (LITERALLISTE.test(inhalt)) treffer.push(rel);
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
