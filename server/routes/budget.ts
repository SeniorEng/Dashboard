import { Router, Request, Response } from "express";
import { budgetStorage } from "../storage/budget-storage";
import { requireAuth, requireAdmin, requireCustomerAccess } from "../middleware/auth";
import { storage } from "../storage";
import { asyncHandler } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { 
  insertBudgetAllocationSchema, 
  insertBudgetPreferencesSchema,
} from "@shared/schema";
import { z } from "zod";
import { todayISO, parseLocalDate } from "@shared/utils/datetime";
import { BUDGET_TYPES, BUDGET_45B_MAX_MONTHLY_CENTS, validate45aAmount, validate39_42aAmount, effectiveDefaultPots } from "@shared/domain/budgets";
import { formatEuroDE, centsToEuroNumber } from "@shared/utils/money";
import { auditService } from "../services/audit";
import { validateSelbstzahlerBudget } from "@shared/domain/budget-selbstzahler-validator";
import { validatePflegegradBudget } from "@shared/domain/budget-pflegegrad-validator";
import { carryoverWindowFor } from "@shared/domain/budget-carryover-dedup";
import { classifyCostEstimate } from "@shared/domain/budget/cost-estimate-outcome";
import {
  max45bStartValueCents,
  resolve45bAccrualAnchor,
  validate45bInitialBalanceNotPriorYear,
} from "@shared/domain/budget/carryover-eligibility";
import { applyInitialBudget, BudgetInitialSetupError } from "../services/budget-initial-setup";
import type { BudgetOverviewDTO } from "@shared/api/budget";

/**
 * Task #716 — Selbstzahler-Block für §45b. Einheitlicher Wire-Format-Output
 * (`error`, `code`, `message`) — das Frontend mapped auf den `code`-Wert.
 * Liefert `true` zurück, wenn die Response geschickt wurde (Handler sollte
 * abbrechen).
 */
async function rejectIfSelbstzahler45b(
  customerId: number,
  budgetType: string,
  res: Response,
): Promise<boolean> {
  const cust = await storage.getCustomer(customerId);
  return rejectBudgetIntent(
    {
      billingType: cust?.billingType,
      pflegegrad: cust?.pflegegrad,
      budgetType,
    },
    res,
  );
}

/**
 * Task #722 — Zentraler Reject-Helper für Budget-Schreibpfade. Führt nach­
 * einander die geteilten Validatoren (Selbstzahler #705/#716 + Pflegegrad
 * #722) aus und sendet beim ersten Fail eine 409-Response im einheitlichen
 * Wire-Format (`error`, `code`, `message`). Aufrufer, die den Kunden bereits
 * geladen haben (z. B. `POST /initial-budget`), können Customer-Felder
 * direkt durchreichen — sonst nimmt `rejectIfSelbstzahler45b` die Last ab
 * und lädt den Kunden selbst.
 */
function rejectBudgetIntent(
  args: {
    billingType: string | null | undefined;
    pflegegrad: number | null | undefined;
    budgetType: string;
  },
  res: Response,
): boolean {
  const sz = validateSelbstzahlerBudget({
    billingType: args.billingType,
    intent: { budgetType: args.budgetType },
  });
  if (!sz.ok) {
    res.status(sz.httpStatus).json({ error: sz.code, code: sz.code, message: sz.message });
    return true;
  }
  const pg = validatePflegegradBudget({
    pflegegrad: args.pflegegrad,
    intent: { budgetType: args.budgetType },
  });
  if (!pg.ok) {
    res.status(pg.httpStatus).json({ error: pg.code, code: pg.code, message: pg.message });
    return true;
  }
  return false;
}

/**
 * Task #911 (NS-1) — Stichtag-Query-Param `?date=` für die Read-Routen
 * `/summary` und `/overview` (spiegelt die `?date=`-Konvention von
 * `/cost-estimate`). Optional; fehlt der Param, gilt heute. Liegt ein Wert vor,
 * MUSS er ein gültiges `YYYY-MM-DD`-Datum sein — sonst 400 (Response wird hier
 * gesendet und `null` zurückgegeben, damit der Handler abbricht).
 */
function parseAsOfDateQuery(req: Request, res: Response): string | null {
  const raw = req.query.date;
  if (raw === undefined || raw === "") return todayISO();
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    res.status(400).json({ error: "Ungültiges Datum. Erwartet wird das Format YYYY-MM-DD." });
    return null;
  }
  const parsed = parseLocalDate(raw);
  const roundTrip = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  if (roundTrip !== raw) {
    res.status(400).json({ error: "Ungültiges Datum. Erwartet wird das Format YYYY-MM-DD." });
    return null;
  }
  return raw;
}

const router = Router();

router.use(requireAuth);

const checkCustomerAccess = requireCustomerAccess(
  (employeeId) => storage.getAssignedCustomerIds(employeeId)
);

router.get("/:customerId/summary", checkCustomerAccess, asyncHandler("Budget-Übersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const asOfDate = parseAsOfDateQuery(req, res);
  if (asOfDate === null) return;
  await budgetStorage.syncCarryoverAndExpiry(customerId);
  // Task #874 — Serving-Pfad: Verfügbarkeit aus dem EINEN unified Reader.
  // Task #911 (NS-1) — optionaler Stichtag (?date=, Default heute).
  const summary = await budgetStorage.getBudgetSummaryServed(customerId, asOfDate);
  res.json(summary);
}));

