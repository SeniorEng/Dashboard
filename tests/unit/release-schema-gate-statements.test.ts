/**
 * Der reine Kern des Schema-Riegels (Schritt 0d des Release-Steps).
 *
 * Die Fixtures sind KEINE erfundenen SQL-Strings: die harmlosen Anweisungen
 * stammen wörtlich aus einem `pushSchema`-Trockenlauf gegen eine Wegwerf-DB mit
 * deckungsgleichem Schema. Genau diese ~8 `DROP CONSTRAINT`-Zeilen fallen bei
 * JEDEM Push an — ein Riegel auf „DROP" würde jeden Deploy blockieren.
 */
import { describe, expect, it } from "vitest";
import { findeDestruktiveAnweisungen } from "../../scripts/lib/destructive-schema-statements.ts";
import { quelltextSchreibt } from "@shared/db-write-statements";

/** Wörtlich aus dem Trockenlauf gegen ein deckungsgleiches Schema. */
const HARMLOS_ECHT = [
  'ALTER TABLE "appointments" DROP CONSTRAINT "appointments_prospect_or_customer_check";',
  'ALTER TABLE "customer_insurance_history" DROP CONSTRAINT "customer_insurance_history_insurance_provider_id_insurance_prov";',
  'ALTER TABLE "employee_time_entries" ALTER COLUMN "kilometers" SET DEFAULT 0;',
  'ALTER TABLE "company_settings" ALTER COLUMN "qonto_additional_ibans" SET DEFAULT ARRAY[]::text[];',
  'ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_captured_transaction_id_budget_transactions_id_fk" FOREIGN KEY ("captured_transaction_id") REFERENCES "public"."budget_transactions"("id") ON DELETE no action ON UPDATE no action;',
];

describe("findeDestruktiveAnweisungen", () => {
  it("laesst einen deckungsgleichen Push komplett durch", () => {
    expect(findeDestruktiveAnweisungen(HARMLOS_ECHT)).toEqual([]);
  });

  it("DROP CONSTRAINT ist NICHT destruktiv — sonst blockiert jeder Deploy", () => {
    const nurConstraints = HARMLOS_ECHT.filter((s) => s.includes("DROP CONSTRAINT"));
    expect(nurConstraints.length).toBeGreaterThan(0);
    expect(findeDestruktiveAnweisungen(nurConstraints)).toEqual([]);
  });

  it("faengt DROP COLUMN — wörtlich die Form aus dem Trockenlauf", () => {
    expect(
      findeDestruktiveAnweisungen([
        'ALTER TABLE "invoices" DROP COLUMN "zz_alt_spalte";',
      ]),
    ).toEqual([{ table: "invoices", column: "zz_alt_spalte" }]);
  });

  it("faengt DROP TABLE, auch schema-qualifiziert und mit IF EXISTS", () => {
    expect(
      findeDestruktiveAnweisungen([
        'DROP TABLE "customer_pricing_history";',
        'DROP TABLE IF EXISTS "public"."service_rates" CASCADE;',
      ]),
    ).toEqual([{ table: "customer_pricing_history" }, { table: "service_rates" }]);
  });

  it("findet Destruktives zwischen Harmlosem, ohne die Reihenfolge zu verlieren", () => {
    const drops = findeDestruktiveAnweisungen([
      HARMLOS_ECHT[0],
      'ALTER TABLE "prices" DROP COLUMN "legacy_amount";',
      HARMLOS_ECHT[2],
      'DROP TABLE "customer_budgets";',
    ]);
    expect(drops).toEqual([
      { table: "prices", column: "legacy_amount" },
      { table: "customer_budgets" },
    ]);
  });

  it("meldet einen nicht zerlegbaren Drop, statt ihn zu verschlucken", () => {
    // Eine Form, die das Detailmuster nicht kennt, darf NICHT als „nichts
    // gefunden" durchgehen — sie muss den Release aufhalten.
    const drops = findeDestruktiveAnweisungen([
      "ALTER TABLE nur_ein_kommentar /* drop column */ DROP COLUMN;",
    ]);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toEqual({ table: "(unbekannt)" });
  });

  it("leere Eingabe ist leer, nicht fehlerhaft", () => {
    expect(findeDestruktiveAnweisungen([])).toEqual([]);
  });
});

describe("quelltextSchreibt — Skripte mit eigenem Treiber", () => {
  it("eigener pg-Client + DML zaehlt als schreibend", () => {
    // Solche Skripte laufen am gemeinsamen `server/lib/db` vorbei und damit
    // auch an der Laufzeit-Schreibsperre. Der statische Waechter ist fuer sie
    // die EINZIGE Instanz.
    const quelle = `
      import pg from "pg";
      const client = new pg.Client({ connectionString: url });
      await client.query("ALTER DATABASE x SET statement_timeout = 0");
    `;
    expect(quelltextSchreibt(quelle)).toBe(true);
  });

  it("eigener Treiber OHNE SQL im Quelltext bleibt unsichtbar — bekannte Grenze", () => {
    // `scripts/apply-test-db-timeouts.ts` sieht genau so aus: das SQL steckt
    // in einem importierten Helfer (`testDbTimeoutStatements(dbName)`), die
    // Datei selbst traegt kein Literal. Statische Textsuche kann das ohne
    // Verfolgung des Importgraphen nicht aufloesen — und die Laufzeit-Sperre
    // sieht es nicht, weil der Treiber ein eigener ist.
    const quelle = `
      import pg from "pg";
      const client = new pg.Client({ connectionString: url });
      for (const stmt of baueAnweisungen(name)) await client.query(stmt);
    `;
    expect(quelltextSchreibt(quelle)).toBe(false);
  });
});
