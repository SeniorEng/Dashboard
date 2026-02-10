import { Router, Request, Response } from "express";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { requireAuth, requireAdmin, requireCustomerAccess } from "../middleware/auth";
import { storage } from "../storage";
import { handleRouteError } from "../lib/errors";
import { 
  insertBudgetAllocationSchema, 
  insertBudgetPreferencesSchema,
} from "@shared/schema";
import { z } from "zod";
import { todayISO, parseLocalDate } from "@shared/utils/datetime";
import { BUDGET_TYPES } from "@shared/domain/budgets";

const router = Router();

router.use(requireAuth);

// Middleware für Kundenzugriffsprüfung
const checkCustomerAccess = requireCustomerAccess(
  (employeeId) => storage.getAssignedCustomerIds(employeeId)
);

router.get("/:customerId/summary", checkCustomerAccess, async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const summary = await budgetLedgerStorage.getBudgetSummary(customerId);
    res.json(summary);
  } catch (error) {
    handleRouteError(res, error, "Budget-Übersicht konnte nicht geladen werden");
  }
});

router.get("/:customerId/allocations", checkCustomerAccess, async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;

    const allocations = await budgetLedgerStorage.getBudgetAllocations(customerId, year);
    res.json(allocations);
  } catch (error) {
    handleRouteError(res, error, "Budget-Zuweisungen konnten nicht geladen werden");
  }
});

router.get("/:customerId/transactions", checkCustomerAccess, async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;

    const transactions = await budgetLedgerStorage.getBudgetTransactions(customerId, { year, limit });
    res.json(transactions);
  } catch (error) {
    handleRouteError(res, error, "Budget-Transaktionen konnten nicht geladen werden");
  }
});

router.get("/:customerId/preferences", checkCustomerAccess, async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);

    const preferences = await budgetLedgerStorage.getBudgetPreferences(customerId);
    res.json(preferences || { customerId, monthlyLimitCents: null, budgetStartDate: null, notes: null });
  } catch (error) {
    handleRouteError(res, error, "Budget-Einstellungen konnten nicht geladen werden");
  }
});

router.get("/:customerId/cost-estimate", checkCustomerAccess, async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const hauswirtschaftMinutes = parseInt(req.query.hauswirtschaftMinutes as string) || 0;
    const alltagsbegleitungMinutes = parseInt(req.query.alltagsbegleitungMinutes as string) || 0;
    const travelKilometers = parseFloat(req.query.travelKilometers as string) || 0;
    const customerKilometers = parseFloat(req.query.customerKilometers as string) || 0;
    const date = (req.query.date as string) || todayISO();

    const costs = await budgetLedgerStorage.calculateAppointmentCost({
      customerId,
      hauswirtschaftMinutes,
      alltagsbegleitungMinutes,
      travelKilometers,
      customerKilometers,
      date,
    });

    const summaries = await budgetLedgerStorage.getAllBudgetSummaries(customerId);
    const summary45b = summaries.entlastungsbetrag45b;
    const summary45a = summaries.umwandlung45a;

    const totalAvailable = summary45a.currentMonthAvailableCents + summary45b.availableCents;

    let warning: string | null = null;

    if (summary45b.monthlyLimitCents !== null) {
      const monthlyRemaining45b = Math.max(0, summary45b.monthlyLimitCents - summary45b.currentMonthUsedCents);
      const effectiveAvailable = summary45a.currentMonthAvailableCents + monthlyRemaining45b;
      if (costs.totalCents > effectiveAvailable) {
        const limitEuro = (summary45b.monthlyLimitCents / 100).toFixed(2);
        warning = `Unter Berücksichtigung des §45b-Monatslimits (${limitEuro} €) reicht das Budget nicht vollständig.`;
      }
    }

    if (costs.totalCents > totalAvailable) {
      const availableEuro = (totalAvailable / 100).toFixed(2);
      const costEuro = (costs.totalCents / 100).toFixed(2);
      const budgetWarning = `Das verfügbare Gesamtbudget (${availableEuro} €) reicht nicht für diesen Termin (${costEuro} €).`;
      warning = warning ? `${warning} ${budgetWarning}` : budgetWarning;
    }

    res.json({
      ...costs,
      availableCents: totalAvailable,
      currentMonthUsedCents: summary45b.currentMonthUsedCents,
      monthlyLimitCents: summary45b.monthlyLimitCents,
      warning,
    });
  } catch (error: any) {
    if (error?.message?.includes("Preisvereinbarung")) {
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
    handleRouteError(res, error, "Kostenschätzung konnte nicht berechnet werden");
  }
});