// Task #1129 — read-only §45b FIFO-Aufschlüsselung (Übertrag → laufendes Jahr).
// Verteilt die unified-Reader-Summen FIFO-konform auf zwei Töpfe und
// klassifiziert den Konsum nach Termin-Zustand. Keine eigene Mathematik.
router.get("/:customerId/fifo-breakdown", checkCustomerAccess, asyncHandler("§45b-Aufschlüsselung konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const asOfDate = parseAsOfDateQuery(req, res);
  if (asOfDate === null) return;
  await budgetStorage.syncCarryoverAndExpiry(customerId);
  const breakdown = await budgetStorage.readBudget45bFifoBreakdown(customerId, asOfDate);
  res.json(breakdown);
}));

router.get("/:customerId/allocations", checkCustomerAccess, asyncHandler("Budget-Zuweisungen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;

  const allocations = await budgetStorage.getBudgetAllocations(customerId, year);
  res.json(allocations);
}));

router.get("/:customerId/transactions", checkCustomerAccess, asyncHandler("Budget-Transaktionen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;

  const budgetType = req.query.budgetType as string | undefined;
  const transactions = await budgetStorage.getBudgetTransactions(customerId, { year, limit, budgetType });
  res.json(transactions);
}));

router.get("/:customerId/preferences", checkCustomerAccess, asyncHandler("Budget-Einstellungen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const preferences = await budgetStorage.getBudgetPreferences(customerId);
  res.json(preferences || { customerId, monthlyLimitCents: null, notes: null });
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

      // Task #1291 — Preis-Auflösung ausschließlich über die `priceFor`-SSoT.
      const { loadCustomerPriceContext } = await import("../storage/pricing/price-for");
      const priceCtx = await loadCustomerPriceContext(customerId);

      const allServices = await serviceCatalogStorage.getServicesByIds(serviceIds);
      const serviceMap = new Map(allServices.map(s => [s.id, s]));

      for (let i = 0; i < serviceIds.length; i++) {
        const service = serviceMap.get(serviceIds[i]);
        if (!service || !service.isBillable) continue;
        
        const durationMinutes = durations[i] || 0;
        const effectivePrice = priceCtx.resolveById(service.id, date)?.cents ?? service.defaultPriceCents;
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
      
      const costs = await budgetStorage.calculateAppointmentCost({
        customerId,
        hauswirtschaftMinutes,
        alltagsbegleitungMinutes,
        travelKilometers,
        customerKilometers,
        date,
      });
      totalCostCents = costs.totalCents;

      const [hwService, abService, travelKmService, customerKmService] = await Promise.all([
        serviceCatalogStorage.getServiceByCode("hauswirtschaft"),
        serviceCatalogStorage.getServiceByCode("alltagsbegleitung"),
        serviceCatalogStorage.getServiceByCode("travel_km"),
        serviceCatalogStorage.getServiceByCode("customer_km"),
      ]);
      if (hwService && hauswirtschaftMinutes > 0) costDetails.push({ serviceId: hwService.id, costCents: costs.hauswirtschaftCents, vatRate: hwService.vatRate });
      if (abService && alltagsbegleitungMinutes > 0) costDetails.push({ serviceId: abService.id, costCents: costs.alltagsbegleitungCents, vatRate: abService.vatRate });
      if (travelKmService && travelKilometers > 0 && costs.travelCents > 0) costDetails.push({ serviceId: travelKmService.id, costCents: costs.travelCents, vatRate: travelKmService.vatRate });
      if (customerKmService && customerKilometers > 0 && costs.customerKilometersCents > 0) costDetails.push({ serviceId: customerKmService.id, costCents: costs.customerKilometersCents, vatRate: customerKmService.vatRate });
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
  const isSelbstzahler = customer?.billingType === "selbstzahler";

  if (costDetails.length > 0) {
    const totalCost = costDetails.reduce((s, c) => s + c.costCents, 0);
    if (totalCost > 0) {
      weightedVatRate = costDetails.reduce((s, c) => s + (c.vatRate * c.costCents / totalCost), 0);
    }
  }

  // Phase-1.2-Drift-Folge — Klassifikation (Selbstzahler / OK / Soft-Private /
  // Hard-Block) inkl. Warnungs-Wording und VAT-Mathematik lebt zentral in
  // `shared/domain/budget/cost-estimate-outcome.ts`. Diese Route ist nur noch
  // der Komposition-Wrapper: Preise + Verfügbarkeit aus DB ziehen, an die
  // pure Funktion übergeben, Wire-Shape bauen.
  if (isSelbstzahler) {
    const outcome = classifyCostEstimate({
      totalCostCents,
      availableCents: 0,
      weightedVatRate,
      acceptsPrivatePayment: false,
      isSelbstzahler: true,
    });
    res.json({
      totalCents: totalCostCents,
      isSelbstzahler: true,
      bruttoCents: outcome.bruttoCents,
      vatCents: outcome.vatCents,
      vatRate: Math.round(weightedVatRate),
      warning: outcome.warning,
      isHardBlock: outcome.isHardBlock,
      privateCents: outcome.privateCents,
      acceptsPrivatePayment: false,
      ...(process.env.NODE_ENV === "test" ? { _testBudgetQueriesExecuted: false } : {}),
    });
    return;
  }

  // §45b ist seit Task #425 ein Jahrestopf ohne Monats-Cap. Verfügbar = bis
  // zum Termindatum (`date`) aufgelaufene Allocation minus bereits gebuchter
  // Beträge — same-source-of-truth wie der Buchungspfad
  // (`getAvailableForDate` → `consumption-engine`). Damit driftet die
  // Kostenschätzung NICHT mehr von der späteren Buchung im selben oder einem
  // zurückliegenden/zukünftigen Monat.
  const { getAvailableForDate } = await import("../storage/budget/import-availability");
  const dateAware = await getAvailableForDate(customerId, date);

  // Task #876 — Serving-Pfad auf den unified Reader vereinheitlicht. Gelesen
  // werden hier nur Nicht-Verfügbarkeits-Felder (`currentMonthUsedCents`,
  // `monthlyLimitCents`); das verfügbare Budget kommt weiterhin aus
  // `getAvailableForDate` (datum-genau, gleiche SSoT wie der Buchungspfad).
  const summaries = await budgetStorage.getAllBudgetSummariesServed(customerId);
  const summary45b = summaries.entlastungsbetrag45b;

  const totalAvailable = dateAware.totalCents;

  const outcome = classifyCostEstimate({
    totalCostCents,
    availableCents: totalAvailable,
    weightedVatRate,
    acceptsPrivatePayment,
    isSelbstzahler: false,
  });

  // Task #875 (gated) — aktive Holds (geplante, noch nicht abgeschlossene
  // Termine) explizit ausweisen, damit die Planungs-Banner zeigen kann, wie
  // viel des verfügbaren Budgets bereits reserviert ist. Flag aus = 0 (das
  // Feld bleibt 0 ⇒ UI rendert keinen Reservierungs-Hinweis, byte-identisch).
  let holdsActiveCents = 0;
  if (budgetStorage.hardHoldsEnabled()) {
    const { readUnifiedBudgetAvailability } = await import("../storage/budget/unified-reader");
    const unified = await readUnifiedBudgetAvailability(customerId, date);
    holdsActiveCents = unified.totalHoldsCents;
  }

  res.json({
    totalCents: totalCostCents,
    availableCents: totalAvailable,
    holdsActiveCents,
    currentMonthUsedCents: summary45b.currentMonthUsedCents,
    monthlyLimitCents: summary45b.monthlyLimitCents,
    warning: outcome.warning,
    isHardBlock: outcome.isHardBlock,
    privateCents: outcome.privateCents,
    vatCents: outcome.vatCents,
    vatRate: Math.round(weightedVatRate),
    acceptsPrivatePayment,
    ...(process.env.NODE_ENV === "test" ? { _testBudgetQueriesExecuted: true } : {}),
  });
}));

