import { Router, Request, Response } from "express";
import { serviceCatalogStorage } from "../storage/service-catalog";
import { insertServiceSchema, updateServiceSchema, insertCustomerServicePriceSchema, insertEmployeeServiceRateSchema } from "@shared/schema";
import { requireAdmin } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { fromError } from "zod-validation-error";

const router = Router();

router.get("/", requireAuth, async (_req: Request, res: Response) => {
  try {
    const allServices = await serviceCatalogStorage.getAllServices(false);
    res.json(allServices);
  } catch (error) {
    handleRouteError(res, error, "Dienstleistungen konnten nicht geladen werden");
  }
});

router.get("/all", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const allServices = await serviceCatalogStorage.getAllServices(true);
    res.json(allServices);
  } catch (error) {
    handleRouteError(res, error, "Dienstleistungen konnten nicht geladen werden");
  }
});

router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const service = await serviceCatalogStorage.getServiceById(id);
    if (!service) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Dienstleistung nicht gefunden" });
    }
    res.json(service);
  } catch (error) {
    handleRouteError(res, error, "Dienstleistung konnte nicht geladen werden");
  }
});

router.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = insertServiceSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(result.error).message });
    }
    const service = await serviceCatalogStorage.createService(result.data);
    res.status(201).json(service);
  } catch (error) {
    handleRouteError(res, error, "Dienstleistung konnte nicht erstellt werden");
  }
});

router.put("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const result = updateServiceSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(result.error).message });
    }
    const service = await serviceCatalogStorage.updateService(id, result.data);
    if (!service) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Dienstleistung nicht gefunden" });
    }
    res.json(service);
  } catch (error) {
    handleRouteError(res, error, "Dienstleistung konnte nicht aktualisiert werden");
  }
});

router.get("/customer/:customerId/prices", requireAuth, async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const prices = await serviceCatalogStorage.resolveAllPrices(customerId, req.query.date as string | undefined);
    res.json(prices);
  } catch (error) {
    handleRouteError(res, error, "Kundenpreise konnten nicht geladen werden");
  }
});

router.get("/customer/:customerId/overrides", requireAdmin, async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const overrides = await serviceCatalogStorage.getCustomerServicePrices(customerId);
    res.json(overrides);
  } catch (error) {
    handleRouteError(res, error, "Sonderpreise konnten nicht geladen werden");
  }
});

router.post("/customer/:customerId/overrides", requireAdmin, async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const result = insertCustomerServicePriceSchema.safeParse({ ...req.body, customerId });
    if (!result.success) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(result.error).message });
    }
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "UNAUTHORIZED", message: "Nicht autorisiert" });
    }
    const override = await serviceCatalogStorage.upsertCustomerServicePrice(result.data, userId);
    res.status(201).json(override);
  } catch (error) {
    handleRouteError(res, error, "Sonderpreis konnte nicht gespeichert werden");
  }
});

router.delete("/customer/:customerId/overrides/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    await serviceCatalogStorage.deleteCustomerServicePrice(id);
    res.json({ success: true });
  } catch (error) {
    handleRouteError(res, error, "Sonderpreis konnte nicht gelöscht werden");
  }
});

router.get("/employee-rates", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const rates = await serviceCatalogStorage.getEmployeeServiceRates();
    res.json(rates);
  } catch (error) {
    handleRouteError(res, error, "Mitarbeiter-Vergütungssätze konnten nicht geladen werden");
  }
});

router.get("/employee-rates/all", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const rates = await serviceCatalogStorage.getAllEmployeeServiceRates();
    res.json(rates);
  } catch (error) {
    handleRouteError(res, error, "Mitarbeiter-Vergütungssätze konnten nicht geladen werden");
  }
});

router.post("/employee-rates", requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = insertEmployeeServiceRateSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: fromError(result.error).message });
    }
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "UNAUTHORIZED", message: "Nicht autorisiert" });
    }
    const rate = await serviceCatalogStorage.upsertEmployeeServiceRate(result.data, userId);
    res.status(201).json(rate);
  } catch (error) {
    handleRouteError(res, error, "Vergütungssatz konnte nicht gespeichert werden");
  }
});

export default router;
