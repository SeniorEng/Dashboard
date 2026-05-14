/**
 * Task #444 — Wrapper-Vertrag `withAudit` (DB-Integration).
 *
 * Testet die generische Rollback-Garantie des Wrappers direkt gegen
 * PostgreSQL, unabhängig von der konkreten Mutationsroute. Damit ist die
 * gleiche Garantie auch für /api/billing/:id/send und /api/billing/send-batch
 * abgedeckt, ohne die teure PDF/Email-Pipeline triggern zu müssen.
 *
 * Geprüfte Invarianten:
 *   1. Bei erfolgreichem Lauf wird genau ein audit_log-Eintrag pro
 *      `audit.record(...)` geschrieben.
 *   2. Bei `faults: new Set(["audit_log"])` wirft der Wrapper, und die
 *      in der Mutation eingefügte DB-Zeile ist NICHT committet (Rollback).
 *   3. Bei Fehler im Audit-Insert selbst (z.B. ungültige FK) wirft der
 *      Wrapper ebenfalls und rollt die Mutation zurück — kein
 *      stilles Schlucken im tx-Pfad.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../server/lib/db";
import { withAudit } from "../server/lib/with-audit";
import { auditService } from "../server/services/audit";
import { auditLog } from "@shared/schema";
import { sql, eq, and } from "drizzle-orm";

const SENTINEL_USER_ID = 1; // Setup-Admin existiert in jeder Test-DB.

async function countAuditByMeta(token: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM audit_log
    WHERE metadata->>'sentinel' = ${token}
  `);
  return (res.rows[0] as { count: number }).count;
}

describe("Task #444 — withAudit Tx-Vertrag", () => {
  beforeAll(async () => {
    // Sanity: User existiert (FK-Constraint audit_log.user_id).
    const r = await db.execute(sql`SELECT id FROM users WHERE id = ${SENTINEL_USER_ID} LIMIT 1`);
    expect(r.rows.length, "SENTINEL_USER_ID muss existieren").toBe(1);
  });

  it("Happy-Path: audit.record(...) schreibt genau einen Eintrag", async () => {
    const token = `t444-happy-${Date.now()}-${Math.random()}`;
    const result = await withAudit(async (_tx, audit) => {
      audit.record({
        userId: SENTINEL_USER_ID,
        action: "documentation_submitted",
        entityType: "appointment",
        entityId: 999999999,
        metadata: { sentinel: token },
      });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(await countAuditByMeta(token)).toBe(1);
  });

  it("fault audit_log: Mutation in der Tx wird zurückgerollt", async () => {
    const token = `t444-fault-${Date.now()}-${Math.random()}`;

    // Mutation in der Tx: wir setzen einen "Vorab"-Audit-Eintrag mit dem
    // selben Sentinel-Token via auditService.log(..., tx). Wenn das Rollback
    // greift, ist auch DIESE Zeile nicht persistiert.
    await expect(
      withAudit(
        async (tx, audit) => {
          await auditService.log(
            SENTINEL_USER_ID,
            "documentation_submitted",
            "appointment",
            999999998,
            { sentinel: token, phase: "pre" },
            undefined,
            tx,
          );
          audit.record({
            userId: SENTINEL_USER_ID,
            action: "documentation_submitted",
            entityType: "appointment",
            entityId: 999999998,
            metadata: { sentinel: token, phase: "post" },
          });
          return "should-rollback";
        },
        { faults: new Set(["audit_log"]) },
      ),
    ).rejects.toThrow();

    expect(
      await countAuditByMeta(token),
      "Bei Audit-Fault muss die gesamte Tx (inkl. pre-Mutation) rollback sein",
    ).toBe(0);
  });

  it("Fehler im Audit-Insert (ungültige FK) rollt Tx zurück", async () => {
    const token = `t444-fkerr-${Date.now()}-${Math.random()}`;
    await expect(
      withAudit(async (tx, audit) => {
        await auditService.log(
          SENTINEL_USER_ID,
          "documentation_submitted",
          "appointment",
          999999997,
          { sentinel: token, phase: "pre" },
          undefined,
          tx,
        );
        audit.record({
          // userId existiert NICHT → FK-Verletzung beim Insert.
          userId: -1,
          action: "documentation_submitted",
          entityType: "appointment",
          entityId: 999999997,
          metadata: { sentinel: token, phase: "post" },
        });
      }),
    ).rejects.toThrow();

    expect(
      await countAuditByMeta(token),
      "FK-Fehler im Audit-Insert muss Mutation rollbacken",
    ).toBe(0);
  });
});