/**
 * Task #727 — Phase 1.3 `BudgetHistoryView`: monatliche Aggregation der
 * Budget-Transaktionen pro Pot. Antwort exponiert beide Sichten:
 *   - `netUsedAllocationCents` (Topf-Sicht, inkl. write_off)
 *   - `netUsedWindowCents` (Fenster-Cap-Sicht, ohne write_off)
 * Equality-Test `tests/equality/budget-history-vs-overview.test.ts`
 * verifiziert SUM(monatlich, §45b) === `getBudgetSummary.totalUsedCents`.
 */
router.get("/:customerId/history", checkCustomerAccess, asyncHandler("Budget-Historie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  const budgetTypeParam = req.query.budgetType;
  const budgetTypes = typeof budgetTypeParam === "string"
    ? [budgetTypeParam]
    : Array.isArray(budgetTypeParam)
      ? budgetTypeParam.filter((s): s is string => typeof s === "string")
      : undefined;
  const buckets = await budgetStorage.getMonthlyHistory(customerId, { from, to, budgetTypes });
  res.json({ buckets });
}));

router.get("/:customerId/overview", checkCustomerAccess, asyncHandler("Budget-Übersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const asOfDate = parseAsOfDateQuery(req, res);
  if (asOfDate === null) return;
  // Task #874 — Serving-Pfad: Verfügbarkeit aus dem EINEN unified Reader
  // (`readUnifiedBudgetAvailability`). Das Legacy-Gerüst liefert nur noch die
  // Nicht-Verfügbarkeits-Felder (Carryover, Planung, Limit, totalUsedCents).
  // Task #911 (NS-1) — optionaler Stichtag (?date=, Default heute).
  const summaries = await budgetStorage.getAllBudgetSummariesServed(customerId, asOfDate);

  const s45b = summaries.entlastungsbetrag45b;
  // Task #720 — explizite Typannotation gegen `BudgetOverviewDTO`
  // (`shared/api/budget.ts`). Frontend (`BudgetLedgerSection.tsx`) und
  // dieser Sender teilen denselben Typ; Drift zwischen Wire-Shape und
  // UI-Erwartung wird beim Compile sichtbar.
  const overview: BudgetOverviewDTO = {
    entlastungsbetrag45b: {
      totalAllocatedCents: s45b.totalAllocatedCents,
      totalUsedCents: s45b.totalUsedCents,
      availableCents: s45b.availableCents,
      plannedCents: s45b.plannedCents,
      availableAfterPlannedCents: s45b.availableAfterPlannedCents,
      currentMonthUsedCents: s45b.currentMonthUsedCents,
      currentMonthAvailableCents: s45b.currentMonthAvailableCents,
      monthlyLimitCents: s45b.monthlyLimitCents,
      carryoverCents: s45b.carryoverCents,
      carryoverExpiresAt: s45b.carryoverExpiresAt,
      currentYearAllocatedCents: s45b.currentYearAllocatedCents,
      isCurrentlyActive: s45b.isCurrentlyActive,
      plannedShortfallMonth: s45b.plannedShortfallMonth,
    },
    umwandlung45a: {
      monthlyBudgetCents: summaries.umwandlung45a.monthlyBudgetCents,
      currentMonthAllocatedCents: summaries.umwandlung45a.currentMonthAllocatedCents,
      currentMonthUsedCents: summaries.umwandlung45a.currentMonthUsedCents,
      currentMonthAvailableCents: summaries.umwandlung45a.currentMonthAvailableCents,
      isCurrentlyActive: summaries.umwandlung45a.isCurrentlyActive,
      label: "§45a Umwandlungsanspruch",
    },
    ersatzpflege39_42a: {
      yearlyBudgetCents: summaries.ersatzpflege39_42a.yearlyBudgetCents,
      currentYearAllocatedCents: summaries.ersatzpflege39_42a.currentYearAllocatedCents,
      currentYearUsedCents: summaries.ersatzpflege39_42a.currentYearUsedCents,
      currentYearAvailableCents: summaries.ersatzpflege39_42a.currentYearAvailableCents,
      label: "§39/§42a Gemeinsamer Jahresbetrag",
    },
  };
  res.json(overview);
}));

