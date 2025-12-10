import { Router, Request, Response } from "express";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { 
  insertBudgetAllocationSchema, 
  insertBudgetPreferencesSchema,
} from "@shared/schema";
import { z } from "zod";

const router = Router();

router.use(requireAuth);

router.get("/:customerId/summary", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Kunden-ID",
      });
      return;
    }

    const summary = await budgetLedgerStorage.getBudgetSummary(customerId);
    res.json(summary);
  } catch (error) {
    handleRouteError(res, error, "Budget-Übersicht konnte nicht geladen werden");
  }
});

router.get("/:customerId/allocations", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;
    
    if (isNaN(customerId)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Kunden-ID",
      });
      return;
    }

    const allocations = await budgetLedgerStorage.getBudgetAllocations(customerId, year);
    res.json(allocations);
  } catch (error) {
    handleRouteError(res, error, "Budget-Zuweisungen konnten nicht geladen werden");
  }
});

router.get("/:customerId/transactions", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
    
    if (isNaN(customerId)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Kunden-ID",
      });
      return;
    }

    const transactions = await budgetLedgerStorage.getBudgetTransactions(customerId, { year, limit });
    res.json(transactions);
  } catch (error) {
    handleRouteError(res, error, "Budget-Transaktionen konnten nicht geladen werden");
  }
});

router.get("/:customerId/preferences", async (req: Request, res: Response) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Ungültige Kunden-ID",
      });
      return;
    }

    const preferences = await budgetLedgerStorage.getBudgetPreferences(customerId);
    res.json(preferences || { customerId, monthlyLimitCents: null, budgetStartDate: null, notes: null });
  } catch (error) {
    handleRouteError(res, error, "Budget-Einstellungen konnten nicht geladen werden");
  }
});

router.use(requireAdmin);

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

    const { currentYearAmountCents, carryoverAmountCents, budgetStartDate } = result.data;
    const userId = req.user?.id;
    const startDate = new Date(budgetStartDate);
    const year = startDate.getFullYear();
    const carryoverYear = year + 1;

    const allocations: any[] = [];

    if (currentYearAmountCents > 0) {
      const currentYearAllocation = await budgetLedgerStorage.createBudgetAllocation({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year,
        month: null,
        amountCents: currentYearAmountCents,
        source: "initial_balance",
        validFrom: budgetStartDate,
        expiresAt: null,
        notes: `Startguthaben ${year}`,
      }, userId);
      allocations.push(currentYearAllocation);
    }

    if (carryoverAmountCents > 0) {
      const carryoverAllocation = await budgetLedgerStorage.createBudgetAllocation({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: year - 1,
        month: null,
        amountCents: carryoverAmountCents,
        source: "carryover",
        validFrom: budgetStartDate,
        expiresAt: `${carryoverYear}-06-30`,
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
    const today = new Date().toISOString().slice(0, 10);
    const currentYear = new Date().getFullYear();

    if (result.data.amountCents > 0) {
      const allocation = await budgetLedgerStorage.createBudgetAllocation({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: currentYear,
        month: null,
        amountCents: result.data.amountCents,
        source: "manual_adjustment",
        validFrom: today,
        expiresAt: null,
        notes: result.data.notes,
      }, userId);
      res.status(201).json({ type: "allocation", data: allocation });
    } else {
      const transaction = await budgetLedgerStorage.createBudgetTransaction({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        transactionDate: today,
        transactionType: "manual_adjustment",
        amountCents: result.data.amountCents,
        notes: result.data.notes,
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
