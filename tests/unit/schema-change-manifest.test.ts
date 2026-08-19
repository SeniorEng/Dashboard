/**
 * Freigabe schema-verändernder Anweisungen über das schemaHash-Manifest (S6).
 *
 * ERSETZT `PUBLISH_ACK_DROPS` als Deployment-Env. Der Unterschied ist der
 * ganze Punkt: eine Plattform-Env bleibt gesetzt und genehmigt still jeden
 * künftigen Deploy. Eine an den Schema-Stand gebundene Freigabe entwertet sich
 * selbst, sobald die Änderung angewendet ist.
 */
import { describe, expect, it } from "vitest";
import {
  berechneSchemaHash,
  freigabeMeldung,
  pruefeFreigaben,
  type Manifest,
  type SchemaSnapshot,
} from "../../scripts/lib/schema-change-manifest.ts";
import { findeFreigabepflichtige } from "../../scripts/lib/destructive-schema-statements.ts";

const SCHEMA_VORHER: SchemaSnapshot = {
  invoices: ["id", "status", "legacy_betrag_cents"],
  customers: ["id", "name"],
};
/** Nach dem Drop — genau die Änderung, die freigegeben wurde. */
const SCHEMA_NACHHER: SchemaSnapshot = {
  invoices: ["id", "status"],
  customers: ["id", "name"],
};

const DROP = 'ALTER TABLE "invoices" DROP COLUMN "legacy_betrag_cents";';
const KEY = "column:invoices.legacy_betrag_cents";

function manifestFuer(hash: string): Manifest {
  return {
    freigaben: [
      {
        aenderung: KEY,
        schemaHash: hash,
        backupId: "prod-2026-08-19-1200.dump",
        begruendung: "Legacy-Spalte, Prod leer (Audit #237)",
        zeitpunkt: "2026-08-19T12:00:00Z",
      },
    ],
  };
}

describe("berechneSchemaHash", () => {
  it("ist reihenfolge-unabhaengig — sonst entwertet sich jede Freigabe zufaellig", () => {
    const gedreht: SchemaSnapshot = {
      customers: ["name", "id"],
      invoices: ["legacy_betrag_cents", "status", "id"],
    };
    expect(berechneSchemaHash(gedreht)).toBe(berechneSchemaHash(SCHEMA_VORHER));
  });

  it("aendert sich, sobald eine Spalte verschwindet", () => {
    expect(berechneSchemaHash(SCHEMA_NACHHER)).not.toBe(berechneSchemaHash(SCHEMA_VORHER));
  });
});

describe("S6 — die drei geforderten Faelle", () => {
  const pflichtige = findeFreigabepflichtige([DROP]).map((p) => p.key);

  it("(a) destruktive Aenderung OHNE passende Freigabe → Block", () => {
    const urteil = pruefeFreigaben(
      pflichtige,
      { freigaben: [] },
      berechneSchemaHash(SCHEMA_VORHER),
    );
    expect(urteil.angenommen).toEqual([]);
    expect(urteil.abgelehnt).toEqual([{ aenderung: KEY, grund: "keine Freigabe" }]);
  });

  it("(b) MIT passender Freigabe → durch", () => {
    const hash = berechneSchemaHash(SCHEMA_VORHER);
    const urteil = pruefeFreigaben(pflichtige, manifestFuer(hash), hash);
    expect(urteil.abgelehnt).toEqual([]);
    expect(urteil.angenommen).toHaveLength(1);
    expect(urteil.angenommen[0].backupId).toBe("prod-2026-08-19-1200.dump");
  });

  it("(c) schemaHash aendert sich → Freigabe entwertet, naechster Drop wieder geblockt", () => {
    // Die Freigabe wurde fuer den Stand VOR dem Drop ausgestellt. Nach dem Drop
    // ist der Stand ein anderer — derselbe Eintrag zieht nicht mehr. Genau so
    // kann eine einmal erteilte Freigabe keinen zweiten Deploy genehmigen.
    const alt = berechneSchemaHash(SCHEMA_VORHER);
    const neu = berechneSchemaHash(SCHEMA_NACHHER);
    const urteil = pruefeFreigaben(pflichtige, manifestFuer(alt), neu);

    expect(urteil.angenommen).toEqual([]);
    expect(urteil.abgelehnt).toEqual([
      { aenderung: KEY, grund: "Freigabe entwertet", ausgestelltFuer: alt },
    ]);
    // „Entwertet" muss von „nie freigegeben" unterscheidbar bleiben — sonst
    // sucht der Betreiber den Fehler an der falschen Stelle.
    expect(urteil.abgelehnt[0].grund).not.toBe("keine Freigabe");
  });
});

describe("findeFreigabepflichtige — nicht nur Drops", () => {
  it.each([
    ["drop", 'ALTER TABLE "invoices" DROP COLUMN "x";', "column:invoices.x"],
    ["drop", 'DROP TABLE "alt";', "table:alt"],
    [
      "not-null",
      'ALTER TABLE "invoices" ALTER COLUMN "status" SET NOT NULL;',
      "not-null:invoices.status",
    ],
    [
      "unique",
      'ALTER TABLE "invoices" ADD CONSTRAINT "invoices_nr_unique" UNIQUE("invoice_number");',
      "unique:invoices.invoices_nr_unique",
    ],
    [
      "check",
      'ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pos" CHECK ("cents" >= 0);',
      "check:invoices.invoices_pos",
    ],
    [
      "typ",
      'ALTER TABLE "invoices" ALTER COLUMN "recipient_name" SET DATA TYPE varchar(20);',
      "typ:invoices.recipient_name",
    ],
  ])("%s ist freigabepflichtig", (art, sql, key) => {
    const gefunden = findeFreigabepflichtige([sql]);
    expect(gefunden).toHaveLength(1);
    expect(gefunden[0].art).toBe(art);
    expect(gefunden[0].key).toBe(key);
  });

  it.each([
    ['CREATE TABLE "neu" ("id" serial PRIMARY KEY);'],
    ['ALTER TABLE "invoices" ADD COLUMN "notiz" text;'],
    ['CREATE INDEX "ix_status" ON "invoices" ("status");'],
    ['ALTER TABLE "invoices" ALTER COLUMN "cents" SET DEFAULT 0;'],
    ['ALTER TABLE "invoices" DROP CONSTRAINT "alt_fk";'],
  ])("additiv/kosmetisch ist NICHT freigabepflichtig: %s", (sql) => {
    // Sonst waere jede normale Migration freigabepflichtig und die Freigabe
    // verkaeme zur Formalie, die niemand mehr liest.
    expect(findeFreigabepflichtige([sql])).toEqual([]);
  });
});

describe("freigabeMeldung", () => {
  it("nennt den fertigen Manifest-Eintrag und leakt keine URL", () => {
    const neu = berechneSchemaHash(SCHEMA_NACHHER);
    const meldung = freigabeMeldung(
      pruefeFreigaben(["column:invoices.x"], { freigaben: [] }, neu),
      neu,
    );
    expect(meldung).toContain("column:invoices.x");
    expect(meldung).toContain(neu);
    expect(meldung).toContain("docs/schema-change-manifest.json");
    expect(meldung).toContain("pre-publish-backup-runbook.md");
    expect(meldung).not.toMatch(/postgres(ql)?:\/\//);
  });
});
