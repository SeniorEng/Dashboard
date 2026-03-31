import { Router, Request, Response } from "express";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { requireAuth, requireAdmin, requireCustomerAccess } from "../middleware/auth";
import { storage } from "../storage";
import { asyncHandler } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { 
  insertBudgetAllocationSchema, 
  insertBudgetPreferencesSchema,
  type BudgetAllocation,
} from "@shared/schema";
import { z } from "zod";
import { todayISO, parseLocalDate } from "@shared/utils/datetime";
import { BUDGET_TYPES } from "@shared/domain/budgets";
import { auditService } from "../services/audit";

const router = Router();

router.use(requireAuth);

const checkCustomerAccess = requireCustomerAccess(
  (employeeId) => storage.getAssignedCustomerIds(employeeId)
);

router.get("/:customerId/summary", checkCustomerAccess, asyncHandler("Budget-Übersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  await budgetLedgerStorage.syncBudgetAllocations(customerId);
  const summary = await budgetLedgerStorage.getBudgetSummary(customerId);
  res.json(summary);
}));

router.get("/:customerId/allocations", checkCustomerAccess, asyncHandler("Budget-Zuweisungen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;

  const allocations = await budgetLedgerStorage.getBudgetAllocations(customerId, year);
  res.json(allocations);
}));

router.get("/:customerId/transactions", checkCustomerAccess, asyncHandler("Budget-Transaktionen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;

  const budgetType = req.query.budgetType as string | undefined;
  const transactions = await budgetLedgerStorage.getBudgetTransactions(customerId, { year, limit, budgetType });
  res.json(transactions);
}));

router.get("/:customerId/preferences", checkCustomerAccess, asyncHandler("Budget-Einstellungen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const preferences = await budgetLedgerStorage.getBudgetPreferences(customerId);
  res.json(preferences || { customerId, monthlyLimitCents: null, budgetStartDate: null, notes: null });
}));

