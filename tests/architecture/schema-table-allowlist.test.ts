/**
 * Task #1238 (Phase 0.2 — Architektur-Wächter) — Schema-Tabellen-Allowlist.
 *
 * Hintergrund: Additives Wachstum (eine neue Tabelle „kommt einfach dazu") ist
 * die Wurzel zufälliger Komplexität und kollidiert mit der Ersetzungs-Regel.
 * Dieser Wächter friert die Menge der `pgTable`-Definitionen in
 * `shared/schema/` auf eine EXPLIZITE Allowlist ein. Jede NEUE oder ENTFERNTE
 * Tabelle bricht das Gate in beide Richtungen und erzwingt eine bewusste
 * Entscheidung (plus Pflege dieser Liste).
 *
 * Rein statisch — KEINE Laufzeit-Änderung. Der Vergleich ist mengenbasiert,
 * die Reihenfolge der Allowlist ist daher irrelevant.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { ROOT } from "./ast-grep-helpers";

const SCHEMA_DIR = join(ROOT, "shared", "schema");
const PG_TABLE_RE = /pgTable\(\s*["']([a-z0-9_]+)["']/g;

/** Liest alle `pgTable("…")`-Namen aus den `.ts`-Dateien in `shared/schema/`. */
export function extractPgTableNames(dir: string = SCHEMA_DIR): string[] {
  const names = new Set<string>();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    const content = readFileSync(join(dir, entry), "utf-8");
    let m: RegExpExecArray | null;
    PG_TABLE_RE.lastIndex = 0;
    while ((m = PG_TABLE_RE.exec(content)) !== null) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

export interface TableDiff {
  /** In der Allowlist erwartet, aber nicht (mehr) im Schema gefunden. */
  missing: string[];
  /** Im Schema gefunden, aber nicht in der Allowlist. */
  unexpected: string[];
}

/** Mengen-Diff zwischen tatsächlichen und erlaubten Tabellen (beidseitig). */
export function diffTables(actual: string[], expected: string[]): TableDiff {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((t) => !actualSet.has(t)).sort(),
    unexpected: actual.filter((t) => !expectedSet.has(t)).sort(),
  };
}

/**
 * EXPLIZITE Allowlist aller erlaubten DB-Tabellen (Stand Task #1238).
 * Wird eine Tabelle bewusst hinzugefügt/ersetzt, MUSS dieser Eintrag mit
 * gepflegt werden — das ist der gewollte Reibungspunkt gegen additives Wachstum.
 */
const EXPECTED_TABLES: readonly string[] = [
  "admin_permissions",
  "appointment_series",
  "appointment_services",
  "appointments",
  "audit_log",
  "birthday_card_tracking",
  "budget_allocations",
  // INTERIM (rein additiver Prod-Publish): budget_ledger ist vorübergehend
  // wiederhergestellt; wird im separaten Folge-Publish endgültig entfernt.
  "budget_ledger",
  "budget_migrations",
  "budget_reservations",
  "budget_transactions",
  "company_settings",
  "customer_assignment_history",
  "customer_budget_preferences",
  "customer_budget_recipients",
  "customer_budget_type_settings",
  "customer_care_level_history",
  "customer_contacts",
  "customer_contract_rates",
  "customer_contracts",
  "customer_creation_idempotency_keys",
  "customer_documents",
  "customer_insurance_history",
  "customer_needs_assessments",
  "customer_service_prices",
  "customers",
  "document_deliveries",
  "document_signing_tokens",
  "document_template_billing_types",
  "document_templates",
  "document_type_triggers",
  "document_types",
  "employee_compensation_history",
  "employee_document_proofs",
  "employee_documents",
  "employee_month_closings",
  "employee_qualifications",
  "employee_time_entries",
  "employee_vacation_allowance",
  "generated_documents",
  "import_batches",
  "insurance_providers",
  "invoice_line_items",
  "invoices",
  "monthly_service_records",
  "notifications",
  "password_reset_tokens",
  "payment_advice_items",
  "payment_advices",
  "prices",
  "prospect_notes",
  "prospect_offers",
  "prospects",
  "qonto_transactions",
  "qualification_documents",
  "qualifications",
  "scheduled_calls",
  "service_budget_pots",
  "service_rates",
  "service_record_appointments",
  "services",
  "sessions",
  "system_settings",
  "tasks",
  "user_roles",
  "user_whatsapp_preferences",
  "users",
  "vacation_entitlement_history",
  "whatsapp_message_log",
  "whatsapp_notification_rules",
];

describe("Architektur — Schema-Tabellen-Allowlist (Task #1238)", () => {
  it("die pgTable-Definitionen entsprechen exakt der Allowlist", () => {
    const actual = extractPgTableNames();
    const { missing, unexpected } = diffTables(actual, EXPECTED_TABLES);
    if (missing.length > 0 || unexpected.length > 0) {
      const parts: string[] = [];
      if (unexpected.length > 0) {
        parts.push(
          "  NEUE/unerwartete Tabelle(n) im Schema (nicht in der Allowlist):\n    " +
            unexpected.join("\n    "),
        );
      }
      if (missing.length > 0) {
        parts.push(
          "  ENTFERNTE Tabelle(n) (in der Allowlist, aber nicht mehr im Schema):\n    " +
            missing.join("\n    "),
        );
      }
      expect.fail(
        "Schema-Tabellen-Allowlist verletzt:\n" +
          parts.join("\n") +
          "\n\nLaut Ersetzungs-Regel MUSS jede neue Tabelle benennen, was sie ERSETZT. " +
          "Ist die Änderung bewusst, pflege EXPECTED_TABLES in " +
          "tests/architecture/schema-table-allowlist.test.ts.",
      );
    }
  });

  it("Negativ: erkennt eine neu hinzugefügte UND eine entfernte Tabelle", () => {
    const expected = ["alpha", "beta", "gamma"];
    // Eine zusätzliche, nicht erlaubte Tabelle wird erkannt.
    expect(diffTables(["alpha", "beta", "gamma", "delta_neu"], expected)).toEqual({
      missing: [],
      unexpected: ["delta_neu"],
    });
    // Eine fehlende (erwartete, aber nicht vorhandene) Tabelle wird erkannt.
    expect(diffTables(["alpha", "gamma"], expected)).toEqual({
      missing: ["beta"],
      unexpected: [],
    });
  });
});
