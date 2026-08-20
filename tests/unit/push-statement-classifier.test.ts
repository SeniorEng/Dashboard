/**
 * Nachbedingung des Schema-Pushs (B1).
 *
 * Der Anlass ist gemessen, nicht hergeleitet: `drizzle-kit push` 0.31.10
 * beendet sich bei `permission denied for schema public` mit **exit 0** und
 * wendet nichts an. Der Erfolg muss deshalb an dem gemessen werden, was danach
 * noch aussteht.
 *
 * Die kosmetischen Fixtures stammen wörtlich aus einem Trockenlauf gegen ein
 * deckungsgleiches Schema.
 */
import { describe, expect, it } from "vitest";
import {
  bewerteNachbedingung,
  klassifiziereAnweisung,
  normalisiere,
} from "../../scripts/lib/push-statement-classifier.ts";

const CHURN = [
  'ALTER TABLE "appointments" DROP CONSTRAINT "appointments_prospect_or_customer_check";',
  'ALTER TABLE "employee_time_entries" ALTER COLUMN "kilometers" SET DEFAULT 0;',
  'ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_captured_transaction_id_budget_transactions_id_fk" FOREIGN KEY ("captured_transaction_id") REFERENCES "public"."budget_transactions"("id") ON DELETE no action ON UPDATE no action;',
];

describe("klassifiziereAnweisung — die vier Formen, die den ALTEN Code brechen", () => {
  // Diese vier sind der Kern der Auflage: sie verändern das Schema so, dass der
  // im Teil-Fehlschlag-Fenster noch bedienende alte Code bricht. Steht eine von
  // ihnen nach dem Push noch an, ist der Push NICHT durchgelaufen.
  const MUSS_BLOCKEN: [string, string][] = [
    ["NOT NULL", 'ALTER TABLE "invoices" ALTER COLUMN "status" SET NOT NULL;'],
    [
      "UNIQUE",
      'ALTER TABLE "invoices" ADD CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number");',
    ],
    [
      "CHECK",
      'ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amount_positive" CHECK ("gross_amount_cents" >= 0);',
    ],
    [
      "verengende Typaenderung",
      'ALTER TABLE "invoices" ALTER COLUMN "recipient_name" SET DATA TYPE varchar(20);',
    ],
  ];

  it.each(MUSS_BLOCKEN)("%s blockt", (_name, sql) => {
    expect(klassifiziereAnweisung(sql)).toBe("strukturell");
    const urteil = bewerteNachbedingung([sql], []);
    expect(urteil.blockaden).toHaveLength(1);
    expect(urteil.blockaden[0].grund).toBe("strukturell");
  });

  it("keine der vier rutscht durch, wenn sie im Fingerprint steht", () => {
    // Ein gepinnter Fingerprint darf eine strukturelle Anweisung NICHT
    // legitimieren — sonst wäre die Datei ein Freifahrtschein.
    for (const [, sql] of MUSS_BLOCKEN) {
      const urteil = bewerteNachbedingung([sql], [sql]);
      expect(urteil.blockaden).toHaveLength(1);
      expect(urteil.geduldet).toEqual([]);
    }
  });
});

describe("klassifiziereAnweisung — weitere strukturelle Formen", () => {
  it.each([
    ['CREATE TABLE "neu" ("id" serial PRIMARY KEY);'],
    ['ALTER TABLE "invoices" ADD COLUMN "neu" text;'],
    ['ALTER TABLE "invoices" DROP COLUMN "alt";'],
    ['DROP TABLE "customer_budgets";'],
    ['CREATE UNIQUE INDEX "ix" ON "invoices" ("invoice_number");'],
    ['ALTER TYPE "status" ADD VALUE \'neu\';'],
    ['TRUNCATE TABLE "invoices";'],
    ['ALTER TABLE "invoices" RENAME COLUMN "a" TO "b";'],
  ])("%s blockt", (sql) => {
    expect(klassifiziereAnweisung(sql)).toBe("strukturell");
  });
});

describe("klassifiziereAnweisung — fail-closed", () => {
  it("eine unbekannte Form ist NICHT kosmetisch", () => {
    expect(klassifiziereAnweisung('GRANT SELECT ON "invoices" TO app;')).toBe("unbekannt");
    expect(klassifiziereAnweisung("VACUUM FULL;")).toBe("unbekannt");
  });

  it("eine unbekannte Form blockt, auch wenn sie im Fingerprint steht", () => {
    const sql = 'GRANT SELECT ON "invoices" TO app;';
    const urteil = bewerteNachbedingung([sql], [sql]);
    expect(urteil.blockaden).toEqual([{ sql, grund: "unbekannte Form" }]);
  });
});

describe("klassifiziereAnweisung — der benigne Bodensatz", () => {
  it("erkennt den echten Churn als kosmetisch", () => {
    for (const sql of CHURN) {
      expect(klassifiziereAnweisung(sql)).toBe("kosmetisch");
    }
  });
});

describe("bewerteNachbedingung", () => {
  it("duldet Churn nur, wenn er AUCH im Fingerprint steht", () => {
    const urteil = bewerteNachbedingung(CHURN, CHURN);
    expect(urteil.blockaden).toEqual([]);
    expect(urteil.geduldet).toHaveLength(3);
  });

  it("kosmetisch, aber nicht gepinnt ⇒ Drift, blockt", () => {
    const fremd =
      'ALTER TABLE "unbekannte_tabelle" DROP CONSTRAINT "irgendein_fk";';
    const urteil = bewerteNachbedingung([fremd], CHURN);
    expect(urteil.blockaden).toEqual([{ sql: fremd, grund: "nicht im Fingerprint" }]);
  });

  it("der B1-Fall: nichts angewendet ⇒ die strukturellen Reste blocken", () => {
    // So sah es aus, als der Push mit exit 0 an `permission denied` scheiterte.
    const nichtsAngewendet = [
      'CREATE TABLE "invoices" ("id" serial PRIMARY KEY);',
      'CREATE TABLE "customers" ("id" serial PRIMARY KEY);',
      ...CHURN,
    ];
    const urteil = bewerteNachbedingung(nichtsAngewendet, CHURN);
    expect(urteil.blockaden).toHaveLength(2);
    expect(urteil.blockaden.every((b) => b.grund === "strukturell")).toBe(true);
  });

  it("leerer Rest ist in Ordnung", () => {
    expect(bewerteNachbedingung([], CHURN).blockaden).toEqual([]);
  });

  it("Whitespace-Rauschen verhindert den Fingerprint-Treffer nicht", () => {
    const gepinnt = CHURN[1];
    const verrauscht = gepinnt.replace(/ /g, "  ").replace(";", " ;\n");
    expect(normalisiere(verrauscht)).toBe(normalisiere(gepinnt));
    expect(bewerteNachbedingung([verrauscht], [gepinnt]).blockaden).toEqual([]);
  });
});