router.get("/:customerId/cost-estimate", checkCustomerAccess, asyncHandler("Kostenschätzung konnte nicht berechnet werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const date = (req.query.date as string) || todayISO();

  const { serviceCatalogStorage } = await import("../storage/service-catalog");

  let totalCostCents = 0;
  let weightedVatRate = 19;
  const costDetails: { serviceId: number; costCents: number; vatRate: number }[] = [];

  const serviceIdsParam = req.query.serviceIds as string | undefined;
  const serviceDurationsParam = req.query.serviceDurations as string | undefined;

  try {
    if (serviceIdsParam && serviceDurationsParam) {
      const serviceIds = serviceIdsParam.split(",").map(Number);
      const durations = serviceDurationsParam.split(",").map(Number);

      const { sql: sqlTag } = await import("drizzle-orm");
      const { db: dbInstance } = await import("../lib/db");
      const cspResult = await dbInstance.execute(sqlTag`
        SELECT service_id AS "serviceId", price_cents AS "priceCents"
        FROM customer_service_prices
        WHERE customer_id = ${customerId}
          AND valid_from::date <= ${date}::date
          AND (valid_to IS NULL OR valid_to::date >= ${date}::date)
      `);
      const cspMap = new Map((cspResult.rows as any[]).map(r => [r.serviceId, r.priceCents]));

      const allServices = await serviceCatalogStorage.getServicesByIds(serviceIds);
      const serviceMap = new Map(allServices.map(s => [s.id, s]));

      for (let i = 0; i < serviceIds.length; i++) {
        const service = serviceMap.get(serviceIds[i]);
        if (!service || !service.isBillable) continue;
        
        const durationMinutes = durations[i] || 0;
        const effectivePrice = cspMap.get(service.id) ?? service.defaultPriceCents;
        let costCents = 0;
        if (service.unitType === "hours") {
          costCents = Math.round((durationMinutes / 60) * effectivePrice);
        } else if (service.unitType === "flat") {
          costCents = effectivePrice;
        }
        if (costCents > 0) {
          totalCostCents += costCents;
          costDetails.push({ serviceId: service.id, costCents, vatRate: service.vatRate });
        }
      }
    } else {
      const hauswirtschaftMinutes = parseInt(req.query.hauswirtschaftMinutes as string) || 0;
      const alltagsbegleitungMinutes = parseInt(req.query.alltagsbegleitungMinutes as string) || 0;
      const travelKilometers = parseFloat(req.query.travelKilometers as string) || 0;
      const customerKilometers = parseFloat(req.query.customerKilometers as string) || 0;
      
      const costs = await budgetLedgerStorage.calculateAppointmentCost({
        customerId,
        hauswirtschaftMinutes,
        alltagsbegleitungMinutes,
        travelKilometers,
        customerKilometers,
        date,
      });
      totalCostCents = costs.totalCents;

      const [hwService, abService, kmService] = await Promise.all([
        serviceCatalogStorage.getServiceByCode("hauswirtschaft"),
        serviceCatalogStorage.getServiceByCode("alltagsbegleitung"),
        serviceCatalogStorage.getServiceByCode("kilometer"),
      ]);
      if (hwService && hauswirtschaftMinutes > 0) costDetails.push({ serviceId: hwService.id, costCents: costs.hauswirtschaftCents, vatRate: hwService.vatRate });
      if (abService && alltagsbegleitungMinutes > 0) costDetails.push({ serviceId: abService.id, costCents: costs.alltagsbegleitungCents, vatRate: abService.vatRate });
      if (kmService && (travelKilometers > 0 || customerKilometers > 0)) costDetails.push({ serviceId: kmService.id, costCents: costs.travelCents + costs.customerKilometersCents, vatRate: kmService.vatRate });
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("Preisvereinbarung")) {
      res.json({
        hauswirtschaftCents: 0,
        alltagsbegleitungCents: 0,
        travelCents: 0,
        customerKilometersCents: 0,
        totalCents: 0,
        warning: "Keine Preisvereinbarung hinterlegt – Kosten können nicht berechnet werden.",
        noPricing: true,
      });
      return;
    }
    throw error;
  }

  const customer = await storage.getCustomer(customerId);
  const acceptsPrivatePayment = customer?.acceptsPrivatePayment ?? false;

  if (costDetails.length > 0) {
    const totalCost = costDetails.reduce((s, c) => s + c.costCents, 0);
    if (totalCost > 0) {
      weightedVatRate = costDetails.reduce((s, c) => s + (c.vatRate * c.costCents / totalCost), 0);
    }
  }

  const summaries = await budgetLedgerStorage.getAllBudgetSummaries(customerId);
  const summary45b = summaries.entlastungsbetrag45b;
  const summary45a = summaries.umwandlung45a;
  const summary39_42a = summaries.ersatzpflege39_42a;

  const totalAvailable = summary45a.currentMonthAvailableCents + summary45b.availableCents + summary39_42a.currentYearAvailableCents;

  let warning: string | null = null;
  let isHardBlock = false;
  let privateCents = 0;
  let vatCents = 0;

  if (summary45b.monthlyLimitCents !== null) {
    const appointmentDate = parseLocalDate(date);
    const today = parseLocalDate(todayISO());
    const isSameMonth = appointmentDate.getFullYear() === today.getFullYear() && appointmentDate.getMonth() === today.getMonth();

    let appointmentMonthUsedCents = summary45b.currentMonthUsedCents;
    if (!isSameMonth) {
      const { sql: sqlTag } = await import("drizzle-orm");
      const { db: dbInstance } = await import("../lib/db");
      const appointmentMonthStart = `${appointmentDate.getFullYear()}-${String(appointmentDate.getMonth() + 1).padStart(2, '0')}-01`;
      const appointmentMonthEndDate = new Date(appointmentDate.getFullYear(), appointmentDate.getMonth() + 1, 0);
      const appointmentMonthEnd = `${appointmentMonthEndDate.getFullYear()}-${String(appointmentMonthEndDate.getMonth() + 1).padStart(2, '0')}-${String(appointmentMonthEndDate.getDate()).padStart(2, '0')}`;
      const monthResult = await dbInstance.execute(sqlTag`
        SELECT COALESCE(SUM(ABS(amount_cents)), 0) as total
        FROM budget_transactions
        WHERE customer_id = ${customerId}
          AND budget_type = 'entlastungsbetrag_45b'
          AND transaction_type = 'consumption'
          AND transaction_date >= ${appointmentMonthStart}
          AND transaction_date <= ${appointmentMonthEnd}
      `);
      appointmentMonthUsedCents = Number((monthResult.rows[0] as any)?.total ?? 0);
    }

    const monthlyRemaining45b = Math.max(0, summary45b.monthlyLimitCents - appointmentMonthUsedCents);
    const effectiveAvailable = summary45a.currentMonthAvailableCents + monthlyRemaining45b + summary39_42a.currentYearAvailableCents;
    if (totalCostCents > effectiveAvailable) {
      const remainingEuro = (monthlyRemaining45b / 100).toFixed(2).replace(".", ",");
      warning = `Monatslimit fast erreicht — noch ${remainingEuro} € verfügbar.`;
    }
  }

  if (totalCostCents > totalAvailable) {
    const shortfall = totalCostCents - totalAvailable;
    const shortfallEuro = (shortfall / 100).toFixed(2).replace(".", ",");

    if (acceptsPrivatePayment) {
      privateCents = shortfall;
      vatCents = Math.round(shortfall * (weightedVatRate / 100));
      warning = `Budget reicht nicht — ${shortfallEuro} € werden privat berechnet.`;
    } else {
      warning = `Budget reicht nicht — es fehlen ${shortfallEuro} €.`;
      isHardBlock = true;
    }
  }

  res.json({
    totalCents: totalCostCents,
    availableCents: totalAvailable,
    currentMonthUsedCents: summary45b.currentMonthUsedCents,
    monthlyLimitCents: summary45b.monthlyLimitCents,
    warning,
    isHardBlock,
    privateCents,
    vatCents,
    vatRate: Math.round(weightedVatRate),
    acceptsPrivatePayment,
  });
}));

