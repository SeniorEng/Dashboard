/**
 * Das Messwerkzeug für Schritt 0d darf drei Dinge nicht: schreiben, die
 * Zugangsdaten ausgeben, oder einen Platzhalter verlangen.
 *
 * ── Warum das einen Wächter braucht ──────────────────────────────────────
 * Es läuft von Hand, gegen PRODUKTION, und es lädt `pushSchema` — dieselbe
 * Funktion, die im Ernstfall Schema anwendet. Ein Skript, das dabei
 * versehentlich `apply()` aufruft, wäre ein DDL-Lauf gegen Prod ohne Gate.
 *
 * Und es fasst die Prod-URL an, um den Pooler-Host abzuleiten. Genau dieser
 * Griff — Zugangsdaten in einer Kommandozeile bearbeiten — hat am 17.09.2026
 * dazu geführt, dass ein Platzhalter unersetzt durchlief (`ENOTFOUND base`).
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

  it("M-3 – `--pooler` schreibt den Host um und gibt die URL NICHT aus", async () => {
    // Die Umschreibung gehört ins Skript, nicht in Alriks Kommandozeile: den
    // Host von Hand zu ändern heisst, die Zugangsdaten anzufassen.
    const GEHEIM = "postgres://nutzer:GEHEIMES-PASSWORT@ep-abc-xyz.c-3.us-west-2.aws.neon.tech/neondb";
    const { text } = await fahre(["--pooler"], {
      PROD_DATABASE_URL: GEHEIM,
      // Verbindungsversuch läuft ins Leere — der Host steht vorher auf dem Schirm.
    });

    expect(text, "der umgeschriebene Host fehlt").toContain(
      "ep-abc-xyz-pooler.c-3.us-west-2.aws.neon.tech",
    );
    expect(text, "die Prod-URL steht in der Ausgabe").not.toContain(GEHEIM);
    expect(text, "das Passwort steht in der Ausgabe").not.toContain("GEHEIMES-PASSWORT");
    expect(text, "der Benutzername steht in der Ausgabe").not.toContain("nutzer");
  });

  it("M-4 – ein bereits gepoolter Host wird nicht doppelt umgeschrieben", async () => {
    const { text } = await fahre(["--pooler"], {
      PROD_DATABASE_URL: "postgres://u:p@ep-abc-pooler.c-3.us-west-2.aws.neon.tech/neondb",
    });
    expect(text).toContain("ep-abc-pooler.c-3");
    expect(text, "„-pooler-pooler“ — die Umschreibung ist nicht idempotent")
      .not.toContain("-pooler-pooler");
  });
});
