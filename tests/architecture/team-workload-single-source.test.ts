/**
 * Task #1642 — Architektur-Test: die Team-Kapazitäts-/Auslastungs-Rechnung
 * lebt in genau EINER SSoT (`shared/domain/team-workload.ts`,
 * `computeTeamWorkload`).
 *
 * Hintergrund: Früher gab es DREI parallel gepflegte Kapazitäts-Rechner, die
 * bereits gegeneinander abgedriftet waren — server `computeSollIst` (nur Tests),
 * client `deriveSollIst` (Team-Auslastung-Seite) und client
 * `computeWorkloadMetrics` (Benutzerverwaltung). Sie wurden auf die eine SSoT
 * `computeTeamWorkload` konsolidiert; beide Anzeige-Consumer sind seitdem nur
 * noch dünne Adapter (`team-workload-view.ts`, `components/workload-metrics.ts`),
 * die ausschließlich `computeTeamWorkload` aufrufen.
 *
 * Diese Schranke verhindert, dass ein späterer Change still eine ZWEITE,
 * hand-gerechnete Kapazitäts-Berechnung außerhalb der SSoT einführt und die
 * beiden Views wieder auseinanderlaufen ("Eine SSoT pro fachlicher Frage").
 *
 * Was geprüft wird: Es darf keine Funktion geben, deren NAME auf eine der
 * Kapazitäts-/Auslastungs-/Soll-Ist-/Free-Capacity-Kategorien passt und die
 * AUSSERHALB von `shared/domain/team-workload.ts` (bzw. der Allowlist) liegt.
 * Die Erkennung nutzt `ast-grep` (echte Funktions-Knoten, keine Treffer in
 * Kommentaren/Strings), analog zu `calculations-in-shared.test.ts`.
 *
 * Failure-Modus: Test schlägt fehl mit der Liste der Treffer und dem Hinweis,
 * die Berechnung in `shared/domain/team-workload.ts` zu verankern und die Views
 * über `computeTeamWorkload` zu bedienen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import {
  ROOT,
  walkTsFiles,
  parseSource,
  collectNamedFunctions,
} from "./ast-grep-helpers";

// Die kanonische Heimat der Kapazitäts-/Auslastungs-Rechnung.
const CANONICAL = "shared/domain/team-workload.ts";

// Hotspot-Namensmuster: passt der DEKLARIERTE Funktionsname auf eines davon,
// MUSS die Funktion in der kanonischen SSoT wohnen. Bewusst auf die
// Kapazitäts-SEMANTIK gepinnt (Soll/Ist, Auslastung/Kapazität, committed/
// free-capacity, Überlast) — NICHT auf das generische Wort „Workload", damit
// die legitimen Adapter (`computeWorkloadMetrics`, `metricsFromEntry`,
// `selectTeamWorkloadRows`), die nur `computeTeamWorkload` aufrufen, nicht
// fälschlich zünden.
const CAPACITY_NAME_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /^(compute|calculate|derive|resolve).*SollIst/i, reason: "Soll/Ist-Kapazität" },
  {
    regex: /^(compute|calculate|derive|resolve).*(Auslastung|Utilization|Capacity|Kapazit)/i,
    reason: "Auslastung/Kapazität",
  },
  {
    regex:
      /^(compute|calculate|derive|resolve).*(Committed(Hours)?|FreieStunden|FreieKunden|FreeHours|FreeClients|FreeCapacity|Ueberlast|Overload)/i,
    reason: "committed-/free-capacity-Mathe",
  },
];

// Pfade, die explizit erlaubt sind: die kanonische SSoT selbst, Tests und
// Build-Artefakte. Die Adapter-Dateien stehen bewusst NICHT hier — ihre
// Funktionsnamen passen ohnehin nicht auf die Muster, und würden sie es tun
// (= wieder hand-gerechnete Kapazitäts-Mathe), soll der Test zuschlagen.
const ALLOWED_PATHS = [CANONICAL, "tests/", "dist/", "node_modules/"];

function relOf(absPath: string): string {
  return relative(ROOT, absPath).split(sep).join("/");
}

function shouldSkip(absPath: string): boolean {
  const rel = relOf(absPath);
  return ALLOWED_PATHS.some((p) => rel.startsWith(p));
}

/**
 * Scannt eine Quelldatei nach benannten Funktionen, deren Name auf ein
 * Kapazitäts-/Auslastungs-Hotspot-Muster passt. Als pure Funktion
 * herausgezogen, damit gepflanzte Verletzungen im Test gegen sie geprüft
 * werden können.
 */
