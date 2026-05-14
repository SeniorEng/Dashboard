/**
 * Task #449 — Architektur-Test: sensitive Spalten MÜSSEN `encryptedText(...)`
 * verwenden statt `text(...)`, damit Werte automatisch verschlüsselt werden.
 *
 * Hintergrund: Eine manuelle Allow-Liste in `server/storage.ts` ist fehleranfällig.
 * Wer eine neue Secret-Spalte ergänzt, muss daran denken sie einzutragen — sonst
 * landet der Wert im Klartext in der DB. Mit der `encryptedText`-Annotation im
 * Drizzle-Schema verschwindet diese Fehlerquelle.
 *
 * Was geprüft wird: Spaltennamen in `shared/schema/**.ts`, deren DB-Name auf
 * /secret|token|password|key/i matcht, MÜSSEN entweder
 *  - via `encryptedText("name")` deklariert sein, ODER
 *  - in `ALLOWED_PLAINTEXT_COLUMNS` mit Begründung gelistet sein (z.B. Hashes
 *    oder Identifier, die keine Secrets sind).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SCHEMA_DIR = join(process.cwd(), "shared", "schema");
const SENSITIVE_NAME = /(secret|token|password|key)/i;

/**
 * Spalten, deren Name zwar auf das Pattern matcht, die aber bewusst KEIN
 * Secret enthalten (Hashes, Identifier, Enum-Schlüssel etc.).
 */
const ALLOWED_PLAINTEXT_COLUMNS: Record<string, string> = {
  password_hash: "bcrypt-Hash, kein reversibles Secret",
  token_hash: "SHA-Hash, kein reversibles Secret",
  permission_key: "Enum-String (z.B. 'manage_users')",
  idempotency_key: "Client-supplied Idempotency-Identifier, kein Secret",
};

function walkSchemaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkSchemaFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

interface ColumnDecl {
  file: string;
  line: number;
  raw: string;
  dbName: string;
  helper: "text" | "encryptedText";
}

function parseColumnDecls(file: string): ColumnDecl[] {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const decls: ColumnDecl[] = [];
  const re = /\b(encryptedText|text)\s*\(\s*"([a-z0-9_]+)"\s*\)/g;
  lines.forEach((line, idx) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      decls.push({
        file,
        line: idx + 1,
        raw: line.trim(),
        helper: m[1] as "text" | "encryptedText",
        dbName: m[2],
      });
    }
  });
  return decls;
}

describe("Sensitive Spalten verwenden encryptedText", () => {
  it("alle Spalten mit Secret-/Token-/Password-/Key-Namen sind verschlüsselt oder explizit allowlisted", () => {
    const files = walkSchemaFiles(SCHEMA_DIR);
    const offenders: string[] = [];

    for (const file of files) {
      for (const decl of parseColumnDecls(file)) {
        if (!SENSITIVE_NAME.test(decl.dbName)) continue;
        if (decl.helper === "encryptedText") continue;
        if (decl.dbName in ALLOWED_PLAINTEXT_COLUMNS) continue;
        offenders.push(
          `${decl.file}:${decl.line}  ${decl.dbName}  →  ${decl.raw}`
        );
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        "Folgende Spalten matchen das Secret-Pattern, verwenden aber `text(...)` statt `encryptedText(...)`.\n" +
          "Entweder auf `encryptedText` umstellen oder in ALLOWED_PLAINTEXT_COLUMNS mit Begründung ergänzen:\n\n" +
          offenders.join("\n")
      );
    }
    expect(offenders).toEqual([]);
  });
});