router.use(requireAdmin);

router.get("/:customerId/type-settings", asyncHandler("Budget-Typ-Einstellungen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  // Task #696 — Bug 1: GET dient der UI-Bearbeitung; muss die LATEST-INTENT-Zeile
  // pro Topf liefern (nicht die für `today` aktive). Während einer echten
  // Transition trägt die alte Zeile transient `validTo = heute` und die neue
  // Zeile `validFrom = heute+1`; `getBudgetTypeSettings` (= for-today) würde
  // die alte Zeile mit dem transienten `validTo = heute` zurückgeben, sodass
  // der Admin den Eindruck hätte, „Gültig bis" sei gesetzt — ein anschließendes
  // Clear+Save würde dann zum No-Op (die neue offene Zeile hat `validTo = null`
  // bereits, der Equality-Check sieht keine Änderung). Booking-Pfade nutzen
  // weiterhin `getActiveBudgetTypeSettings(transactionDate)`.
  // Task #703 — Latest-Intent + `effectiveToday` für UI-Übergangs-Erkennung.
  const settings = await budgetStorage.readBudgetTypeSettings(customerId, { kind: "withTransition" });
  // BUG-19 (Facette A): Der Default-Aktivierungszustand der gesetzlichen Töpfe
  // kommt aus der SSoT `effectiveDefaultPots(customer)`, die denselben
  // Anspruchs-Gate durchläuft wie alle Schreibpfade — Selbstzahler haben keinen
  // Anspruch auf §45b/§45a/§39 (`defaultStatutoryPotEnabled` →
  // `validateSelbstzahlerBudget`). Greift VOR beiden Branches, da `defaults`
  // im Nicht-Leer-Branch via `settingsMap`-Fallback (`s || {...d}`) weiterwirkt.
  const customer = await storage.getCustomer(customerId);
  // Task #1246 — Konsistenz mit PUT: Eine nicht existierende Kunden-ID liefert
  // 404 (gleiche Fehler-Form wie PUT), statt still `200` mit Default-Töpfen.
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }
  const defaults: { budgetType: string; enabled: boolean; priority: number; monthlyLimitCents: number | null; yearlyLimitCents: number | null; validFrom: string | null; validTo: string | null; effectiveToday: null }[] =
    effectiveDefaultPots({ billingType: customer?.billingType, pflegegrad: customer?.pflegegrad }).map((p) => ({
      budgetType: p.budgetType,
      enabled: p.enabled,
      priority: p.priority,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      validFrom: null,
      validTo: null,
      effectiveToday: null,
    }));
  if (settings.length === 0) {
    const prefs = await budgetStorage.getBudgetPreferences(customerId);
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
  const allocations = await budgetStorage.getInitialBalanceAllocations(customerId, budgetType);
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

  // Task #705 / #716 — Selbstzahler-Block via shared Validator.
  if (await rejectIfSelbstzahler45b(customerId, budgetType, res)) return;

  // Task #964 — §45b-Restguthaben aus einem früheren Jahr ist rechtlich ein
  // Übertrag (verfällt 30.06.), kein dauerhafter Startwert. Prior-Year-Stichmonate
  // werden über den normalen API-Contract abgelehnt und auf das Übertrag-Feld
  // umgeleitet. Gilt NUR für §45b — §45a/§39 bleiben unberührt. KEIN harter
  // Storage-Layer-Wall: Migration/Backfill (Epoch-Sentinel) & Korrektur-Tooling
  // schreiben weiterhin direkt über die Storage-Schicht.
  if (budgetType === "entlastungsbetrag_45b") {
    const currentYear = parseLocalDate(todayISO()).getFullYear();
    const priorYearError = validate45bInitialBalanceNotPriorYear(result.data.validFrom, currentYear);
    if (priorYearError) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        code: "BUDGET_45B_PRIOR_YEAR_INITIAL_BALANCE",
        message: priorYearError,
      });
      return;
    }
  }

  const [yearStr, monthStr] = result.data.validFrom.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  const validFromDate = `${result.data.validFrom}-01`;
  const expiresAt = budgetType === "ersatzpflege_39_42a" ? `${year}-12-31` : null;
  const userId = req.user?.id;

  // Task #971 — §45b-Akkumulations-Obergrenze auch im Admin-Startwert-Editor
  // erzwingen (konsistent zum `/initial-budget`-Pfad, Task #959). Ein §45b-
  // Startwert (`initial_balance`) repräsentiert das bis zum Startmonat
  // angesammelte, noch nicht verbrauchte Guthaben; er darf höchstens
  // (berechtigte Monate ab Accrual-Anker bis Startmonat) × 131 € betragen.
  // Accrual-Anker = frühester Pflegegrad-Beginn (Care-Level-Historie), Fallback
  // = der erfasste Startmonat selbst. Gilt NUR für §45b — §45a/§39 bleiben
  // uncapped. KEIN harter Storage-Layer-Wall: Migration/Korrektur-Tooling
  // schreibt weiterhin direkt über die Storage-Schicht.
  if (budgetType === "entlastungsbetrag_45b") {
    const { getCustomerCareLevelHistory } = await import("../storage/customer-mgmt/care-level");
    const careLevelHistory = await getCustomerCareLevelHistory(customerId);
    const accrualAnchor = resolve45bAccrualAnchor(careLevelHistory, validFromDate);
    const startCap = max45bStartValueCents(accrualAnchor, validFromDate);
    if (result.data.amountCents > startCap) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        code: "BUDGET_45B_START_VALUE_EXCEEDED",
        message: `§45b-Startguthaben darf höchstens ${formatEuroDE(startCap)} betragen (rechtlich mögliche Ansammlung bis zum Startmonat). Eingegeben: ${formatEuroDE(result.data.amountCents)}.`,
      });
      return;
    }
  }

  await budgetStorage.upsertInitialBalanceAllocation({
    customerId,
    budgetType,
    year,
    month,
    amountCents: result.data.amountCents,
    validFrom: validFromDate,
    expiresAt,
    notes: `Startwert ab ${monthStr}/${yearStr}`,
  }, userId);

  // Task #1204 — Der §45b-Anker wird zur Laufzeit aus der Pflegegrad-Historie
  // abgeleitet (kein persistierter `budget_start_date` mehr); hier wird daher
  // keine kunden-weite Anker-Zeile mehr geschrieben.

  if (userId) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.log(userId, "initial_balance_set", "budget", customerId, {
      customerId,
      budgetType,
      amountCents: result.data.amountCents,
      validFrom: result.data.validFrom,
    }, ip);
  }

  const allocations = await budgetStorage.getInitialBalanceAllocations(customerId, budgetType);
  res.json(allocations);
}));

