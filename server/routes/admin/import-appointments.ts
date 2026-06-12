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
import { reconcileCustomerStructured } from "../../scripts/reconcile-trimmed-imports";
import {
  previewReconcile,
  executeReconcile,
} from "../../services/appointment-import-reconcile";
import {
  storeImportPreview,
  loadImportPreview,
  storeReconcilePreview,
  loadReconcilePreview,
  consumePreview,
} from "../../services/import-preview-cache";
import { computeLastExcelMonth } from "@shared/domain/import-cutoff";
import { createHash } from "crypto";
import { importBatchesStorage } from "../../storage/import-batches";

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

    // Task #819: SHA-256 des Datei-Puffers → Doppel-Import-Erkennung.
    const fileHash = createHash("sha256").update(req.file.buffer).digest("hex");
    const previousBatch = await importBatchesStorage.findByHash(fileHash);

    const parsed = await parseExcelFile(req.file.buffer);
    const matched = await matchRows(parsed);
    await enrichWithBudgetInfo(matched);

    const summary = {
      total: matched.length,
      new: matched.filter((r) => r.status === "new").length,
      duplicate: matched.filter((r) => r.status === "duplicate").length,
      upgrade: matched.filter((r) => r.status === "upgrade").length,
      beyondCutoff: matched.filter((r) => r.status === "beyond_cutoff").length,
      error: matched.filter((r) => r.status === "error").length,
      budgetTrimmed: matched.filter((r) => r.budgetTrimInfo !== null).length,
      // Task #1243: Vorjahres-Termine echter Pflegekassen-Kunden, die nur als
      // Dokumentation (ohne Budgetverbrauch) importiert werden.
      documentationOnly: matched.filter((r) => r.documentationOnly === true).length,
    };

    // Task #708: Server-trusted Snapshot — Cutoff aus den vom Server selbst
    // geparsten Excel-Daten + Whitelist erlaubter rowIndexes mit ihren
    // Original-Daten. Execute prüft gegen diesen Snapshot, sodass ein
    // manipulierter Client weder Cutoff noch Zeilen-Daten verschieben kann.
    const excelCutoff = computeLastExcelMonth(matched.map((r) => r.date));
    const rows = new Map<number, import("../../services/import-preview-cache").TrustedRowSnapshot>();
    const allowedRowIndexes = new Set<number>();
    for (const r of matched) {
      rows.set(r.rowIndex, {
        date: r.date,
        customerId: r.customerId,
        employeeId: r.employeeId,
        serviceId: r.serviceId,
        existingAppointmentId: r.existingAppointmentId,
        status: r.status,
      });
      allowedRowIndexes.add(r.rowIndex);
    }
    const previewToken = storeImportPreview(req.user!.id, {
      excelCutoff,
      allowedRowIndexes,
      rows,
      fileHash,
      fileName: req.file.originalname ?? null,
    });

    const duplicateImportWarning = previousBatch
      ? {
          batchId: previousBatch.id,
          fileName: previousBatch.fileName,
          importedAt: previousBatch.createdAt,
          importedCount: previousBatch.importedCount,
          updatedCount: previousBatch.updatedCount,
        }
      : null;

    res.json({ rows: matched, summary, previewToken, fileHash, duplicateImportWarning });
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
  status: z.enum(["new", "duplicate", "upgrade", "beyond_cutoff", "error"]),
  errors: z.array(z.string()),
  existingAppointmentId: z.number().nullable(),
  differences: z.array(z.string()),
  budgetTrimInfo: z.object({
    originalMinutes: z.number(),
    trimmedMinutes: z.number(),
    reason: z.string(),
  }).nullable().optional(),
  diff: z.object({
    serviceCode: z.object({ db: z.string().nullable(), excel: z.string() }).optional(),
    durationMinutes: z.object({ db: z.number(), excel: z.number() }).optional(),
    endTime: z.object({ db: z.string(), excel: z.string() }).optional(),
    assignedEmployee: z.object({
      dbId: z.number().nullable(),
      dbName: z.string().nullable(),
      excelId: z.number().nullable(),
      excelName: z.string(),
    }).optional(),
    kilometers: z.object({ db: z.number(), excel: z.number() }).optional(),
  }).nullable().optional(),
});

const executeSchema = z.object({
  rows: z.array(matchedRowSchema),
  actions: z.array(
    z.object({
      action: z.enum(["import", "update", "upgrade", "skip"]),
      rowIndex: z.number(),
      employeeIdOverride: z.number().optional(),
    })
  ),
  /**
   * Task #708: Pflicht-Token aus dem vorhergehenden /preview-Call.
   * Server-trusted Snapshot enthält den aus der Original-Excel berechneten
   * Cutoff. Fehlt der Token oder gehört er einem anderen User, wird der
   * Execute abgelehnt — kein Cutoff-Bypass durch Client-Manipulation.
   */
  previewToken: z.string().uuid("previewToken muss eine gültige UUID sein"),
});