router.get("/:customerId/overview", checkCustomerAccess, asyncHandler("Budget-Übersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const summaries = await budgetLedgerStorage.getAllBudgetSummaries(customerId);

  const s45b = summaries.entlastungsbetrag45b;
  res.json({
    entlastungsbetrag45b: {
      totalAllocatedCents: s45b.totalAllocatedCents,
      totalUsedCents: s45b.totalUsedCents,
      availableCents: s45b.availableCents,
      plannedCents: s45b.plannedCents,
      availableAfterPlannedCents: s45b.availableAfterPlannedCents,
      currentMonthUsedCents: s45b.currentMonthUsedCents,
      monthlyLimitCents: s45b.monthlyLimitCents,
      carryoverCents: s45b.carryoverCents,
      carryoverExpiresAt: s45b.carryoverExpiresAt,
      currentYearAllocatedCents: s45b.currentYearAllocatedCents,
    },
    umwandlung45a: {
      monthlyBudgetCents: summaries.umwandlung45a.monthlyBudgetCents,
      currentMonthAllocatedCents: summaries.umwandlung45a.currentMonthAllocatedCents,
      currentMonthUsedCents: summaries.umwandlung45a.currentMonthUsedCents,
      currentMonthAvailableCents: summaries.umwandlung45a.currentMonthAvailableCents,
      label: "§45a Umwandlungsanspruch",
    },
    ersatzpflege39_42a: {
      yearlyBudgetCents: summaries.ersatzpflege39_42a.yearlyBudgetCents,
      currentYearAllocatedCents: summaries.ersatzpflege39_42a.currentYearAllocatedCents,
      currentYearUsedCents: summaries.ersatzpflege39_42a.currentYearUsedCents,
      currentYearAvailableCents: summaries.ersatzpflege39_42a.currentYearAvailableCents,
      label: "§39/§42a Gemeinsamer Jahresbetrag",
    },
  });
}));

router.use(requireAdmin);

router.get("/:customerId/type-settings", asyncHandler("Budget-Typ-Einstellungen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const settings = await budgetLedgerStorage.getBudgetTypeSettings(customerId);
  const defaults: { budgetType: string; enabled: boolean; priority: number; monthlyLimitCents: number | null; yearlyLimitCents: number | null; validFrom: string | null; validTo: string | null }[] = [
    { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
  ];
  if (settings.length === 0) {
    const prefs = await budgetLedgerStorage.getBudgetPreferences(customerId);
    if (prefs?.monthlyLimitCents !== null && prefs?.monthlyLimitCents !== undefined) {
      defaults[0].monthlyLimitCents = prefs.monthlyLimitCents;
    }
    res.json(defaults.map(d => ({ ...d, customerId, id: null })));
  } else {
    const settingsMap = new Map(settings.map(s => [s.budgetType, s]));
    const merged = defaults.map(d => {
      const s = settingsMap.get(d.budgetType);
      return s || { ...d, customerId, id: null };
    });
    merged.sort((a, b) => a.priority - b.priority);
    const seenPriorities = new Set<number>();
    const needsRenumber = merged.some(m => {
      if (seenPriorities.has(m.priority)) return true;
      seenPriorities.add(m.priority);
      return false;
    });
    if (needsRenumber) {
      merged.forEach((m, i) => { m.priority = i + 1; });
    }
    res.json(merged);
  }
}));