function findCapacityCalcFunctions(
  content: string,
  isTsx: boolean,
): Array<{ line: number; name: string; reason: string }> {
  const fns = collectNamedFunctions(parseSource(content, isTsx));
  const out: Array<{ line: number; name: string; reason: string }> = [];
  for (const fn of fns) {
    for (const { regex, reason } of CAPACITY_NAME_PATTERNS) {
      if (regex.test(fn.name)) {
        out.push({ line: fn.line, name: fn.name, reason });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Task #1643 — Ausdrucks-/Inhalts-basierte Schranke.
//
// Die Namens-Schranke oben zündet nur, wenn eine NEUE Funktion mit
// kapazitäts-verdächtigem NAMEN außerhalb der SSoT auftaucht. Sie lässt aber
// einen realen Drift-Pfad offen: dieselbe Kapazitäts-Arithmetik INLINE in eine
// bestehende, harmlos benannte Funktion (z. B. in die dünnen Adapter
// `metricsFromEntry`/`computeWorkloadMetrics` oder in eine Page-Komponente)
// hineinzuschreiben. Diese zweite Schranke erkennt die charakteristischen
// Kapazitäts-FORMELN selbst — unabhängig vom Funktionsnamen.
//
// Erlaubt bleibt das reine LESEN der SSoT-Ausgaben per Dot-Access
// (`metrics.pct`, `m.addClients`, `Math.round(m.committedHours * 10) / 10`) —
// das kombiniert keine zwei Kapazitäts-Größen neu. Verboten ist das
// Neu-Berechnen (zwei Kapazitäts-Operanden per `-`/`/`/`* 100`/`Math.floor`
// bzw. die Minuten→Stunden-Umrechnung der Kapazitäts-Minuten).
// ---------------------------------------------------------------------------

/**
 * Blankt Kommentare und String-/Template-Literale eines Quelltexts aus
 * (ersetzt sie durch Leerzeichen, Zeilenumbrüche bleiben erhalten), damit die
 * Formel-Regexe NICHT in Kommentaren/Strings zünden (analog zur AST-Awareness
 * der übrigen Fitness-Functions). Zeichen-Offsets/Zeilennummern bleiben stabil.
 */
function stripCommentsAndStrings(content: string, isTsx: boolean): string {
  const root = parseSource(content, isTsx);
  const chars = content.split("");
  const blank = (kind: string) => {
    for (const n of root.findAll({ rule: { kind } })) {
      const r = n.range();
      for (let i = r.start.index; i < r.end.index && i < chars.length; i++) {
        if (chars[i] !== "\n") chars[i] = " ";
      }
    }
  };
  for (const kind of ["comment", "string", "template_string"]) blank(kind);
  return chars.join("");
}

/** 1-basierte Zeilennummer für einen Zeichen-Offset im (unveränderten) Text. */
function lineAtIndex(code: string, index: number): number {
  let line = 1;
  const end = Math.min(index, code.length);
  for (let i = 0; i < end; i++) if (code[i] === "\n") line++;
  return line;
}

export interface CapacityFormulaHit {
  line: number;
  reason: string;
  snippet: string;
}

// Operanden-Stichwörter, die einen Term als Team-Kapazitäts-Größe ausweisen.
// Bewusst team-spezifisch (`usedAll`, nicht `used`), damit fremde Domänen-Mathe
// (z. B. Budget `netUsedInWindowCents`) NICHT fälschlich zündet.
const CAP_OPERAND = /(soll|committed|usedAll|perClient|free|frei)/i;

/**
 * Findet inline hand-gerechnete Team-Kapazitäts-Formeln in einer Quelldatei.
 * Als pure Funktion herausgezogen, damit gepflanzte Verletzungen (und die
 * echten Adapter) im Test dagegen geprüft werden können.
 */
function findInlineCapacityFormulas(
  content: string,
  isTsx: boolean,
): CapacityFormulaHit[] {
  const code = stripCommentsAndStrings(content, isTsx);
  const hits: CapacityFormulaHit[] = [];
  const add = (index: number | undefined, reason: string, snippet: string) => {
    hits.push({ line: lineAtIndex(code, index ?? 0), reason, snippet: snippet.trim() });
  };

  // Detektor A — freie/über Stunden: Math.max(0, <cap> - <cap>).
  // SSoT: Math.max(0, sollHours - usedAllHours) / Math.max(0, committedHours - sollHours).
  {
    const re =
      /Math\s*\.\s*max\s*\(\s*0\s*,\s*([A-Za-z_$][\w$.]*)\s*-\s*([A-Za-z_$][\w$.]*)\s*\)/g;
    for (const m of code.matchAll(re)) {
      if (CAP_OPERAND.test(m[1]) && CAP_OPERAND.test(m[2])) {
        add(m.index, "freie/über Stunden (Math.max(0, soll − used))", m[0]);
      }
    }
  }

  // Detektor B — Auslastung: <committed|ist> / <soll> * 100.
  // SSoT: (committedHours / sollHours) * 100.
  {
    const re =
      /([A-Za-z_$][\w$.]*)\s*\/\s*([A-Za-z_$][\w$.]*)\s*\)?\s*\*\s*100\b/g;
    for (const m of code.matchAll(re)) {
      if (/(committed|ist)/i.test(m[1]) && /soll/i.test(m[2])) {
        add(m.index, "Auslastung (committed / soll * 100)", m[0]);
      }
    }
  }

  // Detektor C — Zusatzkunden: Math.floor(<free> / <perClient>).
  // SSoT: Math.floor(freeHours / perClientHours).
  {
    const re =
      /Math\s*\.\s*floor\s*\(\s*([A-Za-z_$][\w$.]*)\s*\/\s*([A-Za-z_$][\w$.]*)\s*\)/g;
    for (const m of code.matchAll(re)) {
      if (/(free|frei)/i.test(m[1]) && /perClient/i.test(m[2])) {
        add(m.index, "Zusatzkunden (Math.floor(free / perClient))", m[0]);
      }
    }
  }

  // Detektor D — Minuten→Stunden auf KAPAZITÄTS-Minuten: <capMinutes> / 60.
  // SSoT: input.avgProdPerformedHwMinutes / 60 etc. Bewusst an die
  // Kapazitäts-Minuten-Semantik gepinnt (prod/overhead/sickVac/committed),
  // damit generische Minuten→Stunden-Umrechnungen anderswo NICHT zünden.
  {
    const re =
      /([A-Za-z_$][\w$.]*(?:prodPerformed|prodHv|avgProd|avgOverhead|avgSickVac|committed)[\w$.]*(?:Minutes|Minuten))\s*\/\s*60\b/gi;
    for (const m of code.matchAll(re)) {
      add(m.index, "Minuten→Stunden auf Kapazitäts-Minuten (…Minutes / 60)", m[0]);
    }
  }

  return hits;
}

describe("Architektur — Team-Kapazitäts-Rechnung nur in shared/domain/team-workload.ts (Task #1642)", () => {
  it("die kanonische SSoT existiert und exportiert computeTeamWorkload", () => {
    const canonical = readFileSync(join(ROOT, CANONICAL), "utf-8");
    expect(canonical).toMatch(/export function computeTeamWorkload\b/);
  });

  it("keine hand-gerechnete Kapazitäts-/Auslastungs-Berechnung außerhalb der SSoT", () => {
    const hits: Array<{ file: string; line: number; name: string; reason: string }> = [];
    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try {
        statSync(root);
      } catch {
        continue;
      }
      for (const file of walkTsFiles(root, { includeTsx: true })) {
        if (shouldSkip(file)) continue;
        const content = readFileSync(file, "utf-8");
        for (const h of findCapacityCalcFunctions(content, file.endsWith(".tsx"))) {
          hits.push({ file: relOf(file), ...h });
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits
        .map((h) => `  ${h.file}:${h.line} — ${h.name} (${h.reason})`)
        .join("\n");
      expect.fail(
        `Folgende Funktionen implementieren Team-Kapazitäts-/Auslastungs-Mathe ` +
          `außerhalb von '${CANONICAL}':\n${msg}\n\n` +
          `Es gibt genau EINE SSoT für die Frage "Wer ist überlastet, wer kann ` +
          `noch Kunden übernehmen?": \`computeTeamWorkload\` in '${CANONICAL}'. ` +
          `Verankere die Berechnung dort und bediene die Views (Team-Auslastung ` +
          `UND Benutzerverwaltung) über diese Funktion — baue keine zweite, ` +
          `hand-gerechnete Kapazitäts-Berechnung, sonst driften die Views wieder ` +
          `auseinander.`,
      );
    }
  });

  describe("Selbsttest der Hotspot-Erkennung (gepflanzte Verletzungen)", () => {
    it("erwischt einen wieder-eingeführten deriveSollIst-Rechner", () => {
      const planted = [
        "export function deriveSollIst(soll: number, ist: number) {",
        "  const free = Math.max(0, soll - ist);",
        "  return { free, pct: (ist / soll) * 100 };",
        "}",
      ].join("\n");
      const hits = findCapacityCalcFunctions(planted, false);
      expect(hits.map((h) => h.name)).toContain("deriveSollIst");
    });

    it("erwischt einen hand-gerechneten computeAuslastung-Rechner", () => {
      const planted = [
        "export const computeAuslastung = (committed: number, soll: number) => {",
        "  return (committed / soll) * 100;",
        "};",
      ].join("\n");
      const hits = findCapacityCalcFunctions(planted, false);
      expect(hits.map((h) => h.name)).toContain("computeAuslastung");
    });

    it("erwischt einen computeFreieStunden-Rechner", () => {
      const planted = [
        "function computeFreieStunden(soll: number, used: number) {",
        "  return Math.max(0, soll - used);",
        "}",
      ].join("\n");
      const hits = findCapacityCalcFunctions(planted, false);
      expect(hits.map((h) => h.name)).toContain("computeFreieStunden");
    });

    it("lässt die legitimen Adapter-Namen durch (kein Fehlalarm)", () => {
      // Diese Namen bedienen die SSoT nur — sie rechnen keine Kapazität selbst.
      const legit = [
        "export function computeWorkloadMetrics() { return null; }",
        "export function metricsFromEntry() { return null; }",
        "export function selectTeamWorkloadRows() { return []; }",
        "export function computeTeamWorkload() { return null; }",
        "export function generateReport() { return 0; }",
      ].join("\n");
      expect(findCapacityCalcFunctions(legit, false)).toHaveLength(0);
    });
  });

  it("keine inline hand-gerechnete Kapazitäts-Formel außerhalb der SSoT (Task #1643)", () => {
    const hits: Array<{ file: string; line: number; reason: string; snippet: string }> = [];
    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try {
        statSync(root);
      } catch {
        continue;
      }
      for (const file of walkTsFiles(root, { includeTsx: true })) {
        if (shouldSkip(file)) continue;
        const content = readFileSync(file, "utf-8");
        for (const h of findInlineCapacityFormulas(content, file.endsWith(".tsx"))) {
          hits.push({ file: relOf(file), ...h });
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits
        .map((h) => `  ${h.file}:${h.line} — ${h.reason} [${h.snippet}]`)
        .join("\n");
      expect.fail(
        `Folgende Stellen rechnen eine Team-Kapazitäts-Formel INLINE nach — ` +
          `außerhalb von '${CANONICAL}':\n${msg}\n\n` +
          `Die Kennzahlen (freie/über Stunden, Auslastung, Zusatzkunden, ` +
          `Minuten→Stunden) kommen ausschließlich aus \`computeTeamWorkload\` ` +
          `in '${CANONICAL}'. Lies die fertigen Werte per Dot-Access ` +
          `(z. B. \`metrics.pct\`, \`m.addClients\`) — kombiniere NICHT zwei ` +
          `Kapazitäts-Größen selbst neu, sonst driften die Views wieder ` +
          `auseinander ("Eine SSoT pro fachlicher Frage").`,
      );
    }
  });

  describe("Selbsttest der Inline-Formel-Erkennung (Task #1643)", () => {
    it("erwischt inline freie/über-Stunden-Mathe in einem harmlos benannten Adapter", () => {
      const planted = [
        "export function metricsFromEntry(soll: number, usedAll: number) {",
        "  const free = Math.max(0, soll - usedAll);",
        "  return { free };",
        "}",
      ].join("\n");
      const hits = findInlineCapacityFormulas(planted, false);
      expect(hits.map((h) => h.reason)).toContain(
        "freie/über Stunden (Math.max(0, soll − used))",
      );
    });

    it("erwischt inline Auslastungs-Mathe (committed / soll * 100)", () => {
      const planted = [
        "function toView(committedHours: number, sollHours: number) {",
        "  return { pct: (committedHours / sollHours) * 100 };",
        "}",
      ].join("\n");
      const hits = findInlineCapacityFormulas(planted, false);
      expect(hits.map((h) => h.reason)).toContain(
        "Auslastung (committed / soll * 100)",
      );
    });

    it("erwischt inline Zusatzkunden-Mathe (Math.floor(free / perClient))", () => {
      const planted = [
        "const addClients = Math.floor(freeHours / perClientHours);",
      ].join("\n");
      const hits = findInlineCapacityFormulas(planted, false);
      expect(hits.map((h) => h.reason)).toContain(
        "Zusatzkunden (Math.floor(free / perClient))",
      );
    });

    it("erwischt inline Minuten→Stunden-Umrechnung auf Kapazitäts-Minuten", () => {
      const planted = [
        "const h = input.avgProdPerformedHwMinutes / 60;",
      ].join("\n");
      const hits = findInlineCapacityFormulas(planted, false);
      expect(hits.map((h) => h.reason)).toContain(
        "Minuten→Stunden auf Kapazitäts-Minuten (…Minutes / 60)",
      );
    });

    it("zündet NICHT in Kommentaren/Strings (AST-aware Stripping)", () => {
      const benign = [
        "// freie = Math.max(0, sollHours - usedAllHours) ist die SSoT-Formel",
        'const doc = "pct = (committedHours / sollHours) * 100";',
        "const ok = 1;",
      ].join("\n");
      expect(findInlineCapacityFormulas(benign, false)).toHaveLength(0);
    });

    it("kein Fehlalarm auf den echten Adaptern (nur SSoT-Lesen per Dot-Access)", () => {
      const adapters = [
        "client/src/features/team/team-workload-view.ts",
        "client/src/features/team/components/workload-metrics.ts",
        "client/src/features/team/components/user-card.tsx",
      ];
      for (const rel of adapters) {
        const content = readFileSync(join(ROOT, rel), "utf-8");
        const hits = findInlineCapacityFormulas(content, rel.endsWith(".tsx"));
        expect(
          hits,
          `Adapter '${rel}' sollte keine inline Kapazitäts-Formel enthalten, ` +
            `fand aber: ${JSON.stringify(hits)}`,
        ).toHaveLength(0);
      }
    });

    it("kein Fehlalarm auf fremder Domänen-Mathe (Budget-Reader liest netUsed…)", () => {
      const foreign = [
        "const capRemaining = Math.max(0, clamped.yearlyLimitCents - input.netUsedInWindowCents);",
        "const util = Math.round((usedCents / allocatedCents) * 100);",
        "const hours = totalMinutes / 60;",
      ].join("\n");
      expect(findInlineCapacityFormulas(foreign, false)).toHaveLength(0);
    });
  });
});
