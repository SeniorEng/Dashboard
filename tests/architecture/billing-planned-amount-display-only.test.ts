/**
 * Task #1905 — Wächter: der PLAN-Betrag bleibt ein reiner Anzeigewert.
 *
 * Die Karte „Noch zu erstellen" zeigt je Kunde IST und PLAN
 * (`actualAmountCents` / `plannedAmountCents`, siehe `shared/api/billing.ts`).
 * IST ist geleistete, noch nicht abgerechnete Arbeit und stammt aus derselben
 * SSoT wie die Rechnung. PLAN ist eine PROGNOSE über noch nicht durchgeführte
 * Termine — bepreist über `priceFor`, aber ohne jede Leistungserbringung
 * dahinter.
 *
 * Genau deshalb darf PLAN nie in einen schreibenden Pfad geraten: eine Rechnung,
 * eine Budget-Buchung oder ein Leistungsnachweis, der einen Prognose-Betrag
 * enthält, weist Geld aus, das niemand erbracht hat (GoBD: es gibt keinen Beleg
 * für eine geplante Leistung). Der Fehler wäre still — die Zahl sieht aus wie
 * jede andere Cent-Zahl.
 *
 * Der Wächter zieht die Grenze am Feldnamen: `plannedAmountCents` darf
 * ausschließlich dort vorkommen, wo der Anzeige-Wert entsteht bzw. gerendert
 * wird (Typ/Schema, der Lese-Endpunkt `/billing/eligible-customers`, die Karte).
 * Jede Erwähnung in Rechnungs-/Buchungs-/Nachweis-Code ist eine Verletzung.
 *
 * Der Detektor ist PUR und wird vom Real-Tree-Scan UND vom Negativ-Test mit
 * DERSELBEN Funktion aufgerufen — der Negativ-Test beweist, dass eine bewusste
 * Verletzung CI bricht.
 *
 * GRENZE DIESES WÄCHTERS (bewusst, damit das grüne Gate nicht stärker gelesen
 * wird, als es ist): Er ist ein Namens-Stolperdraht, KEINE Taint-Analyse. Er
 * sucht das Literal `plannedAmountCents`. Ein `{ ...customer }`-Spread in einen
 * Schreibpfad, oder eine Zwischenvariable, die den Wert innerhalb einer
 * ALLOWED-Datei aus dem Feld heraushebt, sähe er NICHT. Heute existiert kein
 * solcher Weg — an die Erstellung geht ausschließlich `c.id` bzw. `customerIds`,
 * nie das Kunden-Item selbst. Wer das ändert, muss diesen Wächter mit ändern; er
 * fängt den Fall nicht von allein.
 */
import { describe, it, expect } from "vitest";
import {
  collectScanFiles,
  stripComments,
  type ScanFile,
  type GuardViolation,
} from "./guard-helpers";

/** Das Feld, das die Prognose trägt. */
const PLANNED_FIELD = "plannedAmountCents";

/**
 * Dateien, die den PLAN-Wert erzeugen oder anzeigen dürfen:
 *  • `shared/api/billing.ts` / `shared/api/openapi.ts` — Typ + Response-Schema.
 *  • `server/routes/billing.ts` — der Lese-Endpunkt, der ihn berechnet.
 *  • die Karte — die einzige Stelle, die ihn rendert/summiert.
 */
const ALLOWED = [
  "shared/api/billing.ts",
  "shared/api/openapi.ts",
  "server/routes/billing.ts",
  "client/src/features/billing/components/pending-invoices-card.tsx",
  // 6hJRF6h8 — die Betrags-Berechnung ist aus `/billing/eligible-customers`
  // herausgeloest, weil sie dort pro Kunde einen vollen `buildInvoiceDraft`
  // kostete und den ersten Load blockierte. Der PLAN-Wert wechselt damit die
  // Datei, NICHT die Rolle: beide Neuzugaenge sind reine Lese-/Anzeige-Wege.
  //
  //  * der Service RECHNET den Wert (wie vorher der Endpunkt) und gibt ihn
  //    zurueck — er schreibt nichts, kein Insert/Update, keine Rechnung.
  //  * der Query-Hook HOLT ihn und reicht ihn an die Karte.
  //
  // Die Zusage aus dem Kopfkommentar bleibt damit unveraendert: an die
  // Erstellung geht ausschliesslich `c.id` bzw. `customerIds`, nie das
  // Kunden-Item selbst.
  "server/services/billing-customer-amounts.ts",
  "client/src/features/billing/hooks/use-billing-queries.ts",
];

/**
 * Schreibende/belegende Bereiche, in denen der PLAN-Wert nichts zu suchen hat.
 * Bewusst breit: Rechnungs-Erzeugung, Budget-Ledger, Leistungsnachweise, PDF-
 * und ZUGFeRD-Rendering.
 */
const WRITE_PATH_PREFIXES = [
  "server/services/invoice-",
  "server/services/zugferd",
  "server/storage/budget/",
  "server/storage/service-records",
  "server/lib/pdf",
  "shared/domain/budget",
  "shared/domain/invoice-line-items",
];

export function findPlannedAmountLeaks(files: ScanFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const f of files) {
    if (ALLOWED.includes(f.rel)) continue;
    const src = stripComments(f.content);
    if (!src.includes(PLANNED_FIELD)) continue;
    const isWritePath = WRITE_PATH_PREFIXES.some((p) => f.rel.startsWith(p));
    const lines = src.split("\n");
    const line = lines.findIndex((l) => l.includes(PLANNED_FIELD)) + 1;
    violations.push({
      file: f.rel,
      line,
      detail: isWritePath
        ? `${PLANNED_FIELD} (PROGNOSE) erscheint in einem schreibenden/belegenden Pfad — ein geplanter Betrag darf nie abgerechnet, gebucht oder auf einen Nachweis gedruckt werden.`
        : `${PLANNED_FIELD} (PROGNOSE) erscheint außerhalb der erlaubten Anzeige-Dateien. Wenn das beabsichtigt ist, die Datei bewusst in ALLOWED aufnehmen — und dabei prüfen, dass sie wirklich nichts schreibt.`,
    });
  }
  return violations;
}

describe("Task #1905 — PLAN-Betrag ist reiner Anzeigewert (GoBD)", () => {
  it("kein Vorkommen von plannedAmountCents außerhalb der Anzeige-Dateien", () => {
    const files = collectScanFiles(["server", "shared", "client/src"], {
      includeTsx: true,
    });
    // Sicherung gegen einen leeren Scan (falsch-grüner Wächter).
    expect(files.length).toBeGreaterThan(100);
    const violations = findPlannedAmountLeaks(files);
    expect(
      violations,
      violations.map((v) => `${v.file}:${v.line} — ${v.detail}`).join("\n"),
    ).toEqual([]);
  });

  it("Negativ-Test: eine Rechnungszeile aus dem PLAN-Betrag bricht das Gate", () => {
    const violations = findPlannedAmountLeaks([
      {
        rel: "server/services/invoice-calc.ts",
        content: "const gross = customer.plannedAmountCents;",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("server/services/invoice-calc.ts");
    expect(violations[0].detail).toContain("schreibenden");
  });

  it("Negativ-Test: eine reine Kommentar-Erwähnung bricht das Gate NICHT", () => {
    const violations = findPlannedAmountLeaks([
      {
        rel: "server/services/invoice-calc.ts",
        content: "// plannedAmountCents wird hier bewusst NICHT gelesen\nconst x = 1;",
      },
    ]);
    expect(violations).toEqual([]);
  });
});
