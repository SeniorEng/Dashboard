import { Router, Request, Response } from "express";
import { customerManagementStorage } from "../../storage/customer-management";
import { insertInsuranceProviderSchema, insuranceProviderBaseSchema } from "@shared/schema";
import { ikNummerSchema } from "@shared/schema/common";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { requireSuperAdmin } from "../../middleware/auth";
import { auditService } from "../../services/audit";

const router = Router();

// ---------------------------------------------------------------------------
// Cleanup unbenutzter Pflegekassen (Task #1000), Superadmin-only.
// Das Löschen ist in Produktion deaktiviert (konsistent mit den Bulk-Purge-
// Werkzeugen) — die Vorschau-Zählung bleibt überall verfügbar.
// WICHTIG: Diese Routen MÜSSEN vor "/insurance-providers/:id" registriert
// werden, sonst würde "cleanup" als :id interpretiert.
// ---------------------------------------------------------------------------
const isProduction = () => process.env.NODE_ENV === "production";

router.get(
  "/insurance-providers/cleanup/unused-count",
  requireSuperAdmin,
  asyncHandler("Unbenutzte Pflegekassen konnten nicht ermittelt werden", async (_req: Request, res: Response) => {
    const stats = await customerManagementStorage.getUnusedInsuranceProviderStats();
    res.json({ ...stats, cleanupEnabled: !isProduction() });
  }),
);

router.post(
  "/insurance-providers/cleanup/unused",
  requireSuperAdmin,
  asyncHandler("Unbenutzte Pflegekassen konnten nicht gelöscht werden", async (req: Request, res: Response) => {
    if (isProduction()) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Das Aufräumen unbenutzter Pflegekassen ist in der Produktivumgebung deaktiviert.",
      });
      return;
    }

    const result = await customerManagementStorage.deleteUnusedInsuranceProviders();

    if (result.total > 0) {
      await auditService.log(
        req.user!.id,
        "insurance_providers_cleanup",
        "insurance_provider",
        0,
        {
          deletedTotal: result.total,
          deletedPrivate: result.private,
          deletedStatutory: result.statutory,
          deletedIds: result.deletedIds,
        },
        req.ip,
      );
    }

    res.json({
      deleted: result.total,
      deletedPrivate: result.private,
      deletedStatutory: result.statutory,
      message:
        result.total > 0
          ? `${result.total} unbenutzte Pflegekasse${result.total === 1 ? "" : "n"} wurde${result.total === 1 ? "" : "n"} gelöscht.`
          : "Es gab keine unbenutzten Pflegekassen zum Löschen.",
    });
  }),
);

// Insurance Providers (Lookup table)
router.get("/insurance-providers", asyncHandler("Pflegekassen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const includeInactive = req.query.all === "true";
  const providers = await customerManagementStorage.getInsuranceProviders(!includeInactive);
  res.json(providers);
}));

router.post("/insurance-providers", asyncHandler("Pflegekasse konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const validatedData = insertInsuranceProviderSchema.parse(req.body);
  
  if (validatedData.ikNummer && validatedData.ikNummer.trim()) {
    const existing = await customerManagementStorage.getInsuranceProviderByIK(validatedData.ikNummer);
    if (existing) {
      res.status(409).json({ error: "CONFLICT", message: "Eine Pflegekasse mit dieser IK-Nummer existiert bereits" });
      return;
    }
  }

  const dataToSave = {
    ...validatedData,
    ikNummer: validatedData.ikNummer && validatedData.ikNummer.trim() ? validatedData.ikNummer : null,
  };
  
  const provider = await customerManagementStorage.createInsuranceProvider(dataToSave);
  res.status(201).json(provider);
}));

router.get("/insurance-providers/:id", asyncHandler("Pflegekasse konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const provider = await customerManagementStorage.getInsuranceProvider(id);
  if (!provider) {
    res.status(404).json({ error: "NOT_FOUND", message: "Pflegekasse nicht gefunden" });
    return;
  }
  res.json(provider);
}));

router.get("/insurance-providers/:id/active-customers", asyncHandler("Kundenzuweisungen konnten nicht geprüft werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const count = await customerManagementStorage.getActiveCustomerCountForProvider(id);
  res.json({ count });
}));

router.put("/insurance-providers/:id", asyncHandler("Pflegekasse konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const validatedData = insuranceProviderBaseSchema.partial().parse(req.body);

  if (validatedData.ikNummer !== undefined) {
    validatedData.ikNummer = validatedData.ikNummer && validatedData.ikNummer.trim() ? validatedData.ikNummer : null;
  }

  const existingProvider = await customerManagementStorage.getInsuranceProvider(id);
  if (!existingProvider) {
    res.status(404).json({ error: "NOT_FOUND", message: "Pflegekasse nicht gefunden" });
    return;
  }

  const isPrivate = validatedData.isPrivate !== undefined ? validatedData.isPrivate : existingProvider.isPrivate;
  const ikNummer = validatedData.ikNummer !== undefined ? validatedData.ikNummer : existingProvider.ikNummer;
  if (!isPrivate && !ikNummer) {
    res.status(400).json({ error: "VALIDATION", message: "IK-Nummer ist für gesetzliche Pflegekassen erforderlich" });
    return;
  }

  if (ikNummer) {
    const ikResult = ikNummerSchema.safeParse(ikNummer);
    if (!ikResult.success) {
      res.status(400).json({ error: "VALIDATION", message: "IK-Nummer muss genau 9 Ziffern haben" });
      return;
    }
  }
  
  if (validatedData.ikNummer && validatedData.ikNummer.trim()) {
    const existing = await customerManagementStorage.getInsuranceProviderByIK(validatedData.ikNummer);
    if (existing && existing.id !== id) {
      res.status(409).json({ error: "CONFLICT", message: "Eine andere Pflegekasse mit dieser IK-Nummer existiert bereits" });
      return;
    }
  }
  
  const provider = await customerManagementStorage.updateInsuranceProvider(id, validatedData);
  if (!provider) {
    res.status(404).json({ error: "NOT_FOUND", message: "Pflegekasse nicht gefunden" });
    return;
  }
  res.json(provider);
}));

export default router;