router.get("/:customerId/overview", checkCustomerAccess, async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const summaries = await budgetLedgerStorage.getAllBudgetSummaries(customerId);

    res.json({
      entlastungsbetrag45b: {
        totalAllocatedCents: summaries.entlastungsbetrag45b.totalAllocatedCents,
        totalUsedCents: summaries.entlastungsbetrag45b.totalUsedCents,
        availableCents: summaries.entlastungsbetrag45b.availableCents,
        currentMonthUsedCents: summaries.entlastungsbetrag45b.currentMonthUsedCents,
        monthlyLimitCents: summaries.entlastungsbetrag45b.monthlyLimitCents,
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
  } catch (error) {
    handleRouteError(res, error, "Budget-Übersicht konnte nicht geladen werden");
  }
});

router.use(requireAdmin);

router.get("/:customerId/type-settings", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }
    const settings = await budgetLedgerStorage.getBudgetTypeSettings(customerId);
    const defaults = [
      { budgetType: "umwandlung_45a", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, initialBalanceCents: null, initialBalanceMonth: null },
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, initialBalanceCents: null, initialBalanceMonth: null },
      { budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, initialBalanceCents: null, initialBalanceMonth: null },
    ];
    if (settings.length === 0) {
      const prefs = await budgetLedgerStorage.getBudgetPreferences(customerId);
      if (prefs?.monthlyLimitCents !== null && prefs?.monthlyLimitCents !== undefined) {
        defaults[1].monthlyLimitCents = prefs.monthlyLimitCents;
      }
      res.json(defaults.map(d => ({ ...d, customerId, id: null })));
    } else {
      const settingsMap = new Map(settings.map(s => [s.budgetType, s]));
      const merged = defaults.map(d => {
        const s = settingsMap.get(d.budgetType);
        return s || { ...d, customerId, id: null };
      });
      merged.sort((a, b) => a.priority - b.priority);
      res.json(merged);
    }
  } catch (error) {
    handleRouteError(res, error, "Budget-Typ-Einstellungen konnten nicht geladen werden");
  }
});

const bulkBudgetTypeSettingsSchema = z.object({
  settings: z.array(z.object({
    budgetType: z.enum(["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"]),
    enabled: z.boolean(),
    priority: z.number().min(1).max(3),
    monthlyLimitCents: z.number().min(0).nullable().optional(),
    yearlyLimitCents: z.number().min(0).nullable().optional(),
    initialBalanceCents: z.number().min(0).nullable().optional(),
    initialBalanceMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  })).min(1).max(3),
});

router.put("/:customerId/type-settings", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
      return;
    }

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

    const saved = await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, result.data.settings);

    const userId = req.user?.id;
    for (const s of result.data.settings) {
      if (s.initialBalanceCents != null && s.initialBalanceCents > 0 && s.initialBalanceMonth) {
        const [yearStr, monthStr] = s.initialBalanceMonth.split("-");
        const year = parseInt(yearStr);
        const validFrom = `${s.initialBalanceMonth}-01`;
        const expiresAt = s.budgetType === "ersatzpflege_39_42a" ? `${year}-12-31` : null;

        await budgetLedgerStorage.upsertInitialBalanceAllocation({
          customerId,
          budgetType: s.budgetType,
          year,
          amountCents: s.initialBalanceCents,
          validFrom,
          expiresAt,
          notes: `Startwert ab ${monthStr}/${yearStr}`,
        }, userId);
      } else {
        await budgetLedgerStorage.deleteInitialBalanceAllocations(customerId, s.budgetType);
      }
    }

    res.json(saved);
  } catch (error) {
    handleRouteError(res, error, "Budget-Typ-Einstellungen konnten nicht gespeichert werden");
  }
});

router.post("/:customerId/allocations", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Kunden-ID",
      });
      return;
    }

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
  } catch (error) {
    handleRouteError(res, error, "Budget-Zuweisung konnte nicht erstellt werden");
  }
});

const initialBudgetSchema = z.object({
  budgetType: z.enum(BUDGET_TYPES).default("entlastungsbetrag_45b"),
  currentYearAmountCents: z.number().min(0),
  carryoverAmountCents: z.number().min(0).optional().default(0),
  budgetStartDate: z.string(),
});

router.post("/:customerId/initial-budget", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Kunden-ID",
      });
      return;
    }

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

    const allocations: any[] = [];

    if (currentYearAmountCents > 0) {
      const expiresAt = budgetType === "ersatzpflege_39_42a" ? `${year}-12-31` : null;
      const currentYearAllocation = await budgetLedgerStorage.createBudgetAllocation({
        customerId,
        budgetType,
        year,
        month: null,
        amountCents: currentYearAmountCents,
        source: "initial_balance",
        validFrom: budgetStartDate,
        expiresAt,
        notes: `Startguthaben ${year}`,
      }, userId);
      allocations.push(currentYearAllocation);
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

    res.status(201).json({
      message: "Startbudget erfolgreich erfasst",
      allocations,
    });
  } catch (error) {
    handleRouteError(res, error, "Startbudget konnte nicht erfasst werden");
  }
});

router.put("/:customerId/preferences", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Kunden-ID",
      });
      return;
    }

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
    res.json(preferences);
  } catch (error) {
    handleRouteError(res, error, "Budget-Einstellungen konnten nicht gespeichert werden");
  }
});

const manualAdjustmentSchema = z.object({
  budgetType: z.enum(BUDGET_TYPES).default("entlastungsbetrag_45b"),
  amountCents: z.number(),
  notes: z.string().min(1, "Begründung ist erforderlich").max(500),
});

router.post("/:customerId/manual-adjustment", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Kunden-ID",
      });
      return;
    }

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
      res.status(201).json({ type: "transaction", data: transaction });
    }
  } catch (error) {
    handleRouteError(res, error, "Manuelle Korrektur konnte nicht durchgeführt werden");
  }
});

router.post("/transactions/:transactionId/reverse", async (req: Request, res: Response) => {
  try {
    const transactionId = parseInt(req.params.transactionId);
    if (isNaN(transactionId)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Transaktions-ID",
      });
      return;
    }

    const userId = req.user?.id;
    const reversal = await budgetLedgerStorage.reverseBudgetTransaction(transactionId, userId);
    
    if (!reversal) {
      res.status(404).json({
        error: "NOT_FOUND",
        message: "Transaktion nicht gefunden",
      });
      return;
    }

    res.status(201).json(reversal);
  } catch (error) {
    handleRouteError(res, error, "Storno konnte nicht durchgeführt werden");
  }
});

export default router;
