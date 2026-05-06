import { Router, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../lib/db";
import { auditService } from "../../../services/audit";
import { asyncHandler } from "../../../lib/errors";

const router = Router();

interface DuplicateCustomer {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  status: string;
  geburtsdatum: string | null;
  stadt: string | null;
  strasse: string | null;
  nr: string | null;
  createdAt: Date;
  primaryEmployeeId: number | null;
  appointmentCount: number;
  budgetAllocationCount: number;
  budgetTransactionCount: number;
  documentCount: number;
  invoiceCount: number;
  contractCount: number;
  hasInsurance: boolean;
  hasContacts: boolean;
}

interface DuplicateGroup {
  key: string;
  displayName: string;
  customers: DuplicateCustomer[];
}

router.post(
  "/customers/duplicates",
  asyncHandler("Duplikate konnten nicht ermittelt werden", async (_req: Request, res: Response) => {
    const rows = await db.execute(sql`
      WITH active_customers AS (
        SELECT
          c.id,
          c.name,
          c.vorname,
          c.nachname,
          c.status,
          c.geburtsdatum,
          c.stadt,
          c.strasse,
          c.nr,
          c.created_at AS "createdAt",
          c.primary_employee_id AS "primaryEmployeeId",
          LOWER(REGEXP_REPLACE(TRIM(COALESCE(c.vorname, '') || ' ' || COALESCE(c.nachname, c.name)), '\\s+', ' ', 'g')) AS norm_key
        FROM customers c
        WHERE c.deleted_at IS NULL
          AND c.merged_into_customer_id IS NULL
          AND c.is_anonymized = false
          AND c.status = 'aktiv'
      ),
      dup_keys AS (
        SELECT norm_key
        FROM active_customers
        WHERE norm_key <> ''
        GROUP BY norm_key
        HAVING COUNT(*) > 1
      )
      SELECT
        ac.id,
        ac.name,
        ac.vorname,
        ac.nachname,
        ac.status,
        ac.geburtsdatum,
        ac.stadt,
        ac.strasse,
        ac.nr,
        ac."createdAt",
        ac."primaryEmployeeId",
        ac.norm_key AS key,
        (SELECT COUNT(*) FROM appointments a WHERE a.customer_id = ac.id AND a.deleted_at IS NULL) AS "appointmentCount",
        (SELECT COUNT(*) FROM budget_allocations ba WHERE ba.customer_id = ac.id AND ba.deleted_at IS NULL) AS "budgetAllocationCount",
        (SELECT COUNT(*) FROM budget_transactions bt WHERE bt.customer_id = ac.id) AS "budgetTransactionCount",
        (SELECT COUNT(*) FROM customer_documents cd WHERE cd.customer_id = ac.id) AS "documentCount",
        (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = ac.id) AS "invoiceCount",
        (SELECT COUNT(*) FROM customer_contracts cc WHERE cc.customer_id = ac.id) AS "contractCount",
        EXISTS(SELECT 1 FROM customer_insurance_history cih WHERE cih.customer_id = ac.id) AS "hasInsurance",
        EXISTS(SELECT 1 FROM customer_contacts cc2 WHERE cc2.customer_id = ac.id) AS "hasContacts"
      FROM active_customers ac
      INNER JOIN dup_keys dk ON dk.norm_key = ac.norm_key
      ORDER BY ac.norm_key, ac.id ASC
    `);

    const groups = new Map<string, DuplicateGroup>();
    for (const r of rows.rows as Array<Record<string, unknown>>) {
      const key = String(r.key);
      const customer: DuplicateCustomer = {
        id: Number(r.id),
        name: String(r.name),
        vorname: r.vorname as string | null,
        nachname: r.nachname as string | null,
        status: String(r.status),
        geburtsdatum: r.geburtsdatum as string | null,
        stadt: r.stadt as string | null,
        strasse: r.strasse as string | null,
        nr: r.nr as string | null,
        createdAt: r.createdAt as Date,
        primaryEmployeeId: r.primaryEmployeeId as number | null,
        appointmentCount: Number(r.appointmentCount),
        budgetAllocationCount: Number(r.budgetAllocationCount),
        budgetTransactionCount: Number(r.budgetTransactionCount),
        documentCount: Number(r.documentCount),
        invoiceCount: Number(r.invoiceCount),
        contractCount: Number(r.contractCount),
        hasInsurance: r.hasInsurance === true,
        hasContacts: r.hasContacts === true,
      };
      const displayName = `${customer.vorname ?? ""} ${customer.nachname ?? customer.name}`.trim();
      let group = groups.get(key);
      if (!group) {
        group = { key, displayName, customers: [] };
        groups.set(key, group);
      }
      group.customers.push(customer);
    }

    res.json({ groups: Array.from(groups.values()) });
  })
);

const mergeSchema = z.object({
  sourceCustomerId: z.number().int().positive(),
  targetCustomerId: z.number().int().positive(),
});

router.post(
  "/customers/merge",
  asyncHandler("Zusammenführen fehlgeschlagen", async (req: Request, res: Response) => {
    const { sourceCustomerId, targetCustomerId } = mergeSchema.parse(req.body);

    if (sourceCustomerId === targetCustomerId) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Quelle und Ziel dürfen nicht identisch sein" });
      return;
    }

    const userId = req.user!.id;

    const summary = await db.transaction(async (tx) => {
      // Lock both customer rows in a deterministic order (lowest ID first) to avoid deadlocks.
      const lockIds = [sourceCustomerId, targetCustomerId].sort((a, b) => a - b);
      const locked = await tx.execute(sql`
        SELECT id, name, vorname, nachname, status, merged_into_customer_id, deleted_at, is_anonymized
        FROM customers
        WHERE id IN (${lockIds[0]}, ${lockIds[1]})
        ORDER BY id ASC
        FOR UPDATE
      `);

      const lockedRows = locked.rows as Array<Record<string, unknown>>;
      const source = lockedRows.find((r) => Number(r.id) === sourceCustomerId) ?? null;
      const target = lockedRows.find((r) => Number(r.id) === targetCustomerId) ?? null;

      if (!source) throw new Error(`Quellkunde mit ID ${sourceCustomerId} nicht gefunden`);
      if (!target) throw new Error(`Zielkunde mit ID ${targetCustomerId} nicht gefunden`);
      if (source.merged_into_customer_id) throw new Error(`Quellkunde ${sourceCustomerId} wurde bereits zusammengeführt`);
      if (target.merged_into_customer_id) throw new Error(`Zielkunde ${targetCustomerId} wurde bereits zusammengeführt`);
      if (source.deleted_at) throw new Error(`Quellkunde ${sourceCustomerId} ist gelöscht`);
      if (target.deleted_at) throw new Error(`Zielkunde ${targetCustomerId} ist gelöscht`);
      if (source.is_anonymized) throw new Error(`Quellkunde ${sourceCustomerId} ist anonymisiert`);
      if (target.is_anonymized) throw new Error(`Zielkunde ${targetCustomerId} ist anonymisiert – Zusammenführen würde Datenschutz verletzen`);

      // Enforce same-name policy: both customers must share the normalized
      // "vorname nachname" key. This blocks merges of unrelated records via
      // crafted requests that bypass the UI.
      const normalize = (vor: unknown, nach: unknown, name: unknown): string => {
        const combined = `${(vor as string | null) ?? ""} ${(nach as string | null) ?? (name as string | null) ?? ""}`;
        return combined.trim().toLowerCase().replace(/\s+/g, " ");
      };
      const sourceKey = normalize(source.vorname, source.nachname, source.name);
      const targetKey = normalize(target.vorname, target.nachname, target.name);
      if (!sourceKey || sourceKey !== targetKey) {
        throw new Error(
          `Zusammenführen abgelehnt: Quell- und Zielkunde haben unterschiedliche Namen (${sourceKey || "—"} vs. ${targetKey || "—"}). Nur Kunden mit identischem Namen dürfen zusammengeführt werden.`
        );
      }

      const counts: Record<string, number> = {};

      // Helper for simple FK reassignments
      const simpleUpdate = async (table: string, column: string) => {
        const r = await tx.execute(sql.raw(`UPDATE ${table} SET ${column} = ${targetCustomerId} WHERE ${column} = ${sourceCustomerId}`));
        counts[table] = (r as unknown as { rowCount?: number }).rowCount ?? 0;
      };

      // Tables with simple FKs (no unique constraints involving customer_id)
      await simpleUpdate("appointments", "customer_id");
      await simpleUpdate("appointment_series", "customer_id");
      await simpleUpdate("budget_transactions", "customer_id");
      await simpleUpdate("customer_contacts", "customer_id");
      await simpleUpdate("customer_care_level_history", "customer_id");
      await simpleUpdate("customer_needs_assessments", "customer_id");
      await simpleUpdate("customer_assignment_history", "customer_id");
      await simpleUpdate("customer_insurance_history", "customer_id");
      await simpleUpdate("customer_budgets", "customer_id");
      await simpleUpdate("customer_documents", "customer_id");
      await simpleUpdate("generated_documents", "customer_id");
      await simpleUpdate("monthly_service_records", "customer_id");
      await simpleUpdate("customer_contracts", "customer_id");
      await simpleUpdate("tasks", "customer_id");
      await simpleUpdate("invoices", "customer_id");
      await simpleUpdate("doc_deliveries", "customer_id");

      // prospects.converted_customer_id
      const prospectsResult = await tx.execute(sql`
        UPDATE prospects SET converted_customer_id = ${targetCustomerId} WHERE converted_customer_id = ${sourceCustomerId}
      `);
      counts["prospects"] = (prospectsResult as unknown as { rowCount?: number }).rowCount ?? 0;

      // ============================
      // Tables with unique constraints involving customer_id:
      // delete conflicting source rows first, then reassign remaining ones.
      // ============================

      // customer_budget_preferences: UNIQUE (customer_id)
      const cbpDel = await tx.execute(sql`
        DELETE FROM customer_budget_preferences
        WHERE customer_id = ${sourceCustomerId}
          AND EXISTS (SELECT 1 FROM customer_budget_preferences WHERE customer_id = ${targetCustomerId})
      `);
      const cbpUpd = await tx.execute(sql`
        UPDATE customer_budget_preferences SET customer_id = ${targetCustomerId} WHERE customer_id = ${sourceCustomerId}
      `);
      counts["customer_budget_preferences"] = (cbpUpd as unknown as { rowCount?: number }).rowCount ?? 0;
      counts["customer_budget_preferences_deleted"] = (cbpDel as unknown as { rowCount?: number }).rowCount ?? 0;

      // customer_budget_type_settings: UNIQUE (customer_id, budget_type)
      const cbtsDel = await tx.execute(sql`
        DELETE FROM customer_budget_type_settings s
        WHERE s.customer_id = ${sourceCustomerId}
          AND EXISTS (
            SELECT 1 FROM customer_budget_type_settings t
            WHERE t.customer_id = ${targetCustomerId} AND t.budget_type = s.budget_type
          )
      `);
      const cbtsUpd = await tx.execute(sql`
        UPDATE customer_budget_type_settings SET customer_id = ${targetCustomerId} WHERE customer_id = ${sourceCustomerId}
      `);
      counts["customer_budget_type_settings"] = (cbtsUpd as unknown as { rowCount?: number }).rowCount ?? 0;
      counts["customer_budget_type_settings_deleted"] = (cbtsDel as unknown as { rowCount?: number }).rowCount ?? 0;

      // customer_service_prices: UNIQUE (customer_id, service_id, valid_to)
      // (NULL valid_to is treated as distinct in PG, so we explicitly use IS NOT DISTINCT FROM)
      const cspDel = await tx.execute(sql`
        DELETE FROM customer_service_prices s
        WHERE s.customer_id = ${sourceCustomerId}
          AND EXISTS (
            SELECT 1 FROM customer_service_prices t
            WHERE t.customer_id = ${targetCustomerId}
              AND t.service_id = s.service_id
              AND t.valid_to IS NOT DISTINCT FROM s.valid_to
          )
      `);
      const cspUpd = await tx.execute(sql`
        UPDATE customer_service_prices SET customer_id = ${targetCustomerId} WHERE customer_id = ${sourceCustomerId}
      `);
      counts["customer_service_prices"] = (cspUpd as unknown as { rowCount?: number }).rowCount ?? 0;
      counts["customer_service_prices_deleted"] = (cspDel as unknown as { rowCount?: number }).rowCount ?? 0;

      // budget_allocations: UNIQUE (customer_id, budget_type, year, month, source)
      const baDel = await tx.execute(sql`
        DELETE FROM budget_allocations s
        WHERE s.customer_id = ${sourceCustomerId}
          AND EXISTS (
            SELECT 1 FROM budget_allocations t
            WHERE t.customer_id = ${targetCustomerId}
              AND t.budget_type = s.budget_type
              AND t.year = s.year
              AND t.month IS NOT DISTINCT FROM s.month
              AND t.source = s.source
          )
      `);
      const baUpd = await tx.execute(sql`
        UPDATE budget_allocations SET customer_id = ${targetCustomerId} WHERE customer_id = ${sourceCustomerId}
      `);
      counts["budget_allocations"] = (baUpd as unknown as { rowCount?: number }).rowCount ?? 0;
      counts["budget_allocations_deleted"] = (baDel as unknown as { rowCount?: number }).rowCount ?? 0;

      // Redirect any existing chained merges: if other customers were previously merged INTO source,
      // re-point them at target so we never have A -> B -> C chains.
      const chainResult = await tx.execute(sql`
        UPDATE customers
        SET merged_into_customer_id = ${targetCustomerId}
        WHERE merged_into_customer_id = ${sourceCustomerId}
      `);
      counts["customers_chain_redirected"] = (chainResult as unknown as { rowCount?: number }).rowCount ?? 0;

      // Mark source customer as merged + inactive
      await tx.execute(sql`
        UPDATE customers
        SET merged_into_customer_id = ${targetCustomerId},
            status = 'inaktiv',
            updated_at = NOW()
        WHERE id = ${sourceCustomerId}
      `);

      return {
        source,
        target,
        counts,
      };
    });

    // Audit log (outside transaction; failure must not roll back the merge)
    await auditService
      .log(
        userId,
        "customer_merged",
        "customer",
        targetCustomerId,
        {
          sourceCustomerId,
          targetCustomerId,
          sourceName: `${(summary.source as Record<string, unknown>).vorname ?? ""} ${(summary.source as Record<string, unknown>).nachname ?? (summary.source as Record<string, unknown>).name}`.trim(),
          targetName: `${(summary.target as Record<string, unknown>).vorname ?? ""} ${(summary.target as Record<string, unknown>).nachname ?? (summary.target as Record<string, unknown>).name}`.trim(),
          counts: summary.counts,
        },
        req.ip
      )
      .catch((err) => console.error("[merge] audit log failed:", err));

    res.json({
      success: true,
      sourceCustomerId,
      targetCustomerId,
      counts: summary.counts,
    });
  })
);

export default router;
