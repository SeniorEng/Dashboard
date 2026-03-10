import { Router, Request, Response } from "express";
import { timeTrackingStorage } from "../../storage/time-tracking";
import { 
  insertVacationAllowanceSchema,
  appointmentServices as appointmentServicesTable,
  services as servicesTable,
} from "@shared/schema";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { db } from "../../lib/db";
import { eq, inArray } from "drizzle-orm";

const router = Router();

// ============================================
// TIME TRACKING (Admin)
// ============================================

router.get("/time-entries", asyncHandler("Zeiteinträge konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { year, month, userId, entryType } = req.query;
  
  const entries = await timeTrackingStorage.getAllTimeEntries({
    year: year ? parseInt(year as string) : undefined,
    month: month ? parseInt(month as string) : undefined,
    userId: userId ? parseInt(userId as string) : undefined,
    entryType: entryType as string | undefined,
  });
  
  res.json(entries);
}));

router.get("/employee-appointments", asyncHandler("Termine konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { year, month, userId } = req.query;
  if (!year || !month) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Jahr und Monat sind erforderlich" });
    return;
  }
  const y = parseInt(year as string);
  const m = parseInt(month as string);
  const monthStr = m.toString().padStart(2, "0");
  const startDate = `${y}-${monthStr}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const endDate = `${y}-${monthStr}-${lastDay}`;

  let appts;
  if (userId && userId !== "all") {
    const uid = parseInt(userId as string);
    appts = await timeTrackingStorage.getEmployeeAppointments(uid, startDate, endDate);
  } else {
    appts = await timeTrackingStorage.getAllAppointmentsInRange(startDate, endDate);
  }

  const apptIds = appts.map(a => a.id);
  let servicesByAppt = new Map<number, Array<{ serviceCode: string | null; serviceName: string; actualMinutes: number | null; plannedMinutes: number }>>();
  if (apptIds.length > 0) {
    const svcRows = await db.select({
      appointmentId: appointmentServicesTable.appointmentId,
      serviceCode: servicesTable.code,
      serviceName: servicesTable.name,
      plannedMinutes: appointmentServicesTable.plannedDurationMinutes,
      actualMinutes: appointmentServicesTable.actualDurationMinutes,
    })
    .from(appointmentServicesTable)
    .innerJoin(servicesTable, eq(appointmentServicesTable.serviceId, servicesTable.id))
    .where(inArray(appointmentServicesTable.appointmentId, apptIds));

    for (const row of svcRows) {
      if (!servicesByAppt.has(row.appointmentId)) servicesByAppt.set(row.appointmentId, []);
      servicesByAppt.get(row.appointmentId)!.push({
        serviceCode: row.serviceCode,
        serviceName: row.serviceName,
        actualMinutes: row.actualMinutes,
        plannedMinutes: row.plannedMinutes,
      });
    }
  }

  const enriched = appts.map(a => ({
    ...a,
    appointmentServiceDetails: servicesByAppt.get(a.id) || [],
  }));

  res.json(enriched);
}));

router.get("/time-entries/vacation-summary/:userId/:year", asyncHandler("Urlaubsübersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
  const userId = requireIntParam(req.params.userId, res);
  if (userId === null) return;
  const year = requireIntParam(req.params.year, res);
  if (year === null) return;
  
  const summary = await timeTrackingStorage.getVacationSummary(userId, year);
  res.json(summary);
}));

router.put("/time-entries/vacation-allowance", asyncHandler("Urlaubskontingent konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const validatedData = insertVacationAllowanceSchema.parse(req.body);
  const allowance = await timeTrackingStorage.setVacationAllowance(validatedData);
  res.json(allowance);
}));

export default router;
