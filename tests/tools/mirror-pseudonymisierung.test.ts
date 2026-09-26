/**
 * Prod-Mirror (Ticket 6hf36pRXqr2FR8JG) — die Pseudonymisierung an der echten
 * Test-DB geprüft. ERSETZT `tests/architecture/mirror-spaltenliste.test.ts`
 * (Gate 2 zu #198, S-6): der prüfte nur eine Richtung und nur Text-Spalten und
 * seine Selbstprobe berührte die Erkennung nicht.
 *
 * MP-1  Die ECHTE Prüf-Logik (`pseudonymisierung_sql.py`) gegen die Spalten der
 *       Test-DB (dieselbe Abfrage wie das Skript): keine Lücke, keine Karteileiche,
 *       kein `null` auf NOT-NULL.
 * MP-2  Selbstprobe derselben Logik: jede der drei Fehlerarten wird erkannt,
 *       auch für Nicht-Text-Typen (citext/Enum, Datum, numeric).
 * MP-3  Budget-Notizen (Gate 2, B-2): die Regel aus `spalten.tsv` liefert für
 *       jede im Code vorkommende Notiz-Form dasselbe Ergebnis in den drei
 *       Lesern (`parseStornoReference`, Monats-Umbuchung, Waisen-Suche) und
 *       behält die Idempotenz-Marker — Namen und Freitext fallen weg.
 * MP-4  JSON (Gate 2, B-1): Text bleibt nur unter fachlichen Schlüsseln;
 *       Datum/PLZ/Telefon als Text werden ersetzt, Zahlen mit Personenbezug null.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { parseStornoReference } from "@shared/domain/budget/phantom-storno";

const MIRROR = join(__dirname, "../../scripts/mirror");

async function spaltenDerDb(): Promise<string> {
  // Dieselbe Abfrage wie scripts/mirror/prod-mirror-abzug.sh (Schritt 4).
  const r = await db.execute(sql`
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable
      FROM information_schema.columns c
      JOIN pg_class k ON k.relname = c.table_name
      JOIN pg_namespace ns ON ns.oid = k.relnamespace AND ns.nspname = 'public'
     WHERE c.table_schema = 'public' AND k.relkind IN ('r','p') AND c.table_name NOT LIKE 'mirror\\_%'
     ORDER BY 1, 2`);
  return (r.rows as Array<Record<string, string>>)
    .map((z) => [z.table_name, z.column_name, z.data_type, z.udt_name, z.is_nullable].join("|"))
    .join("\n");
}

function pruefe(eingabe: string): { code: number; fehler: string } {
  try {
    execFileSync("python3", [join(MIRROR, "pseudonymisierung_sql.py")], { input: eingabe, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, fehler: "" };
  } catch (e) {
    const err = e as { status: number; stderr: string };
    return { code: err.status, fehler: err.stderr };
  }
}

function regel(tabelle: string, spalte: string): string {
  const zeile = readFileSync(join(MIRROR, "spalten.tsv"), "utf-8").split("\n")
    .find((z) => z.startsWith(`${tabelle}\t${spalte}\t`));
  if (!zeile) throw new Error(`${tabelle}.${spalte} fehlt in spalten.tsv`);
  return zeile.split("\t")[2];
}

describe("Prod-Mirror: Pseudonymisierung", () => {
  it("MP-1 – Spaltenliste passt zur DB (keine Lücke, keine Karteileiche, kein null auf NOT NULL)", async () => {
    const r = pruefe(await spaltenDerDb());
    expect(r.fehler, "scripts/mirror/spalten.tsv anpassen").toBe("");
    expect(r.code).toBe(0);
  });

  it("MP-2 – Selbstprobe: fehlende Spalte (auch Nicht-Text), Karteileiche und null auf NOT NULL werden erkannt", async () => {
    const echt = await spaltenDerDb();
    const zusatz = [
      "customers|neue_notiz|text|text|YES",
      "customers|kennung|USER-DEFINED|citext|YES",
      "customers|sterbedatum|date|date|YES",
      "customers|geo_neu|numeric|numeric|YES",
      "customers|zaehler_neu|integer|int4|YES",
    ].join("\n");
    const ohneEmail = echt.split("\n").filter((z) => !z.startsWith("customers|email|")).join("\n");
    const emailNotNull = echt.replace(/^customers\|email\|(.*)\|YES$/m, "customers|email|$1|NO");
    const a = pruefe(`${echt}\n${zusatz}`);
    expect(a.code).toBe(2);
    for (const s of ["neue_notiz", "kennung", "sterbedatum", "geo_neu"]) expect(a.fehler).toContain(`NICHT ZUGEORDNET: customers.${s}`);
    expect(a.fehler, "integer ist harmlos").not.toContain("zaehler_neu");
    expect(pruefe(ohneEmail).fehler).toContain("IN LISTE, ABER NICHT IN DER DB: customers.email");
    expect(pruefe(emailNotNull).fehler).toContain("REGEL null AUF NOT-NULL-SPALTE: customers.email");
  });

  it("MP-3 – Budget-Notizen: gleiche Bedeutung für alle drei Leser, Freitext und Namen fallen weg", async () => {
    const ausdruck = regel("budget_transactions", "notes");
    expect(regel("budget_allocations", "notes")).toBe(ausdruck);
    const formen = [
      "Storno von Transaktion #114",
      "Storno von Transaktion #69 (Umbuchung)",
      "Storno (Termin-Edit) von Transaktion #33",
      "Storno (Reconcile #116) von Transaktion #42",
      "Storno (km-Drift-Korrektur #619) von Transaktion #7 (km 12→14)",
      "Storno für Umbuchung nach umwandlung_45a (Transaktion #88)",
      "Umbuchung von entlastungsbetrag_45b (Transaktion #91)",
      "Storno-Storno-Zeile #501 (Reconcile)",
      "Korrektur: verwaisten Storno #777 (Import) entfernt",
      "Storno Frau Erika Müller Transaktion #5 Diabetes",
      "Kassenauskunft Frau Erika Müller",
      "",
    ];
    const erster = (s: string | null) => s?.match(/Transaktion #(\d+)/)?.[1] ?? null;
    const waise = (s: string | null, id: string) => new RegExp(`Storno.*Transaktion #${id}(\\D|$)`).test(s ?? "");
    for (const vorher of formen) {
      const r = await db.execute(sql.raw(`SELECT ${ausdruck.slice(1)} AS n FROM (VALUES (${vorher === "" ? "NULL::text" : `'${vorher.replace(/'/g, "''")}'`})) v(notes)`));
      const nachher = (r.rows[0] as { n: string | null }).n;
      expect(parseStornoReference(nachher), `parseStornoReference: ${vorher}`).toBe(parseStornoReference(vorher || null));
      expect(erster(nachher), `Monats-Umbuchung: ${vorher}`).toBe(erster(vorher));
      const id = erster(vorher);
      if (id) expect(waise(nachher, id), `Waisen-Suche: ${vorher}`).toBe(waise(vorher, id));
      for (const m of vorher.match(/(Storno-Storno-Zeile|verwaisten Storno) #\d+ \(/g) ?? []) expect(nachher, `Marker: ${vorher}`).toContain(m);
      expect(nachher ?? "", `kein Freitext: ${vorher}`).not.toMatch(/Erika|Müller|Diabetes|Kassenauskunft|km 12/);
    }
  });

  it("MP-4 – JSON: Text nur unter fachlichen Schlüsseln, Datum/PLZ/Telefon ersetzt, Zahlen mit Personenbezug null", async () => {
    const hilfen = readFileSync(join(MIRROR, "hilfen.sql"), "utf-8");
    const funktion = hilfen.slice(hilfen.indexOf("CREATE OR REPLACE FUNCTION mirror_scrub"), hilfen.indexOf("-- Zeilenzahl je Tabelle"));
    const ein = {
      status: "storniert", invoiceNumber: "RE-2026-0694", budgetType: "entlastungsbetrag_45b",
      customer: { name: "Erika Müller", geburtsdatum: "1938-04-12", plz: "09111", nr: "7", telefon: "01701234567", lat: 52.52 },
      reason: "Frau Müller verstorben", betragCents: 19420, datum: "2026-06-30", liste: ["Müller", 5],
      changedFields: ["email", "telefon"], kontakt: { plz: 9111, telefonnummer: 3712345, versichertennummer: 123 },
    };
    let aus: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(funktion));
        const r = await tx.execute(sql`SELECT mirror_scrub(${JSON.stringify(ein)}::jsonb) AS j`);
        aus = (r.rows[0] as { j: unknown }).j;
        throw new Error("zurückrollen");
      });
    } catch (e) {
      if ((e as Error).message !== "zurückrollen") throw e;
    }
    expect(aus).toEqual({
      status: "storniert", invoiceNumber: "RE-2026-0694", budgetType: "entlastungsbetrag_45b",
      customer: { name: "[x]", geburtsdatum: "[x]", plz: "[x]", nr: "[x]", telefon: "[x]", lat: null },
      reason: "[x]", betragCents: 19420, datum: "[x]", liste: ["[x]", 5],
      changedFields: ["email", "telefon"], kontakt: { plz: null, telefonnummer: null, versichertennummer: null },
    });
  });
});