router.post(
  "/import-appointments/execute",
  asyncHandler("Import konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
    const { rows, actions, previewToken } = executeSchema.parse(req.body);

    // Task #708: Server-trusted Snapshot laden. Wenn nicht (mehr) vorhanden,
    // muss der User neu Preview-en — wir akzeptieren keinen Fallback, weil
    // genau das die Bypass-Lücke war.
    const snapshot = loadImportPreview(previewToken, req.user!.id);
    if (!snapshot) {
      res.status(409).json({
        error:
          "Preview ist abgelaufen oder ungültig. Bitte Excel-Datei erneut hochladen.",
      });
      return;
    }

    // Task #708 v4: Eingehende Zeilen müssen Teil des Preview-Snapshots sein
    // UND alle sicherheitsrelevanten Felder müssen exakt dem trusted Preview
    // entsprechen. So kann ein manipulierter Client weder Datum noch das
    // Mutations-Ziel (existingAppointmentId) noch Customer/Service/Employee
    // einer legitimen rowIndex-Zeile verschieben.
    //
    // employeeId ist Sonderfall: Der Operator darf während Execute via
    // `employeeIdOverride` einen Mitarbeiter zuordnen, daher prüfen wir hier
    // nur, dass der Payload mit dem Snapshot übereinstimmt — der spätere
    // Override wird unten gegen den trusted Snapshot angewandt.
    for (const r of rows) {
      if (!snapshot.allowedRowIndexes.has(r.rowIndex)) {
        res.status(400).json({
          error: `Unbekannte Zeile (rowIndex=${r.rowIndex}) — nicht Teil des Preview-Snapshots.`,
        });
        return;
      }
      const trusted = snapshot.rows.get(r.rowIndex)!;
      const mismatches: string[] = [];
      if (trusted.date !== r.date) mismatches.push(`date(${trusted.date}≠${r.date})`);
      if (trusted.customerId !== r.customerId)
        mismatches.push(`customerId(${trusted.customerId}≠${r.customerId})`);
      if (trusted.serviceId !== r.serviceId)
        mismatches.push(`serviceId(${trusted.serviceId}≠${r.serviceId})`);
      if (trusted.employeeId !== r.employeeId)
        mismatches.push(`employeeId(${trusted.employeeId}≠${r.employeeId})`);
      if (trusted.existingAppointmentId !== r.existingAppointmentId)
        mismatches.push(
          `existingAppointmentId(${trusted.existingAppointmentId}≠${r.existingAppointmentId})`,
        );
      if (trusted.status !== r.status)
        mismatches.push(`status(${trusted.status}≠${r.status})`);
      if (mismatches.length > 0) {
        res.status(400).json({
          error: `Zeile manipuliert (rowIndex=${r.rowIndex}): ${mismatches.join(", ")}.`,
        });
        return;
      }
    }

    // Trusted Zeilen aus dem Snapshot anstelle des Client-Payloads
    // weiterverarbeiten — der Client-Payload diente nur dazu, Aktionen pro
    // rowIndex zu bestimmen.
    const matchedRows: MatchedRow[] = rows.map((r) => {
      const trusted = snapshot.rows.get(r.rowIndex)!;
      return {
        ...r,
        date: trusted.date,
        customerId: trusted.customerId,
        serviceId: trusted.serviceId,
        employeeId: trusted.employeeId,
        existingAppointmentId: trusted.existingAppointmentId,
        status: trusted.status,
        budgetTrimInfo: r.budgetTrimInfo ?? null,
        diff: r.diff ?? null,
        // Task #1243: Der Dokumentations-Entscheid wird in `executeImport`
        // serverseitig neu berechnet (Defense-in-depth); hier nur Default.
        documentationImport: false,
      };
    });

    for (const action of actions) {
      if (action.employeeIdOverride) {
        const row = matchedRows.find((r) => r.rowIndex === action.rowIndex);
        if (row) {
          row.employeeId = action.employeeIdOverride;
        }
      }
    }

    // Task #819: Import-Batch anlegen (Datei-Hash aus dem trusted Snapshot),
    // damit alle erzeugten/aktualisierten Termine + Budget-Buchungen über
    // `import_batch_id` auf diesen Lauf zurückführbar sind.
    const batch = await importBatchesStorage.create({
      fileName: snapshot.fileName,
      fileHash: snapshot.fileHash,
      rowCount: matchedRows.length,
      createdByUserId: req.user!.id,
    });

    // Cutoff kommt ausschließlich aus dem server-trusted Snapshot.
    const result = await executeImport(
      matchedRows,
      actions,
      req.user!.id,
      snapshot.excelCutoff,
      batch.id,
    );

    await importBatchesStorage.updateCounts(batch.id, {
      importedCount: result.imported,
      updatedCount: result.updated + result.upgraded,
      skippedCount: result.skipped,
    });

    consumePreview(previewToken);
    res.json({ ...result, importBatchId: batch.id });
  })
);

