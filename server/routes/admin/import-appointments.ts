import { Router, Request, Response } from "express";
import { requireSuperAdmin } from "../../middleware/auth";
import { asyncHandler } from "../../lib/errors";
import multer from "multer";
import {
  parseExcelFile,
  matchRows,
  enrichWithBudgetInfo,
  executeImport,
  createServiceRecordsForImported,
  type MatchedRow,
} from "../../services/appointment-import";
import { z } from "zod";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireSuperAdmin);

router.post(
  "/import-appointments/preview",
  upload.single("file"),
  asyncHandler("Excel-Datei konnte nicht verarbeitet werden", async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "Keine Datei hochgeladen" });
      return;
    }

    const parsed = parseExcelFile(req.file.buffer);
    const matched = await matchRows(parsed);
    await enrichWithBudgetInfo(matched);

    const summary = {
      total: matched.length,
      new: matched.filter((r) => r.status === "new").length,
      duplicate: matched.filter((r) => r.status === "duplicate").length,
      error: matched.filter((r) => r.status === "error").length,
      budgetTrimmed: matched.filter((r) => r.budgetTrimInfo !== null).length,
    };

    res.json({ rows: matched, summary });
  })
);

const matchedRowSchema = z.object({
  rowIndex: z.number(),
  kundeRaw: z.string(),
  kundeId: z.string(),
  vorname: z.string(),
  nachname: z.string(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  durationMinutes: z.number(),
  kilometers: z.number(),
  employeeName: z.string(),
  serviceType: z.string(),
  budgetType: z.string(),
  pflegekasseName: z.string(),
  pflegekasseIK: z.string(),
  versichertennummer: z.string(),
  pflegegrad: z.string(),
  customerId: z.number().nullable(),
  employeeId: z.number().nullable(),
  serviceId: z.number().nullable(),
  budgetTypeKey: z.string().nullable(),
  status: z.enum(["new", "duplicate", "error"]),
  errors: z.array(z.string()),
  existingAppointmentId: z.number().nullable(),
  differences: z.array(z.string()),
  budgetTrimInfo: z.object({
    originalMinutes: z.number(),
    trimmedMinutes: z.number(),
    reason: z.string(),
  }).nullable().optional(),
});

const executeSchema = z.object({
  rows: z.array(matchedRowSchema),
  actions: z.array(
    z.object({
      action: z.enum(["import", "update", "skip"]),
      rowIndex: z.number(),
      employeeIdOverride: z.number().optional(),
    })
  ),
});

router.post(
  "/import-appointments/execute",
  asyncHandler("Import konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
    const { rows, actions } = executeSchema.parse(req.body);

    const matchedRows: MatchedRow[] = rows;

    for (const action of actions) {
      if (action.employeeIdOverride) {
        const row = matchedRows.find((r) => r.rowIndex === action.rowIndex);
        if (row) {
          row.employeeId = action.employeeIdOverride;
        }
      }
    }

    const result = await executeImport(matchedRows, actions, req.user!.id);
    res.json(result);
  })
);

router.post(
  "/import-appointments/create-service-records",
  asyncHandler("Leistungsnachweise konnten nicht erstellt werden", async (req: Request, res: Response) => {
    const result = await createServiceRecordsForImported(req.user!.id);
    res.json(result);
  })
);

router.get(
  "/import-appointments/employees",
  asyncHandler("Mitarbeiter konnten nicht geladen werden", async (_req: Request, res: Response) => {
    const { users } = await import("@shared/schema");
    const { db } = await import("../../lib/db");
    const allUsers = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users);
    res.json(allUsers);
  })
);

export default router;
