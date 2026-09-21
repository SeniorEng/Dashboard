/**
 * Das Messwerkzeug für Schritt 0d darf drei Dinge nicht: schreiben, die
 * Zugangsdaten ausgeben, oder einen Platzhalter verlangen.
 *
 * ── Warum das einen Wächter braucht ──────────────────────────────────────
 * Es läuft von Hand, gegen PRODUKTION, und es lädt `pushSchema` — dieselbe
 * Funktion, die im Ernstfall Schema anwendet. Ein Skript, das dabei
 * versehentlich `apply()` aufruft, wäre ein DDL-Lauf gegen Prod ohne Gate.
 *
 * Und es benennt das Ziel: ohne Host in der Kopfzeile weiss hinterher niemand,
 * wogegen gemessen wurde — mit der URL darin wäre das Passwort im Log. Beides
 * ist hier festgenagelt.
 *
 * Der Host kommt aus der SSoT (`dbHostOf`), nicht aus einer eigenen
 * URL-Zerlegung. Die erste Fassung zog ihn selbst heraus und wurde in CI von
 * `tests/architecture/dev-db-guard-parity.test.ts` gefangen — zweite Antwort
 * auf „welcher Host?". Der Waechter hatte recht.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const SKRIPT = "scripts/messe-0d.ts";

function fahre(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["tsx", SKRIPT, ...args],
      {
        cwd: REPO,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === "number" ? err.code : 0,
          text: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

describe("Messwerkzeug Schritt 0d (6hWvrJgff5xr9hfp)", () => {
  it("M-1 – es ist rein lesend: kein `apply()` im Quelltext", () => {
    // `pushSchema` liefert ein Objekt MIT `apply()`. Der Trockenlauf besteht
    // genau darin, es nicht aufzurufen — eine Zusage, die sich am Quelltext
    // prüfen lässt und nicht erst am Schaden.
    const quelle = readFileSync(path.join(REPO, SKRIPT), "utf8");
    const ausfuehrbar = quelle
      .split("\n")
      .filter((z) => !z.trimStart().startsWith("*") && !z.trimStart().startsWith("//"));
    expect(
      ausfuehrbar.filter((z) => /\.apply\s*\(/.test(z) && !/Reflect|orig/.test(z)),
      "Aufruf von apply() — das Werkzeug würde Schema ANWENDEN statt messen",
    ).toEqual([]);
    // Und es darf auch sonst kein DDL absetzen.
    expect(ausfuehrbar.join("\n")).not.toMatch(/\b(ALTER|DROP|CREATE|INSERT|UPDATE|DELETE)\s+(TABLE|COLUMN|INTO|FROM)\b/i);
  });

  it("M-2 – ohne Prod-URL bricht es ab und sagt, wie man sie hinterlegt", async () => {
    const { code, text } = await fahre([], { PROD_DATABASE_URL: "" });
    expect(code).not.toBe(0);
    expect(text).toMatch(/keine Prod-URL/);
    expect(text, "es sagt nicht, woher die URL kommt").toMatch(/Publishing-Tab/);
    expect(text, "es sagt nicht, wie man sie ablegt").toMatch(/cat > \.prod-url\.txt/);
  });

  it("M-3 – es nennt den Host, gibt aber die URL NICHT aus", async () => {
    // Die Kopfzeile ist die einzige Stelle, an der das Ziel benannt wird — und
    // sie muss es benennen, sonst weiss hinterher niemand, wogegen gemessen
    // wurde. Der Host kommt über `dbHostOf` aus der SSoT, nicht aus einer
    // eigenen URL-Zerlegung: `tests/architecture/dev-db-guard-parity.test.ts`
    // hat genau die in CI gefangen.
    const GEHEIM = "postgres://nutzer:GEHEIMES-PASSWORT@ep-abc-xyz.c-3.us-west-2.aws.neon.tech/neondb";
    const { text } = await fahre([], { PROD_DATABASE_URL: GEHEIM });

    expect(text, "der Host fehlt in der Kopfzeile").toContain(
      "ep-abc-xyz.c-3.us-west-2.aws.neon.tech",
    );
    expect(text, "die Prod-URL steht in der Ausgabe").not.toContain(GEHEIM);
    expect(text, "das Passwort steht in der Ausgabe").not.toContain("GEHEIMES-PASSWORT");
    expect(text, "der Benutzername steht in der Ausgabe").not.toContain("nutzer");
  });

  it("M-4 – es sagt an, welcher Host für den Pooler-Lauf gebraucht wird", async () => {
    // Das Skript schreibt die URL bewusst NICHT selbst um (das wäre eine zweite
    // Antwort auf „welcher Host?"). Es nennt den Host, den man hinterlegen
    // muss — und meldet in der Kopfzeile, welchen es dann tatsächlich gemessen
    // hat. Ein Vertipper scheitert damit laut, statt still das Falsche zu messen.
    const { text } = await fahre([], {
      PROD_DATABASE_URL: "postgres://u:p@ep-abc-xyz.c-3.us-west-2.aws.neon.tech/neondb",
    });
    expect(text).toContain("ep-abc-xyz-pooler.c-3.us-west-2.aws.neon.tech");
  });

  it("M-5 – bei einem bereits gepoolten Host gibt es nichts anzusagen", async () => {
    const { text } = await fahre([], {
      PROD_DATABASE_URL: "postgres://u:p@ep-abc-pooler.c-3.us-west-2.aws.neon.tech/neondb",
    });
    expect(text, "„-pooler-pooler“ — der Hinweis ist nicht idempotent")
      .not.toContain("-pooler-pooler");
    expect(text, "der Hinweis steht da, obwohl schon gepoolt wird")
      .not.toMatch(/Fuer den Pooler-Lauf/);
  });

  it("M-6 – uneindeutiger Host ist ein Abbruch, keine Randnotiz", async () => {
    // Unkodiertes `#` im Passwort: die beiden Parser dieses Repos lesen
    // verschiedene Hosts. `dbHostOf` liefert dann `null` — und eine Messung
    // gegen ein unklares Ziel ist keine. Dieselbe Klasse wie der
    // Passwort-Leck-Fund des Gate-2-Reviewers, nur eine Ebene früher.
    const { code, text } = await fahre([], {
      PROD_DATABASE_URL: "postgres://user:12345#x@prod.example.invalid/db",
    });
    expect(code, "uneindeutiger Host darf nicht gemessen werden").not.toBe(0);
    expect(text).toMatch(/nicht eindeutig bestimmbar/);
    expect(text, "Passwort-Fragment in der Ausgabe").not.toContain("12345");
  });
});
