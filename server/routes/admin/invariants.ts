/**
 * Task #1237 (Phase 0.1) — Read-only SuperAdmin-Report für die Invarianten-Suite.
 *
 * `GET /api/admin/invariants-report` führt `runInvariantSuite` gegen die DB aus
 * und liefert den strukturierten JSON-Report zurück. AUSSCHLIESSLICH lesend:
 * kein Auto-Fix, keine Mutation. Nur Superadmins (sensible kundenübergreifende
 * Diagnose). Der Pfad steht NICHT in der ROUTE_PERMISSION_MAP des Admin-Routers,
 * daher ist `requireSuperAdmin` hier der einzige Zugriffsschutz.
 */
import { Router, type Request, type Response } from "express";
import { requireSuperAdmin } from "../../middleware/auth";
import { asyncHandler } from "../../lib/errors";
import { db } from "../../lib/db";
import { runInvariantSuite } from "../../lib/invariants";

const router = Router();

router.get(
  "/invariants-report",
  requireSuperAdmin,
  asyncHandler(
    "Invarianten-Report konnte nicht erstellt werden",
    async (_req: Request, res: Response) => {
      const report = await runInvariantSuite(db);
      res.json(report);
    },
  ),
);

export default router;