// Task #686: Vor dem Soft-Delete einer Carryover-/Initial-Balance-Allokation
// will das Admin-UI warnen, wenn schon Termine gegen genau diese Allokation
// gebucht wurden. `allocationId` an `budget_transactions` ist die Quelle der
// Wahrheit — `distinct(appointmentId)` zählt verbuchte Termine (NULL-Einträge
// wie write-off / manual_adjustment fallen heraus). Nur lesend; keine
// Seiteneffekte, daher unter `requireAdmin` ausreichend.
router.get("/:customerId/initial-balance/:allocationId/usage", requireAdmin, asyncHandler("Allokations-Nutzung konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  const allocationId = requireIntParam(req.params.allocationId, res);
  if (customerId === null || allocationId === null) return;

  const { db: database } = await import("../lib/db");
  const { budgetTransactions } = await import("@shared/schema");
  const { eq, and, isNotNull, sql } = await import("drizzle-orm");

  const rows = await database
    .select({ count: sql<number>`COUNT(DISTINCT ${budgetTransactions.appointmentId})::int` })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.allocationId, allocationId),
      eq(budgetTransactions.transactionType, "consumption"),
      isNotNull(budgetTransactions.appointmentId),
    ));

  const appointmentCount = rows[0]?.count ?? 0;
  res.json({ appointmentCount });
}));

router.delete("/:customerId/initial-balance/:allocationId", requireAdmin, asyncHandler("Startwert konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  const allocationId = requireIntParam(req.params.allocationId, res);
  if (customerId === null || allocationId === null) return;

  const userId = req.user?.id;
  const { db: database } = await import("../lib/db");
  const { budgetAllocations } = await import("@shared/schema");
  const { eq, and, or } = await import("drizzle-orm");
  const { budgetAllocationsRepo } = await import("../repos");

  // Task #608: Lookup + Soft-Delete + Settings-Cleanup laufen in einer
  // Transaktion. So bleibt sichergestellt, dass die zugehörigen Legacy-Felder
  // (`initial_balance_cents`/`_month`) in `customer_budget_type_settings`
  // gemeinsam mit der Allocation neutralisiert werden — sonst materialisiert
  // der nächste Recompute einen Geister-Übertrag aus diesen Spalten.
  const existing = await database.transaction(async (tx) => {
    const rows = await budgetAllocationsRepo.selectFrom(tx)
      .where(and(
        eq(budgetAllocations.id, allocationId),
        eq(budgetAllocations.customerId, customerId),
        budgetAllocationsRepo.activeOnly(),
        or(
          eq(budgetAllocations.source, "initial_balance"),
          eq(budgetAllocations.source, "carryover"),
          eq(budgetAllocations.source, "manual_adjustment"),
        ),
      ))
      .limit(1);

    if (rows.length === 0) return null;

    await tx.update(budgetAllocations)
      .set({ deletedAt: new Date() })
      .where(eq(budgetAllocations.id, allocationId));

    // Nur für §45b Startwert/Carryover — andere Töpfe (§45a/§39) haben die
    // Legacy-Felder ohnehin nicht im Einsatz.
    const r = rows[0];
    if (
      r.budgetType === "entlastungsbetrag_45b"
      && (r.source === "initial_balance" || r.source === "carryover")
    ) {
      await budgetStorage.clearLegacyInitialBalanceFromSettings(customerId, r.budgetType, tx, userId);
      // Task #1204 — Kein kunden-weiter `budget_start_date` mehr: der §45b-Anker
      // wird zur Laufzeit aus der Pflegegrad-Historie abgeleitet, daher ist beim
      // Löschen eines Startwerts/Carryovers keine Anker-Neuableitung nötig.
    }

    return r;
  });

  if (existing === null) {
    res.status(404).json({ error: "NOT_FOUND", message: "Startwert nicht gefunden" });
    return;
  }

  if (userId) {
    const ip = req.ip || req.socket.remoteAddress;
    // Task #440: Konsistente GoBD-Taxonomie — alle Soft-Deletes auf
    // `budget_allocations` erzeugen zusätzlich einen `budget_allocation_soft_deleted`-
    // Eintrag (analog zu allocation-storage.ts), sodass forensische Queries
    // gegen den gemeinsamen Action-Namen filtern können. Das fachliche
    // `initial_balance_deleted` bleibt für die Domänensicht erhalten.
    await auditService.log(userId, "budget_allocation_soft_deleted", "budget", customerId, {
      customerId,
      allocationId,
      amountCents: existing.amountCents,
      budgetType: existing.budgetType,
      source: existing.source,
      reason: "initial_balance_deleted",
    }, ip);
    await auditService.log(userId, "initial_balance_deleted", "budget", customerId, {
      customerId,
      allocationId,
      amountCents: existing.amountCents,
      budgetType: existing.budgetType,
      source: existing.source,
    }, ip);
  }

  res.json({ success: true });
}));

