import { Router } from "express";
import { asyncHandler, forbidden } from "../../../lib/errors";
import { resolvePeriod } from "../../../storage/statistics/common";
import { getCockpit } from "../../../storage/statistics/cockpit";
import {
  getProcessHealthSummary,
  listCustomersWithoutEmployee,
  listCustomersWithoutAppointments,
  listUndocumentedAppointments,
  listAppointmentsWithoutRecord,
  listRecordsWithoutInvoice,
} from "../../../storage/statistics/process-health";
import { getCustomerStats } from "../../../storage/statistics/customers";
import { getRevenueStats } from "../../../storage/statistics/revenue";
import { getPerformanceStats } from "../../../storage/statistics/performance";
import { getBudgetStats } from "../../../storage/statistics/budgets";

const router = Router();

router.use((req, _res, next) => {
  if (!req.user!.isAdmin) return next(forbidden("FORBIDDEN", "Nur für Administratoren"));
  next();
});

router.get("/cockpit", asyncHandler("Cockpit konnte nicht geladen werden", async (req, res) => {
  res.json(await getCockpit(resolvePeriod(req.query)));
}));

router.get("/process-health", asyncHandler("Prozess-Gesundheit konnte nicht geladen werden", async (req, res) => {
  res.json(await getProcessHealthSummary(resolvePeriod(req.query)));
}));

router.get("/process-health/customers-without-employee",
  asyncHandler("Drill-Down konnte nicht geladen werden", async (_req, res) => {
    res.json(await listCustomersWithoutEmployee());
  }));

router.get("/process-health/customers-without-appointments",
  asyncHandler("Drill-Down konnte nicht geladen werden", async (req, res) => {
    res.json(await listCustomersWithoutAppointments(resolvePeriod(req.query)));
  }));

router.get("/process-health/undocumented-appointments",
  asyncHandler("Drill-Down konnte nicht geladen werden", async (_req, res) => {
    res.json(await listUndocumentedAppointments());
  }));

router.get("/process-health/appointments-without-record",
  asyncHandler("Drill-Down konnte nicht geladen werden", async (req, res) => {
    res.json(await listAppointmentsWithoutRecord(resolvePeriod(req.query)));
  }));

router.get("/process-health/records-without-invoice",
  asyncHandler("Drill-Down konnte nicht geladen werden", async (req, res) => {
    res.json(await listRecordsWithoutInvoice(resolvePeriod(req.query)));
  }));

router.get("/customers", asyncHandler("Kunden-Statistiken konnten nicht geladen werden", async (req, res) => {
  res.json(await getCustomerStats(resolvePeriod(req.query)));
}));

router.get("/revenue", asyncHandler("Umsatz-Statistiken konnten nicht geladen werden", async (req, res) => {
  res.json(await getRevenueStats(resolvePeriod(req.query)));
}));

router.get("/performance", asyncHandler("Leistungs-Statistiken konnten nicht geladen werden", async (req, res) => {
  res.json(await getPerformanceStats(resolvePeriod(req.query)));
}));

router.get("/budgets", asyncHandler("Budget-Statistiken konnten nicht geladen werden", async (req, res) => {
  res.json(await getBudgetStats(resolvePeriod(req.query)));
}));

export default router;
