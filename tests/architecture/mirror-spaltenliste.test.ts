/**
 * Wächter: Die Spaltenliste des Prod-Mirrors (`scripts/mirror/spalten.tsv`)
 * ordnet JEDE Text-/JSON-Spalte des Schemas zu (Ticket 6hf36pRXqr2FR8JG).
 *
 * Der Abzug selbst bricht bei einer fehlenden Spalte ab (fail-closed) — aber
 * erst in Alriks Lauf. Dieser Test meldet es beim PR, der die Spalte einführt.
 * MS-2 ist die Selbstprobe: eine konstruierte Lücke muss erkannt werden.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@shared/schema";

const TEXTARTIG = /^(text|varchar|character varying|char|character|json|jsonb|bytea)(\(|\[|$)/;

function schemaTextSpalten(): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(schema)) {
    if (!is(v as never, PgTable)) continue;
    const c = getTableConfig(v as never);
    for (const col of c.columns) if (TEXTARTIG.test(col.getSQLType())) out.add(`${c.name}.${col.name}`);
  }
  return out;
}

function liste(): Map<string, { regel: string; begruendung: string }> {
  const zeilen = readFileSync(join(__dirname, "../../scripts/mirror/spalten.tsv"), "utf-8")
    .split("\n").filter((z) => z.trim() && !z.startsWith("#")).slice(1);
  return new Map(zeilen.map((z) => {
    const [t, s, regel, begruendung] = z.split("\t");
    return [`${t}.${s}`, { regel, begruendung }];
  }));
}

function luecken(spalten: Set<string>, l: Map<string, unknown>): string[] {
  return [...spalten].filter((s) => !l.has(s)).sort();
}

describe("Prod-Mirror: Spaltenliste vollständig", () => {
  it("MS-1 – jede Text-/JSON-Spalte des Schemas ist zugeordnet, jede mit Regel und Begründung", () => {
    const l = liste();
    expect(luecken(schemaTextSpalten(), l), "in scripts/mirror/spalten.tsv ergänzen").toEqual([]);
    for (const [spalte, { regel, begruendung }] of l) {
      expect(regel, spalte).toMatch(/^(bleibt|null|scrub|=.+)$/);
      expect(begruendung?.trim(), `${spalte}: Begründung fehlt`).toBeTruthy();
    }
  });

  it("MS-2 – Selbstprobe: eine Spalte ohne Zuordnung wird erkannt", () => {
    const spalten = schemaTextSpalten();
    spalten.add("customers.neue_freitext_spalte");
    expect(luecken(spalten, liste())).toEqual(["customers.neue_freitext_spalte"]);
  });
});
