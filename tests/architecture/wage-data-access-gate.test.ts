/**
 * Task #1512 — Architektur-Guard: lohn-tragende Endpunkte müssen durch die
 * zentrale Schranke `requireWageDataAccess` (= Superadmin-only) laufen.
 *
 * Hintergrund: Der User-Beschluss zu #1512 lockt die tatsächlichen
 * Pro-Mitarbeiter-Vergütungszahlen (Lexware-Auszahlung, Profitabilität/
 * Wirtschaftlichkeit je Mitarbeiter, Lohnsatz-Matrix) hinter den
 * Hauptadministrator. Damit eine NEUE lohn-tragende Route nicht versehentlich
 * nur mit `requireAdmin`/`requireAdminPermission` abgesichert wird, pinnt
 * dieser Test ein Register aller bekannten lohn-tragenden Routen und prüft,
 * dass jede ihre `requireWageDataAccess`-Middleware trägt.
 *
 * Failure-Modus:
 *   - Eine registrierte Route verliert ihre Schranke → Test wird rot mit der
 *     betroffenen Route (Schutz vor stillem Re-Öffnen für normale Admins).
 *   - Eine neue Route mit lohn-typischem Namen (`wage`/`lohn`/`economics`/
 *     `hours-overview`/`performance`) taucht ungeschützt auf und ist NICHT im
 *     Register → Test weist darauf hin, sie zu gaten + zu registrieren.
 *
 * Hinweis: aggregierte, nicht-personenbezogene KPIs (firmenweite Marge in
 * `/api/statistics/v2/revenue`, `/api/billing/pipeline`) bleiben Admin-sichtbar
 * und sind bewusst NICHT registriert.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..");

interface WageRoute {
  file: string;
  // Die Route-Pfade, wie sie im jeweiligen Router definiert sind.
  routePaths: string[];
}

// Register aller lohn-tragenden Endpunkte. Jeder Eintrag MUSS
// `requireWageDataAccess` als Middleware in der Route-Definition tragen.
const WAGE_ROUTES: WageRoute[] = [
  {
    file: "server/routes/admin/lexware-export.ts",
    routePaths: ["/hours-overview", "/hours-overview/unsigned-appointments"],
  },
  {
    file: "server/routes/statistics/v2/index.ts",
    routePaths: ["/performance"],
  },
  {
    file: "server/routes/billing.ts",
    routePaths: ["/economics"],
  },
  {
    // Lohnsatz-Matrix (Task #1510/#1511) — bereits Superadmin-only über
    // requireSuperAdmin; hier registriert als Teil der Lohn-Oberfläche.
    file: "server/routes/role-wage-rates.ts",
    routePaths: ["/role-wage-rates", "/role-wage-rates/all", "/role-wage-rates/future"],
  },
];

function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

// Findet die `router.<verb>("<path>", <middleware...>` Definition und liefert
// die Middleware-Kette bis zum schließenden Klammer-Argument-Block (heuristisch
// bis zum nächsten `asyncHandler`/`async`/Handler-Start auf derselben Zeile).
function routeDefinitionLine(src: string, routePath: string): string | null {
  const lines = src.split("\n");
  const needle = `"${routePath}"`;
  for (const line of lines) {
    if (/router\.(get|post|put|delete|patch)\(/.test(line) && line.includes(needle)) {
      return line;
    }
  }
  return null;
}

describe("Lohn-tragende Endpunkte laufen durch requireWageDataAccess (Task #1512)", () => {
  it("die zentrale Schranke existiert und delegiert an requireSuperAdmin", () => {
    const auth = readSource("server/middleware/auth.ts");
    expect(auth).toContain("export function requireWageDataAccess");
    // SSoT: die Prüf-Logik wird NICHT dupliziert, sondern delegiert.
    expect(auth).toMatch(/requireWageDataAccess[\s\S]*requireSuperAdmin\(req, res, next\)/);
  });

  for (const { file, routePaths } of WAGE_ROUTES) {
    describe(file, () => {
      const src = readSource(file);

      // Die role-wage-rates-Routen sind über requireSuperAdmin gegated
      // (Task #1510/#1511); die drei #1512-Routen über requireWageDataAccess.
      const allowedGates = ["requireWageDataAccess", "requireSuperAdmin"];

      for (const routePath of routePaths) {
        it(`${routePath} trägt eine Superadmin-Schranke`, () => {
          const line = routeDefinitionLine(src, routePath);
          expect(line, `Route ${routePath} in ${file} nicht gefunden`).toBeTruthy();
          const gated = allowedGates.some((g) => line!.includes(g));
          expect(
            gated,
            `Route ${routePath} in ${file} muss requireWageDataAccess (oder requireSuperAdmin) als Middleware tragen.`
          ).toBe(true);
        });
      }
    });
  }
});

// Aktiver Scan: erkennt NEUE lohn-typische Routen, die ungegated auftauchen —
// nicht nur das hartcodierte Register. Jede Route-Definition, deren Pfad ein
// lohn-typisches Schlüsselwort enthält, MUSS auf derselben Zeile eine
// Superadmin-Schranke tragen. So kann eine neue Lohn-Route nicht still nur mit
// requireAdmin durchrutschen.
const WAGE_PATH_KEYWORDS = /(wage|lohn|economics|hours-overview|performance|payroll|salary|verg(ue|ü)tung|auszahl)/i;
const SUPERADMIN_GATES = ["requireWageDataAccess", "requireSuperAdmin"];

// Bewusst offene Routen: aggregierte, NICHT personenbezogene KPIs, die für
// normale Admins sichtbar bleiben sollen. Der Pfad trägt zwar ein Schlüsselwort
// (z.B. „economics"), liefert aber firmenweite Kennzahlen ohne Pro-Mitarbeiter-
// Vergütung. Jeder Eintrag ist eine begründete Ausnahme.
const INTENTIONALLY_OPEN_WAGE_PATHS = new Set<string>([
  // Firmenweite, nicht-personenbezogene Nicht-abrechenbar-Stunden (Drill-Down).
  "/revenue/economics/non-billable",
]);

function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkRouteFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Scan: keine ungegate-ten lohn-typischen Routen (Task #1512)", () => {
  it("jede Route mit lohn-typischem Pfad trägt eine Superadmin-Schranke", () => {
    const routesDir = join(ROOT, "server", "routes");
    const offenders: string[] = [];

    for (const file of walkRouteFiles(routesDir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/router\.(get|post|put|delete|patch)\(/.test(line)) continue;
        // Pfad-Literal der Route extrahieren (erstes String-Argument).
        const pathMatch = line.match(/router\.(?:get|post|put|delete|patch)\(\s*["'`]([^"'`]*)["'`]/);
        if (!pathMatch) continue;
        const routePath = pathMatch[1];
        if (!WAGE_PATH_KEYWORDS.test(routePath)) continue;
        if (INTENTIONALLY_OPEN_WAGE_PATHS.has(routePath)) continue;

        const gated = SUPERADMIN_GATES.some((g) => line.includes(g));
        if (!gated) {
          const rel = file.slice(ROOT.length + 1);
          offenders.push(`${rel}:${i + 1}  ${routePath}`);
        }
      }
    }

    expect(
      offenders,
      `Diese lohn-typischen Routen tragen keine Superadmin-Schranke (requireWageDataAccess/requireSuperAdmin). ` +
        `Entweder gaten oder — falls bewusst nur aggregiert/firmenweit — den Pfad umbenennen:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