// Task #670 — Manueller §45b-Carryover ("Restguthaben aus Vorjahr").
// Eigenes Endpoint, getrennt vom Startwert-Pfad, damit Validierung und Audit
// fachlich sauber unterscheidbar bleiben (Quelljahr-Plausibilität, eigener
// Audit-Action-Name `carryover_set`). Delete teilt sich mit dem Startwert den
// `DELETE /:customerId/initial-balance/:allocationId`-Pfad, da dort beide
// Quellen (`initial_balance`, `carryover`) bereits behandelt werden.
const carryoverSchema = z.object({
  amountCents: z.number().int().min(1, "Betrag muss größer als 0 € sein"),
  sourceYear: z.number().int().min(2020, "Bezugsjahr muss zwischen 2020 und dem Vorjahr liegen").max(2100),
});

router.post("/:customerId/carryover/:budgetType", requireAdmin, asyncHandler("Restguthaben aus Vorjahr konnte nicht gespeichert werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const budgetType = req.params.budgetType;

  // Carryover ist gem. §45b SGB XI Abs. 3 nur für den Entlastungsbetrag definiert.
  if (budgetType !== "entlastungsbetrag_45b") {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Restguthaben aus Vorjahr ist nur für den Entlastungsbetrag §45b verfügbar.",
    });
    return;
  }

  // Task #705 / #716 — Selbstzahler-Block via shared Validator.
  if (await rejectIfSelbstzahler45b(customerId, budgetType, res)) return;

  const result = carryoverSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }

  const { sourceYear, amountCents } = result.data;
  const currentYear = new Date().getFullYear();
  if (sourceYear >= currentYear) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: `Bezugsjahr muss ein Vorjahr sein (kleiner als ${currentYear}).`,
    });
    return;
  }

  const window = carryoverWindowFor(sourceYear);
  const userId = req.user?.id;

  await budgetStorage.upsertCarryoverAllocation({
    customerId,
    budgetType,
    sourceYear,
    amountCents,
    notes: `Restguthaben aus ${sourceYear} (verfällt 30.06.${window.targetYear})`,
  }, userId);

  if (userId) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.log(userId, "carryover_set", "budget", customerId, {
      customerId,
      budgetType,
      sourceYear,
      targetYear: window.targetYear,
      amountCents,
      validFrom: window.validFrom,
      expiresAt: window.expiresAt,
    }, ip);
  }

  const allocations = await budgetStorage.getInitialBalanceAllocations(customerId, budgetType);
  res.json(allocations);
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

  const enabledTypes = new Set(
    result.data.settings.filter(s => s.enabled).map(s => s.budgetType),
  );
  // Task #1225 — Kunden-Existenzprüfung für JEDEN Payload, nicht nur wenn ein
  // Topf aktiviert wird. Früher lief diese Prüfung nur bei `enabledTypes.size
  // > 0`; ein reiner Deaktivier-Payload (alle Töpfe enabled:false) auf eine
  // nicht existierende Kunden-ID rauschte blind in den Append-/Insert-Pfad und
  // erzeugte eine Foreign-Key-Verletzung (500). Jetzt: Kunde einmal laden, bei
  // fehlendem Kunden sauber mit 404 antworten, bevor der Schreibpfad erreicht
  // wird. Der geladene Kunde wird unten für die PG-abhängige Limit-Validierung
  // wiederverwendet.
  const customer = await storage.getCustomer(customerId);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }
  // Task #705 / #716 / #722 / #1168 — Selbstzahler-/Pflegegrad-Block via shared
  // Validatoren. Greift pro Topf nur, wenn der Save eine `enabled=true`-Zeile
  // für genau diesen Topf enthält (Deaktivieren bleibt immer erlaubt, damit
  // Bestandskunden ihre falsch angelegte Konfiguration jederzeit zurückbauen
  // können).
  if (enabledTypes.size > 0) {
    for (const budgetType of ["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"] as const) {
      if (enabledTypes.has(budgetType) && rejectBudgetIntent(
        { billingType: customer.billingType, pflegegrad: customer.pflegegrad, budgetType },
        res,
      )) return;
    }
  }

  for (const s of result.data.settings) {
    if (s.validFrom && s.validTo && s.validFrom > s.validTo) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: `'Gültig ab' darf nicht nach 'Gültig bis' liegen (${s.budgetType})` });
      return;
    }
    // Task #603 — Per-Kunde konfigurierbarer §45b-Monats-Anteil ist auf das
    // gesetzliche Maximum (131 €) gedeckelt. Server-seitige Validierung in
    // Deutsch, damit das Frontend den Fehler 1:1 anzeigen kann.
    if (s.budgetType === "entlastungsbetrag_45b" && s.monthlyLimitCents != null && s.monthlyLimitCents > BUDGET_45B_MAX_MONTHLY_CENTS) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: `§45b: Unser Anteil darf maximal ${formatEuroDE(BUDGET_45B_MAX_MONTHLY_CENTS)}/Monat betragen (gesetzliches Maximum).`,
      });
      return;
    }
    // Task #1168 — §45a-Monatslimit gegen das PG-abhängige Maximum und
    // §39/§42a-Jahreslimit gegen das gesetzliche Maximum (3.539 €) hart
    // ablehnen. Nur für `enabled`-Zeilen (Deaktivieren bleibt erlaubt;
    // Bestands-Über-Limit-Werte räumt das Klemm-Skript auf, der Lesepfad
    // klemmt ohnehin via `clampToStatutoryMax`).
    if (s.enabled && s.budgetType === "umwandlung_45a" && s.monthlyLimitCents != null) {
      const msg = validate45aAmount(s.monthlyLimitCents, customer?.pflegegrad ?? null);
      if (msg) {
        res.status(400).json({ error: "VALIDATION_ERROR", message: msg });
        return;
      }
    }
    if (s.enabled && s.budgetType === "ersatzpflege_39_42a" && s.yearlyLimitCents != null) {
      const msg = validate39_42aAmount(s.yearlyLimitCents);
      if (msg) {
        res.status(400).json({ error: "VALIDATION_ERROR", message: msg });
        return;
      }
    }
  }

  const userId = req.user?.id;
  // userId an Storage durchreichen, damit jede Settings-Transition GoBD-konform
  // ein `budget_type_settings_transition`-Audit-Log mit Akteur bekommt (Task #440).
  const saved = await budgetStorage.upsertBudgetTypeSettings(customerId, result.data.settings, undefined, userId);

  await budgetStorage.syncCarryoverAndExpiry(customerId);

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

  // Task #705 / #716 — Selbstzahler-Block via shared Validator.
  if (await rejectIfSelbstzahler45b(customerId, result.data.budgetType, res)) return;

  const userId = req.user?.id;
  const allocation = await budgetStorage.createBudgetAllocation(result.data, userId);
  res.status(201).json(allocation);
}));

