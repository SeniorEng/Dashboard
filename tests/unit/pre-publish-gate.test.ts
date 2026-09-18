/**
 * Der Riegel VOR dem Publish darf nicht scheitern wie der Block, den er ersetzt.
 *
 * ── Woher die Fälle kommen ───────────────────────────────────────────────
 * Am 17.09.2026 bekam Alrik einen kopierbaren `node -e "…"`-Block, um den
 * Schema-Diff gegen Prod zu fahren. Er ist DREIMAL gescheitert:
 *
 *   1. `bash: !r.available: event not found` — History-Expansion in der
 *      interaktiven Shell. Bei CC lief derselbe Block sauber durch, weil
 *      nicht-interaktive Shells keine History-Expansion machen. **Ein Block,
 *      der nur nicht-interaktiv getestet wurde, ist nicht getestet.**
 *   2. `fatal: Need to specify how to reconcile divergent branches` — der
 *      Workspace stand nicht auf origin/main und hätte ein anderes Modell
 *      gemessen, als der Publish ausliefert.
 *   3. `getaddrinfo ENOTFOUND base` — der Platzhalter `<prod-url>` war
 *      unersetzt durchgelaufen.
 *
 * Alle drei sind Eigenschaften des Wegs, nicht der Umgebung. Ein Skript im
 * Repo hat 1 und 3 per Konstruktion nicht (es wird nicht getippt); 2 prüft es
 * selbst. Diese Datei nagelt fest, dass es dabei bleibt.
 *
 * ── Die eigentliche Zusage ───────────────────────────────────────────────
 * Fail-closed: **ohne Messung kein grünes Ergebnis.** Dieselbe Regel wie in
 * `preflight-publish-fail-closed.test.ts`, eine Ebene davor.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const SKRIPT = "scripts/pre-publish-gate.sh";

/**
 * Das Gate laufen lassen und Ausgabe + Exit-Code zurückgeben.
 *
 * `execFile` wirft bei Exit≠0 — hier ist das der NORMALFALL (das Gate soll
 * blockieren), deshalb wird der Fehler ausgewertet statt durchgereicht.
 */
function fahre(env: NodeJS.ProcessEnv): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [SKRIPT],
      { cwd: REPO, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === "number" ? err.code : 0,
          text: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

describe("Pre-Publish-Gate (6hWvMvpxpJFFjwQG, Frage 2)", () => {
  it("G-1 – ohne Prod-URL blockiert es und sagt, wie man sie hinterlegt", async () => {
    // Der Platzhalter-Fehlschlag von 17.09. in seiner behebbaren Form: statt
    // eines `<prod-url>`, das jemand ersetzen muss, eine Anleitung ohne
    // Platzhalter in der Kommandozeile.
    const { code, text } = await fahre({ PROD_DATABASE_URL: "", DATABASE_URL: "" });

    expect(code, "ohne Prod-URL darf das Gate nicht mit 0 enden").not.toBe(0);
    expect(text).toMatch(/keine Prod-URL/);
    expect(text, "es sagt nicht, woher die URL kommt").toMatch(/Publishing-Tab/);
    expect(text, "es sagt nicht, wie man sie ablegt").toMatch(/cat > \.prod-url\.txt/);

    // Und es darf nichts sagen, das sich wie ein Ergebnis liest.
    expect(text).not.toMatch(/Bereit für Publish/);
    expect(text).not.toMatch(/Keine destruktiven/);
  });

  it("G-2 – die Prod-URL wird nie ausgegeben", async () => {
    // CLAUDE.md: „Die DATABASE_URL wird NIE ausgegeben (Passwort)." Gemeldet
    // werden Host + current_database() aus der offenen Verbindung.
    //
    // Der Lauf bricht hier an der fehlenden DATABASE_URL ab — genau richtig:
    // geprüft wird, ob die URL auf dem Weg dorthin irgendwo durchsickert.
    const GEHEIM = "postgres://nutzer:GEHEIMES-PASSWORT@prod.example.invalid:5432/neondb";
    const { code, text } = await fahre({ PROD_DATABASE_URL: GEHEIM, DATABASE_URL: "" });

    expect(code).not.toBe(0);
    expect(text, "die Prod-URL steht in der Ausgabe").not.toContain(GEHEIM);
    expect(text, "das Passwort steht in der Ausgabe").not.toContain("GEHEIMES-PASSWORT");
    expect(text, "es sagt nicht, woran es scheitert").toMatch(/DATABASE_URL/);
  });

  it("G-3 – die Zugangsdatei kann nicht in einen Commit geraten", async () => {
    // Nicht „steht ein Muster in .gitignore", sondern die Frage, die zählt:
    // würde git die Datei aufnehmen? Das Gate prüft es zur Laufzeit ebenso
    // (`git check-ignore`), hier wird der Repo-Zustand selbst festgenagelt.
    const { code } = await new Promise<{ code: number }>((resolve) => {
      execFile("git", ["check-ignore", "-q", ".prod-url.txt"], { cwd: REPO }, (err) => {
        resolve({ code: err && typeof err.code === "number" ? err.code : 0 });
      });
    });
    expect(code, ".prod-url.txt ist NICHT gitignored — eine Prod-URL könnte committet werden").toBe(0);
  });

  it("G-4 – keine Kommando-Substitution in doppelten Quotes", async () => {
    // Der Fehler, der am 17.09. eine Commit-Nachricht zerlegt hat, und derselbe,
    // der in diesem Skript beinahe den Release-Step AUSGEFÜHRT hätte: Backticks
    // in doppelten Quotes sind Kommando-Substitution.
    //
    // Geprüft wird nur ausführbarer Code, nicht die Kommentare — dort sind
    // Backticks Zitierung und harmlos.
    const zeilen = readFileSync(path.join(REPO, SKRIPT), "utf8").split("\n");
    const treffer = zeilen
      .map((z, i) => ({ z, nr: i + 1 }))
      .filter(({ z }) => !z.trimStart().startsWith("#"))
      .filter(({ z }) => /"[^"]*`/.test(z));

    expect(
      treffer.map(({ nr, z }) => `${nr}: ${z.trim()}`),
      "Backtick in doppelten Quotes — das führt aus, statt zu zitieren",
    ).toEqual([]);
  });

  it("G-5 – es prüft den Workspace-Stand, bevor es misst", async () => {
    // Fehlschlag 2 vom 17.09.: Alriks HEAD kannte #146 nicht, origin/main
    // schon. Ein Diff auf diesem Stand hätte ein Ergebnis geliefert, das wie
    // eine Messung aussieht.
    //
    // Der Lauf selbst lässt sich hier nicht bis dorthin treiben (er bräuchte
    // eine echte Prod-URL), deshalb wird die Verdrahtung geprüft: das Skript
    // holt origin/main und vergleicht die SHAs.
    const quelle = readFileSync(path.join(REPO, SKRIPT), "utf8");
    expect(quelle).toMatch(/git fetch -q origin main/);
    expect(quelle).toMatch(/git rev-parse origin\/main/);
    expect(quelle, "eine Abweichung muss abbrechen, nicht warnen").toMatch(
      /HEAD_SHA" != "\$MAIN_SHA"[\s\S]{0,600}?fehler /,
    );
  });
});