router.get("/:customerId/initial-balances/:budgetType", asyncHandler("Startwert-Historie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const budgetType = req.params.budgetType;
  const allocations = await budgetLedgerStorage.getInitialBalanceAllocations(customerId, budgetType);
  res.json(allocations);
}));

const initialBalanceSchema = z.object({
  amountCents: z.number().min(1),
  validFrom: z.string().regex(/^\d{4}-\d{2}$/),
});

router.post("/:customerId/initial-balance/:budgetType", requireAdmin, asyncHandler("Startwert konnte nicht gespeichert werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const budgetType = req.params.budgetType;

  const result = initialBalanceSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }

  const [yearStr, monthStr] = result.data.validFrom.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  const validFromDate = `${result.data.validFrom}-01`;
  const expiresAt = budgetType === "ersatzpflege_39_42a" ? `${year}-12-31` : null;
  const userId = req.user?.id;

  await budgetLedgerStorage.upsertInitialBalanceAllocation({
    customerId,
    budgetType,
    year,
    month,
    amountCents: result.data.amountCents,
    validFrom: validFromDate,
    expiresAt,
    notes: `Startwert ab ${monthStr}/${yearStr}`,
  }, userId);

  if (budgetType === "entlastungsbetrag_45b") {
    const existingPrefs = await budgetLedgerStorage.getBudgetPreferences(customerId);
    if (!existingPrefs?.budgetStartDate || validFromDate < existingPrefs.budgetStartDate) {
      await budgetLedgerStorage.upsertBudgetPreferences({
        customerId,
        budgetStartDate: validFromDate,
        monthlyLimitCents: existingPrefs?.monthlyLimitCents ?? null,
        notes: existingPrefs?.notes ?? null,
      }, userId);
    }
  }

  if (userId) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.log(userId, "initial_balance_set", "budget", customerId, {
      customerId,
      budgetType,
      amountCents: result.data.amountCents,
      validFrom: result.data.validFrom,
    }, ip);
  }

  const allocations = await budgetLedgerStorage.getInitialBalanceAllocations(customerId, budgetType);
  res.json(allocations);
}));

router.delete("/:customerId/initial-balance/:allocationId", requireAdmin, asyncHandler("Startwert konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  const allocationId = requireIntParam(req.params.allocationId, res);
  if (customerId === null || allocationId === null) return;

  const userId = req.user?.id;
  const { db: database } = await import("../lib/db");
  const { budgetAllocations } = await import("@shared/schema");
  const { eq, and, or, isNull } = await import("drizzle-orm");
  const existing = await database.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.id, allocationId),
      eq(budgetAllocations.customerId, customerId),
      isNull(budgetAllocations.deletedAt),
      or(
        eq(budgetAllocations.source, "initial_balance"),
        eq(budgetAllocations.source, "carryover"),
        eq(budgetAllocations.source, "manual_adjustment"),
      ),
    ))
    .limit(1);

  if (existing.length === 0) {
    res.status(404).json({ error: "NOT_FOUND", message: "Startwert nicht gefunden" });
    return;
  }

  await database.update(budgetAllocations)
    .set({ deletedAt: new Date() })
    .where(eq(budgetAllocations.id, allocationId));

  if (userId) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.log(userId, "initial_balance_deleted", "budget", customerId, {
      customerId,
      allocationId,
      amountCents: existing[0].amountCents,
      budgetType: existing[0].budgetType,
    }, ip);
  }

  res.json({ success: true });
}));

const bulkBudgetTypeSettingsSchema = z.object({
  settings: z.array(z.object({
    budgetType: z.enum(["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"]),
    enabled: z.boolean(),
    priority: z.number().min(1).max(3),
    monthlyLimitCents: z.number().min(0).nullable().optional(),
    yearlyLimitCents: z.number().min(0).nullable().optional(),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })).min(1).max(3),
});