// Task #705 / #725 / #731 — `currentMonthAmountCents` ist semantisch ein
// MONATSwert (er wird als `initial_balance`-Allokation für genau den
// Startmonat aus `budgetStartDate` angelegt, NICHT als Jahresbetrag
// verteilt). Der alte Alias `currentYearAmountCents` wurde nach einem
// Release-Zyklus entfernt (#731). Semantik pro Topf siehe
// `docs/architecture/budget.md → initial-budget-Endpoint`.
const initialBudgetSchema = z.object({
  budgetType: z.enum(BUDGET_TYPES).default("entlastungsbetrag_45b"),
  currentMonthAmountCents: z.number().min(0),
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

  const { budgetType, carryoverAmountCents, currentMonthAmountCents, budgetStartDate } = result.data;
  const userId = req.user?.id;

  const customer = await storage.getCustomer(customerId);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  // Task #1213 — Erfassungs-Logik (§45b-Kappung, §45a/§39-Aktivierung,
  // initial_balance, Carryover, Anker-Preferences) liegt zentral in
  // `applyInitialBudget` (SSoT, auch vom atomaren Kunden-Anlage-Flow genutzt).
  // Die Route übersetzt nur typisierte Fehler ins Wire-Format.
  try {
    const allocations = await applyInitialBudget({
      customerId,
      budgetType,
      currentMonthAmountCents,
      carryoverAmountCents,
      budgetStartDate,
      customer: { billingType: customer.billingType, pflegegrad: customer.pflegegrad },
      userId,
      ip: req.ip || req.socket.remoteAddress || null,
    });
    res.status(201).json({
      message: "Startbudget erfolgreich erfasst",
      allocations,
    });
  } catch (err) {
    if (err instanceof BudgetInitialSetupError) {
      res.status(err.httpStatus).json({ error: err.code, code: err.code, message: err.message });
      return;
    }
    throw err;
  }
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
  const preferences = await budgetStorage.upsertBudgetPreferences(
    result.data,
    userId,
  );

  if (userId) {
    const ip = req.ip || req.socket.remoteAddress;
    await auditService.log(userId, "budget_preferences_updated", "budget", customerId, {
      customerId,
      monthlyLimitCents: result.data.monthlyLimitCents ?? null,
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

  // Task #705 / #716 — Selbstzahler-Block via shared Validator.
  if (await rejectIfSelbstzahler45b(customerId, budgetType, res)) return;

  if (amountCents > 0) {
    const expiresAt = budgetType === "ersatzpflege_39_42a" ? `${currentYear}-12-31` : null;
    const allocation = await budgetStorage.createBudgetAllocation({
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
    const transaction = await budgetStorage.createBudgetTransaction({
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
  const outcome = await budgetStorage.reverseBudgetTransactionWithOutcome(transactionId, userId);

  if (outcome.status === "not_found") {
    res.status(404).json({
      error: "NOT_FOUND",
      message: "Transaktion nicht gefunden",
    });
    return;
  }

  // Task #1170 — ein Storno kann NICHT storniert werden (kein „Storno eines
  // Stornos"). Sonst entstünde ohne Termin-Dokumentation Wieder-Verbrauch.
  if (outcome.status === "not_reversible") {
    res.status(400).json({
      error: "REVERSAL_NOT_REVERSIBLE",
      message: "Eine Storno-Buchung kann nicht erneut storniert werden. Stattdessen muss der ursprüngliche Vorgang neu gebucht werden.",
    });
    return;
  }

  // Task #1170 — Doppel-Storno derselben Original-Buchung ist idempotent: KEINE
  // zweite Reversal-Zeile, KEIN erneuter Audit-Eintrag, Status 409 (Konflikt)
  // statt fälschlich 201 (Created). Die bereits existierende Reversal wird
  // zurückgegeben, damit Clients das Ergebnis kennen.
  if (outcome.status === "already_reversed") {
    res.status(409).json({
      error: "ALREADY_REVERSED",
      message: "Diese Transaktion wurde bereits storniert.",
      reversal: outcome.reversal,
    });
    return;
  }

  const reversal = outcome.reversal;

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

  const rebookResult = await budgetStorage.rebookSingleTransaction(customerId, transactionId, targetBudgetType, userId);

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

  const preview = await budgetStorage.getRebookPreview(customerId);
  res.json(preview);
}));

router.post("/:customerId/rebook", requireAdmin, asyncHandler("Umbuchung konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const userId = req.user!.id;
  const result = await budgetStorage.rebookDisabledBudgetTransactions(customerId, userId);

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

router.post("/admin/repair-orphaned-transactions", requireAdmin, asyncHandler("Budget-Reparatur fehlgeschlagen", async (req: Request, res: Response) => {
  const execute = req.query.execute === "true";
  const userId = req.user!.id;

  const { db: drizzleDb } = await import("../lib/db");
  const { appointments, budgetTransactions } = await import("@shared/schema");
  const { eq, and, isNotNull, isNull, sql } = await import("drizzle-orm");

  const softDeletedOrphans = await drizzleDb.select({
    txId: budgetTransactions.id,
    appointmentId: budgetTransactions.appointmentId,
    customerId: budgetTransactions.customerId,
    amountCents: budgetTransactions.amountCents,
    transactionDate: budgetTransactions.transactionDate,
    budgetType: budgetTransactions.budgetType,
  })
    .from(budgetTransactions)
    .innerJoin(appointments, eq(budgetTransactions.appointmentId, appointments.id))
    .where(and(
      eq(budgetTransactions.transactionType, "consumption"),
      isNotNull(appointments.deletedAt),
      sql`NOT EXISTS (
        SELECT 1 FROM budget_transactions r
        WHERE r.reversed_transaction_id = ${budgetTransactions.id}
          AND r.transaction_type = 'reversal'
      )`
    ));

  const hardDeletedOrphans = await drizzleDb.select({
    txId: budgetTransactions.id,
    appointmentId: budgetTransactions.appointmentId,
    customerId: budgetTransactions.customerId,
    amountCents: budgetTransactions.amountCents,
    transactionDate: budgetTransactions.transactionDate,
    budgetType: budgetTransactions.budgetType,
  })
    .from(budgetTransactions)
    .leftJoin(appointments, eq(budgetTransactions.appointmentId, appointments.id))
    .where(and(
      eq(budgetTransactions.transactionType, "consumption"),
      isNotNull(budgetTransactions.appointmentId),
      isNull(appointments.id),
      sql`NOT EXISTS (
        SELECT 1 FROM budget_transactions r
        WHERE r.reversed_transaction_id = ${budgetTransactions.id}
          AND r.transaction_type = 'reversal'
      )`
    ));

  const orphanedConsumptions = [...softDeletedOrphans, ...hardDeletedOrphans];

  const duplicateReversals = await drizzleDb.execute(sql`
    SELECT bt.id, bt.reversed_transaction_id, bt.amount_cents, bt.customer_id, bt.appointment_id
    FROM budget_transactions bt
    WHERE bt.transaction_type = 'reversal'
      AND bt.reversed_transaction_id IS NOT NULL
      AND bt.id > (
        SELECT MIN(bt2.id)
        FROM budget_transactions bt2
        WHERE bt2.reversed_transaction_id = bt.reversed_transaction_id
          AND bt2.transaction_type = 'reversal'
      )
  `);

  const summary = {
    orphanedConsumptions: orphanedConsumptions.map(oc => ({
      transactionId: oc.txId,
      appointmentId: oc.appointmentId,
      customerId: oc.customerId,
      amountCents: oc.amountCents,
      euroAmount: centsToEuroNumber(Math.abs(oc.amountCents)).toFixed(2),
      transactionDate: oc.transactionDate,
      budgetType: oc.budgetType,
    })),
    duplicateReversals: (duplicateReversals.rows || []).map((dr: any) => ({
      transactionId: dr.id,
      reversedTransactionId: dr.reversed_transaction_id,
      amountCents: dr.amount_cents,
      customerId: dr.customer_id,
      appointmentId: dr.appointment_id,
    })),
    totalOrphaned: orphanedConsumptions.length,
    totalDuplicates: (duplicateReversals.rows || []).length,
    executed: false,
  };

  if (execute) {
    let reversedCount = 0;
    let deletedDuplicates = 0;
    const errors: { txId: number; error: string }[] = [];

    for (const oc of orphanedConsumptions) {
      try {
        await budgetStorage.reverseBudgetTransaction(oc.txId, userId);
        reversedCount++;
      } catch (err) {
        errors.push({ txId: oc.txId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const dr of (duplicateReversals.rows || []) as any[]) {
      try {
        // Task #1273: budget_transactions ist seit Stufe B GoBD-immutable
        // (BEFORE-Trigger). Das Aufräumen einer Duplikat-Reversal-Zeile braucht
        // den Bypass — dieser muss innerhalb EINER Transaktion gesetzt werden
        // (`SET LOCAL`), daher den Delete in eine Tx kapseln.
        await drizzleDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
          await tx.delete(budgetTransactions)
            .where(eq(budgetTransactions.id, dr.id));
        });
        deletedDuplicates++;
      } catch (err) {
        errors.push({ txId: dr.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    summary.executed = true;

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    await auditService.log(userId, "budget_repair_orphaned", "budget", 0, {
      reversedCount,
      deletedDuplicates,
      errors,
      orphanedDetails: summary.orphanedConsumptions,
      duplicateDetails: summary.duplicateReversals,
    }, ip);

    res.json({ ...summary, reversedCount, deletedDuplicates, errors });
  } else {
    res.json(summary);
  }
}));

export default router;
