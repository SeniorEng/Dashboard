import { Router, Request, Response } from "express";
import { serviceCatalogStorage } from "../storage/service-catalog";
import { requireAdmin } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import standardPricesRouter from "./standard-prices";
import roleWageRatesRouter from "./role-wage-rates";

const router = Router();

// Task #1357 — firmenweite Standardpreise (zeitversioniert, editierbar). Die
// Katalog-IDENTITÄT bleibt read-only (siehe 403-Routen unten); nur die
// `standard`-Preiszeilen in der `prices`-SSoT sind über diese Routen pflegbar.
router.use(standardPricesRouter);

// Task #1503 — rollenbasierte Vergütung (Lohnsatz je Rolle × Leistung,
// zeitversioniert). Schreibt in die `role_wage_rates`-SSoT hinter `wageFor`.
router.use(roleWageRatesRouter);

/**
 * Der Dienstleistungskatalog ist konfigurationsgesteuert
 * (`shared/config/services.ts`). Schreibwege sind bewusst gesperrt: neue oder
 * geänderte Services entstehen nur durch eine Code-Änderung mit Review und
 * werden beim Start über `syncServiceCatalog()` in die DB übernommen.
 */
const SERVICE_CATALOG_READONLY_MESSAGE =
  "Der Dienstleistungskatalog ist konfigurationsgesteuert (shared/config/services.ts). " +
  "Neue oder geänderte Leistungen entstehen ausschließlich durch eine Code-Änderung mit Review, nicht über die API.";

function serviceCatalogReadonly(_req: Request, res: Response) {
  res.status(403).json({
    error: "SERVICE_CATALOG_READONLY",
    message: SERVICE_CATALOG_READONLY_MESSAGE,
  });
}

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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const service = await serviceCatalogStorage.getServiceById(id);
  if (!service) {
    return res.status(404).json({ error: "NOT_FOUND", message: "Dienstleistung nicht gefunden" });
  }
  const budgetPots = await serviceCatalogStorage.getServiceBudgetPots(id);
  res.json({ ...service, budgetPots: budgetPots.map(bp => bp.budgetType) });
}));

router.post("/", requireAdmin, serviceCatalogReadonly);

router.put("/:id", requireAdmin, serviceCatalogReadonly);

export default router;