router.put("/:customerId/type-settings", asyncHandler("Budget-Typ-Einstellungen konnten nicht gespeichert werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const result = bulkBudgetTypeSettingsSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }

  const priorities = result.data.settings.map(s => s.priority);
  if (new Set(priorities).size !== priorities.length) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Jeder Budget-Topf muss eine eindeutige Priorität haben" });
    return;
  }

  for (const s of result.data.settings) {
    if (s.validFrom && s.validTo && s.validFrom > s.validTo) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: `'Gültig ab' darf nicht nach 'Gültig bis' liegen (${s.budgetType})` });
      return;
    }
  }

  const userId = req.user?.id;
  const saved = await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, result.data.settings);

  if (userId) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.log(userId, "budget_type_settings_updated", "budget", customerId, {
      customerId,
      settings: result.data.settings.map(s => ({
        budgetType: s.budgetType,
        enabled: s.enabled,
        priority: s.priority,
        monthlyLimitCents: s.monthlyLimitCents ?? null,
        yearlyLimitCents: s.yearlyLimitCents ?? null,
        validFrom: s.validFrom ?? null,
        validTo: s.validTo ?? null,
      })),
    }, ip);
  }

  res.json(saved);
}));

router.post("/:customerId/allocations", asyncHandler("Budget-Zuweisung konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const result = insertBudgetAllocationSchema.safeParse({ ...req.body, customerId });
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  const userId = req.user?.id;
  const allocation = await budgetLedgerStorage.createBudgetAllocation(result.data, userId);
  res.status(201).json(allocation);
}));

const initialBudgetSchema = z.object({
  budgetType: z.enum(BUDGET_TYPES).default("entlastungsbetrag_45b"),
  currentYearAmountCents: z.number().min(0),
  carryoverAmountCents: z.number().min(0).optional().default(0),
  budgetStartDate: z.string(),
});

router.post("/:customerId/initial-budget", asyncHandler("Startbudget konnte nicht erfasst werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const result = initialBudgetSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  const { budgetType, currentYearAmountCents, carryoverAmountCents, budgetStartDate } = result.data;
  const userId = req.user?.id;
  const startDate = parseLocalDate(budgetStartDate);
  const year = startDate.getFullYear();

  const allocations: BudgetAllocation[] = [];

  if (currentYearAmountCents > 0) {
    const expiresAt = budgetType === "ersatzpflege_39_42a" ? `${year}-12-31` : null;
    const startMonth = startDate.getMonth() + 1;
    await budgetLedgerStorage.upsertInitialBalanceAllocation({
      customerId,
      budgetType,
      year,
      month: startMonth,
      amountCents: currentYearAmountCents,
      validFrom: budgetStartDate,
      expiresAt,
      notes: `Startguthaben ${year}`,
    }, userId);
    const allAllocations = await budgetLedgerStorage.getInitialBalanceAllocations(customerId, budgetType);
    if (allAllocations.length > 0) allocations.push(allAllocations[0]);
  }

  if (carryoverAmountCents > 0 && budgetType === "entlastungsbetrag_45b") {
    const carryoverAllocation = await budgetLedgerStorage.createBudgetAllocation({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: year - 1,
      month: null,
      amountCents: carryoverAmountCents,
      source: "carryover",
      validFrom: budgetStartDate,
      expiresAt: `${year + 1}-06-30`,
      notes: `Übertrag aus ${year - 1}`,
    }, userId);
    allocations.push(carryoverAllocation);
  }

  await budgetLedgerStorage.upsertBudgetPreferences({
    customerId,
    budgetStartDate,
  }, userId);

  if (userId) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.log(userId, "budget_initial_setup", "budget", customerId, {
      customerId,
      budgetType,
      currentYearAmountCents,
      carryoverAmountCents,
      budgetStartDate,
      allocationIds: allocations.map(a => a.id),
    }, ip);
  }

  res.status(201).json({
    message: "Startbudget erfolgreich erfasst",
    allocations,
  });
}));

router.put("/:customerId/preferences", asyncHandler("Budget-Einstellungen konnten nicht gespeichert werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const result = insertBudgetPreferencesSchema.safeParse({ ...req.body, customerId });
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  const userId = req.user?.id;
  const preferences = await budgetLedgerStorage.upsertBudgetPreferences(result.data, userId);

  if (userId) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.log(userId, "budget_preferences_updated", "budget", customerId, {
      customerId,
      monthlyLimitCents: result.data.monthlyLimitCents ?? null,
      budgetStartDate: result.data.budgetStartDate ?? null,
      notes: result.data.notes ?? null,
    }, ip);
  }

  res.json(preferences);
}));