router.post(
  "/import-appointments/create-service-records",
  asyncHandler("Leistungsnachweise konnten nicht erstellt werden", async (req: Request, res: Response) => {
    const result = await createServiceRecordsForImported(req.user!.id);
    res.json(result);
  })
);

const reconcileSchema = z.object({
  customerId: z.number().int().positive(),
  apply: z.boolean().optional(),
});

router.post(
  "/import-appointments/reconcile-trimmed",
  asyncHandler("Reparatur konnte nicht ausgeführt werden", async (req: Request, res: Response) => {
    const { customerId, apply } = reconcileSchema.parse(req.body);
    const result = await reconcileCustomerStructured(
      customerId,
      apply === true,
      req.user!.id,
    );
    res.json(result);
  })
);

const excelKeySchema = z.object({
  customerId: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum muss YYYY-MM-DD sein"),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Startzeit muss HH:MM sein"),
});

const reconcilePreviewSchema = z.object({
  customerIds: z.array(z.number().int().positive()).min(1, "Mindestens ein Kunde erforderlich"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Startdatum muss YYYY-MM-DD sein"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enddatum muss YYYY-MM-DD sein"),
  excelKeys: z.array(excelKeySchema),
});

router.post(
  "/import-appointments/reconcile/preview",
  asyncHandler("Reconcile-Vorschau konnte nicht erstellt werden", async (req: Request, res: Response) => {
    const input = reconcilePreviewSchema.parse(req.body);
    if (input.startDate > input.endDate) {
      res.status(400).json({ error: "Startdatum darf nicht nach Enddatum liegen" });
      return;
    }
    const result = await previewReconcile(
      input.customerIds,
      input.startDate,
      input.endDate,
      input.excelKeys,
    );
    // Task #708: Server-trusted Snapshot mit Cutoff + zulässigen AppointmentIds.
    const excelCutoff = computeLastExcelMonth(input.excelKeys.map((k) => k.date));
    const allowedAppointmentIds = new Set<number>(
      result.cancellable.map((c) => c.appointmentId),
    );
    const previewToken = storeReconcilePreview(req.user!.id, {
      excelCutoff,
      allowedAppointmentIds,
      scopeCustomerIds: input.customerIds,
      scopeStartDate: input.startDate,
      scopeEndDate: input.endDate,
    });
    res.json({ ...result, previewToken });
  })
);

const reconcileExecuteSchema = z.object({
  appointmentIds: z.array(z.number().int().positive()).min(1, "Mindestens ein Termin erforderlich"),
  reason: z.string().min(10, "Begründung muss mindestens 10 Zeichen lang sein"),
  batchId: z.string().uuid("batchId muss eine gültige UUID sein").optional(),
  /**
   * Task #708: Pflicht-Token aus /reconcile/preview. Server-trusted Snapshot
   * liefert Cutoff, Scope und Whitelist erlaubter AppointmentIds.
   */
  previewToken: z.string().uuid("previewToken muss eine gültige UUID sein"),
});

router.post(
  "/import-appointments/reconcile/execute",
  asyncHandler("Reconcile-Stornierung konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
    const input = reconcileExecuteSchema.parse(req.body);

    const snapshot = loadReconcilePreview(input.previewToken, req.user!.id);
    if (!snapshot) {
      res.status(409).json({
        error:
          "Reconcile-Preview ist abgelaufen oder ungültig. Bitte Vorschau neu erstellen.",
      });
      return;
    }

    // Jede vom Client gesendete appointmentId muss Teil der zur Storno
    // freigegebenen Menge sein. Schützt davor, dass ein Client beliebige
    // andere Termin-IDs (z.B. aus anderen Scopes) reinschmuggelt.
    for (const id of input.appointmentIds) {
      if (!snapshot.allowedAppointmentIds.has(id)) {
        res.status(400).json({
          error: `AppointmentId ${id} ist nicht Teil des Preview-Snapshots.`,
        });
        return;
      }
    }

    const result = await executeReconcile({
      appointmentIds: input.appointmentIds,
      reason: input.reason,
      batchId: input.batchId,
      userId: req.user!.id,
      ipAddress: req.ip || req.socket.remoteAddress,
      scopeCustomerIds: snapshot.scopeCustomerIds,
      scopeStartDate: snapshot.scopeStartDate,
      scopeEndDate: snapshot.scopeEndDate,
      excelCutoff: snapshot.excelCutoff,
    });
    consumePreview(input.previewToken);
    res.json(result);
  })
);

router.get(
  "/import-batches",
  asyncHandler("Import-Protokoll konnte nicht geladen werden", async (_req: Request, res: Response) => {
    const batches = await importBatchesStorage.list();
    res.json(batches);
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
