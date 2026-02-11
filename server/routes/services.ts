import { Router, Request, Response } from "express";
import { serviceCatalogStorage } from "../storage/service-catalog";
import { insertServiceSchema, updateServiceSchema } from "@shared/schema";
import { requireAdmin } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/errors";
import { fromError } from "zod-validation-error";

const router = Router();

router.get("/", requireAuth, asyncHandler("Dienstleistungen konnten nicht geladen werden", async (_req: Request, res: Response) => {
  const allServices = await serviceCatalogStorage.getAllServices(false);
  const budgetPots = await serviceCatalogStorage.getAllServiceBudgetPots();
  const servicesWithPots = allServices.map(s => ({
    ...s,
    budgetPots: budgetPots.filter(bp => bp.serviceId === s.id).map(bp => bp.budgetType),
  }));
  res.json(servicesWithPots);
}));

router.get("/all", requireAdmin, asyncHandler("Dienstleistungen konnten nicht geladen werden", async (_req: Request, res: Response) => {
  const allServices = await serviceCatalogStorage.getAllServices(true);
  const budgetPots = await serviceCatalogStorage.getAllServiceBudgetPots();
  const servicesWithPots = allServices.map(s => ({
    ...s,
    budgetPots: budgetPots.filter(bp => bp.serviceId === s.id).map(bp => bp.budgetType),
  }));
  res.json(servicesWithPots);
}));

router.get("/:id", requireAuth, asyncHandler("Dienstleistung konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const service = await serviceCatalogStorage.getServiceById(id);
  if (!service) {
    return res.status(404).json({ error: "NOT_FOUND", message: "Dienstleistung nicht gefunden" });
  }
  const budgetPots = await serviceCatalogStorage.getServiceBudgetPots(id);
  res.json({ ...service, budgetPots: budgetPots.map(bp => bp.budgetType) });
}));

router.post("/", requireAdmin, asyncHandler("Dienstleistung konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const result = insertServiceSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(result.error).message });
  }
  const service = await serviceCatalogStorage.createService(result.data);
  const budgetPots = await serviceCatalogStorage.getServiceBudgetPots(service.id);
  res.status(201).json({ ...service, budgetPots: budgetPots.map(bp => bp.budgetType) });
}));

router.put("/:id", requireAdmin, asyncHandler("Dienstleistung konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const result = updateServiceSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(result.error).message });
  }
  const service = await serviceCatalogStorage.updateService(id, result.data);
  if (!service) {
    return res.status(404).json({ error: "NOT_FOUND", message: "Dienstleistung nicht gefunden" });
  }
  const budgetPots = await serviceCatalogStorage.getServiceBudgetPots(id);
  res.json({ ...service, budgetPots: budgetPots.map(bp => bp.budgetType) });
}));

export default router;