const manualAdjustmentSchema = z.object({
  budgetType: z.enum(BUDGET_TYPES).default("entlastungsbetrag_45b"),
  amountCents: z.number(),
  notes: z.string().min(1, "Begründung ist erforderlich").max(500),
});

router.post("/:customerId/manual-adjustment", asyncHandler("Manuelle Korrektur konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const result = manualAdjustmentSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  const userId = req.user?.id;
  const today = todayISO();
  const currentYear = new Date().getFullYear();

  const { budgetType, amountCents, notes } = result.data;
  
  if (amountCents > 0) {
    const expiresAt = budgetType === "ersatzpflege_39_42a" ? `${currentYear}-12-31` : null;
    const allocation = await budgetLedgerStorage.createBudgetAllocation({
      customerId,
      budgetType,
      year: currentYear,
      month: null,
      amountCents,
      source: "manual_adjustment",
      validFrom: today,
      expiresAt,
      notes,
    }, userId);

    if (userId) {
      const ip = req.ip || req.socket.remoteAddress;
      await auditService.log(userId, "budget_manual_adjustment", "budget", customerId, {
        customerId,
        budgetType,
        amountCents,
        type: "allocation",
        allocationId: allocation.id,
        notes,
      }, ip);
    }

    res.status(201).json({ type: "allocation", data: allocation });
  } else {
    const transaction = await budgetLedgerStorage.createBudgetTransaction({
      customerId,
      budgetType,
      transactionDate: today,
      transactionType: "manual_adjustment",
      amountCents,
      notes,
    }, userId);

    if (userId) {
      const ip = req.ip || req.socket.remoteAddress;
      await auditService.log(userId, "budget_manual_adjustment", "budget", customerId, {
        customerId,
        budgetType,
        amountCents,
        type: "transaction",
        transactionId: transaction.id,
        notes,
      }, ip);
    }

    res.status(201).json({ type: "transaction", data: transaction });
  }
}));

router.post("/transactions/:transactionId/reverse", asyncHandler("Storno konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const transactionId = requireIntParam(req.params.transactionId, res);
  if (transactionId === null) return;

  const userId = req.user?.id;
  const reversal = await budgetLedgerStorage.reverseBudgetTransaction(transactionId, userId);
  
  if (!reversal) {
    res.status(404).json({
      error: "NOT_FOUND",
      message: "Transaktion nicht gefunden",
    });
    return;
  }

  if (userId) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.log(userId, "budget_reversal", "budget", reversal.customerId, {
      customerId: reversal.customerId,
      originalTransactionId: transactionId,
      reversalTransactionId: reversal.id,
      amountCents: reversal.amountCents,
      budgetType: reversal.budgetType,
    }, ip);
  }

  res.status(201).json(reversal);
}));

const rebookTransactionSchema = z.object({
  transactionId: z.number().int(),
  targetBudgetType: z.enum(BUDGET_TYPES),
});

router.post("/:customerId/rebook-transaction", requireAdmin, asyncHandler("Einzelumbuchung konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const result = rebookTransactionSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }

  const { transactionId, targetBudgetType } = result.data;
  const userId = req.user!.id;

  const rebookResult = await budgetLedgerStorage.rebookSingleTransaction(customerId, transactionId, targetBudgetType, userId);

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  await auditService.log(userId, "budget_rebook_single", "budget", customerId, {
    originalTransactionId: transactionId,
    targetBudgetType,
    reversalId: rebookResult.reversalTransaction.id,
    newTransactionId: rebookResult.newTransaction?.id ?? null,
    amountCents: rebookResult.amountCents,
  }, ip);

  res.json(rebookResult);
}));

router.get("/:customerId/rebook-preview", requireAdmin, asyncHandler("Umbuchungs-Vorschau konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const preview = await budgetLedgerStorage.getRebookPreview(customerId);
  res.json(preview);
}));

router.post("/:customerId/rebook", requireAdmin, asyncHandler("Umbuchung konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const userId = req.user!.id;
  const result = await budgetLedgerStorage.rebookDisabledBudgetTransactions(customerId, userId);

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  await auditService.log(userId, "budget_rebook", "budget", customerId, {
    reversedCount: result.reversedCount,
    rebookedCount: result.rebookedCount,
    totalOldAmountCents: result.totalOldAmountCents,
    totalNewAmountCents: result.totalNewAmountCents,
    errors: result.errors,
  }, ip);

  res.json(result);
}));

export default router;
