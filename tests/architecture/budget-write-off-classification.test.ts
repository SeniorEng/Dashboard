/**
 * Task #727 — Phase 1.3 Architecture-Test: `write_off`-Asymmetrie.
 *
 * Hintergrund (siehe `docs/budget-ssot-inventory.md` §1.4 + §7 Beschluss #9):
 * `write_off` modelliert zwei Sichten gleichzeitig:
 *  - **Topf-/Allocation-Sicht**: zählt als Used (Geld ist aus dem Topf raus).
 *  - **Fenster-Cap-Sicht**: zählt NICHT als Used (kein Termin-Consumption
 *    im Fenster).
 *
 * Damit jede neue Call-Site sich aktiv für eine Sicht entscheidet — und
 * nicht versehentlich `write_off` mit `consumption` in einer Sicht aggregiert,
 * in die es nicht gehört — pflegen wir eine Allowlist pro Datei. Jede Datei
 * im Server/Shared-Code, die `'write_off'` mit `transactionType` kombiniert
 * (Filter, Pattern-Match oder direkter String-Vergleich), MUSS in der
 * Allowlist mit ihrer Klassifizierung stehen.
 *
 * Failure-Modus: Test schlägt fehl mit der Liste neuer Dateien und einer
 * Erklärung der Asymmetrie. Behebung: in der Allowlist eintragen UND die
 * Audit-Tabelle in `docs/budget-ssot-inventory.md` §1.4 / Phase 1.2 ergänzen.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

type WriteOffView = "allocation-view" | "window-view" | "schema-only" | "both";

/**
 * Allowlist: jede Datei, die `'write_off'` in `transactionType`-Kontext
 * verwendet, muss hier mit ihrer Sicht-Klassifizierung stehen. Quelle der
 * Klassifizierung: Audit-Tabelle in `docs/budget-ssot-inventory.md` §1.4
 * (Phase 1.2 Beschluss).
 */
const ALLOWLIST: Record<string, WriteOffView> = {
  // Topf-Aggregat: `getBudgetSummary` (§45b) summiert
  //   consumption + write_off + manual_adjustment − reversal.
  // Zusätzlich `getAvailableCarryoverCents` (Pro-Allocation-Rest).
  "server/storage/budget/summary-queries.ts": "allocation-view",

  // FIFO-Carryover-Verbrauch pro Spezial-Allokation; spiegelt
  // Topf-Sicht.
  "server/storage/budget/consumption-engine.ts": "allocation-view",

  // Topf-Bewegungs-Aggregate ÜBER `consumption/write_off/reversal` und
  // Schreib-Stelle der `processExpiredCarryover`-Verfallsbuchung.
  "server/storage/budget/allocation-storage.ts": "allocation-view",

  // Task #874 — DER eine Verfügbarkeits-Reader: „Verfügbar zum Buchungsdatum"
  // (`netConsumedUpToDate`). write_off vor dem Buchungsdatum hat den Pot
  // entwertet, zählt also als Used. `import-availability.ts` delegiert seit
  // Phase 4 nur noch hierhin und referenziert `write_off` selbst nicht mehr.
  "server/storage/budget/unified-reader.ts": "allocation-view",

  // Phase 1.3 — pure History-Aggregation exponiert beide Sichten gleichzeitig
  // (Topologie ist „both"): die Entscheidung, welche Sicht eine UI verwendet,
  // fällt erst beim Reduzieren der Buckets (siehe `sumAllocationView`). Der
  // DB-Wrapper in `server/storage/budget/history-aggregation.ts` delegiert
  // ohne eigene `write_off`-Klassifizierung an die pure Funktion und steht
  // deshalb NICHT in der Allowlist.
  //
  // Fenster-Cap-Sicht (`cap-calculator.ts`, `cap-math.ts`) referenziert
  // `write_off` bewusst nur in Kommentaren ohne String-Literal — die
  // Asymmetrie-Regel verhindert, dass dort jemals ein `'write_off'`-Filter
  // auftaucht. Wenn das passiert, MUSS der Test feuern.
  "shared/domain/budget/history-aggregation.ts": "both",

  // Schema-Definition (Enum-Werte) — keine Aggregations-Entscheidung.
  "shared/schema/budget.ts": "schema-only",
};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

describe("Architektur — `write_off`-Asymmetrie (Task #727 Phase 1.3)", () => {
  it("Jede Call-Site, die `transactionType` mit 'write_off' kombiniert, ist klassifiziert", () => {
    const scanRoots = ["server", "shared"].map((p) => join(ROOT, p));
    const hits = new Set<string>();

    // Trefferbedingung: Datei enthält `'write_off'` (String oder doppelt
    // gequotet) UND irgendwo `transactionType`. Damit triggern wir bei
    // SQL-Listen (`transactionType IN ('consumption', 'write_off')`),
    // direkten Vergleichen (`tx.transactionType === "write_off"`) und
    // Schema-Enums.
    const writeOffRe = /['"]write_off['"]/;
    const txTypeRe = /transactionType/;

    for (const root of scanRoots) {
      try {
        statSync(root);
      } catch {
        continue;
      }
      for (const file of walk(root)) {
        const rel = relative(ROOT, file).split(sep).join("/");
        // Tests und Wartungs-Skripte sind keine produktiven Aggregations-
        // Sichten — sie dürfen frei mit write_off arbeiten.
        if (rel.startsWith("tests/")) continue;
        if (rel.startsWith("server/scripts/")) continue;

        const content = readFileSync(file, "utf-8");
        if (!writeOffRe.test(content)) continue;
        if (!txTypeRe.test(content)) continue;

        hits.add(rel);
      }
    }

    const unexpected = [...hits].filter((f) => !(f in ALLOWLIST)).sort();
    const stale = Object.keys(ALLOWLIST).filter((f) => !hits.has(f)).sort();

    if (unexpected.length > 0) {
      expect.fail(
        `Folgende Dateien aggregieren \`write_off\` mit \`transactionType\`, ` +
          `sind aber nicht in der \`write_off\`-Sicht-Allowlist klassifiziert:\n` +
          unexpected.map((f) => `  ${f}`).join("\n") +
          `\n\nKontext: \`write_off\` zählt in der **Topf-/Allocation-Sicht** ` +
          `als Used, NICHT in der **Fenster-Cap-Sicht** ` +
          `(siehe docs/budget-ssot-inventory.md §1.4). Trage die Datei mit ` +
          `ihrer Sicht in \`ALLOWLIST\` ein und ergänze die Audit-Tabelle in ` +
          `docs/budget-ssot-inventory.md.`,
      );
    }
    if (stale.length > 0) {
      expect.fail(
        `Folgende Dateien stehen in der \`write_off\`-Allowlist, referenzieren ` +
          `aber kein \`write_off\` + \`transactionType\` mehr:\n` +
          stale.map((f) => `  ${f}`).join("\n") +
          `\n\nEntferne den Eintrag aus \`ALLOWLIST\` und passe die Audit-Tabelle ` +
          `in docs/budget-ssot-inventory.md an.`,
      );
    }
  });
});
