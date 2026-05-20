import { Router, Request, Response } from "express";
import { requireAdmin, requireAdminPermission, requireSuperAdmin } from "../middleware/auth";
import { adminPermissionStorage } from "../storage/admin-permissions";
import { asyncHandler } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { ADMIN_PERMISSION_KEYS, type AdminPermissionKey } from "@shared/schema";
import { z } from "zod";
import employeesRouter from "./admin/employees";
import customersRouter from "./admin/customers";
import insuranceProvidersRouter from "./admin/insurance-providers";
import timeTrackingRouter from "./admin/time-tracking";
import documentsRouter from "./admin/documents";
import auditRouter from "./admin/audit";
import lexwareExportRouter from "./admin/lexware-export";
import documentDeliveryRouter from "./admin/document-delivery";
import prospectsRouter from "./admin/prospects";
import qontoRouter from "./admin/qonto";
import whatsappRouter from "./admin/whatsapp";
import importAppointmentsRouter from "./admin/import-appointments";
import contactMigrationRouter from "./admin/contact-migration";
import testCleanupRouter from "./admin/test-cleanup";
import { initiateTestCall } from "../services/twilio-call-bridge";
import { persistInvoicePdf } from "./billing";
import { storage } from "../storage";
import { auditService } from "../services/audit";
import { notFound } from "../lib/errors";

const router = Router();

router.use(requireAdmin);

router.get("/my-permissions", asyncHandler("Berechtigungen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const user = req.user!;
  if (user.isSuperAdmin) {
    res.json({ permissions: [...ADMIN_PERMISSION_KEYS], isSuperAdmin: true });
    return;
  }
  const permissions = await adminPermissionStorage.getPermissions(user.id);
  res.json({ permissions, isSuperAdmin: false });
}));

router.get("/users/:id/permissions", requireSuperAdmin, asyncHandler("Berechtigungen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const userId = requireIntParam(req.params.id, res);
  if (userId === null) return;
  const permissions = await adminPermissionStorage.getPermissions(userId);
  res.json({ permissions });
}));

const setPermissionsSchema = z.object({
  permissions: z.array(z.enum(ADMIN_PERMISSION_KEYS as unknown as [string, ...string[]])),
});

router.put("/users/:id/permissions", requireSuperAdmin, asyncHandler("Berechtigungen konnten nicht gespeichert werden", async (req: Request, res: Response) => {
  const userId = requireIntParam(req.params.id, res);
  if (userId === null) return;
  const data = setPermissionsSchema.parse(req.body);
  await adminPermissionStorage.setPermissions(userId, data.permissions as AdminPermissionKey[]);
  res.json({ success: true, permissions: data.permissions });
}));

const ROUTE_PERMISSION_MAP: Record<string, AdminPermissionKey> = {
  "/users": "users",
  "/employees": "users",
  "/time-entries": "time_entries",
  "/employee-appointments": "time_entries",
  "/birthday-cards": "birthday_cards",
  "/statistics": "statistics",
  "/prospects": "prospects",
  "/customers": "customers",
  "/insurance-providers": "insurance_providers",
  "/documents": "documents",
  "/document-types": "documents",
  "/document-templates": "documents",
  "/services": "services",
  "/service-rates": "services",
  "/billing": "billing",
  "/invoices": "billing",
  "/hours-overview": "hours_overview",
  "/settings": "settings",
  "/company-settings": "settings",
  "/audit-log": "audit_log",
  "/verify-signature": "audit_log",
  "/revoke-signature": "audit_log",
  "/lexware-export": "billing",
  "/document-delivery": "documents",
  "/whatsapp": "whatsapp",
  "/budget": "customers",
};

const READ_PERMISSION_FALLBACKS: Partial<Record<AdminPermissionKey, AdminPermissionKey[]>> = {
  insurance_providers: ["customers"],
  services: ["customers", "billing"],
  documents: ["customers"],
};

router.use(async (req: Request, res: Response, next) => {
  const user = req.user!;
  if (user.isSuperAdmin) {
    next();
    return;
  }

  if (req.path === "/my-permissions" || req.path.match(/^\/users\/\d+\/permissions$/)) {
    next();
    return;
  }

  const pathSegment = "/" + (req.path.split("/")[1] || "");
  const permissionKey = ROUTE_PERMISSION_MAP[pathSegment];

  if (permissionKey) {
    const hasPermission = await adminPermissionStorage.hasPermission(user.id, permissionKey);
    if (!hasPermission) {
      if (req.method === "GET") {
        const fallbacks = READ_PERMISSION_FALLBACKS[permissionKey];
        if (fallbacks) {
          const permissions = await adminPermissionStorage.getPermissions(user.id);
          const hasFallback = fallbacks.some(fb => permissions.includes(fb));
          if (hasFallback) {
            next();
            return;
          }
        }
      }
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Sie haben keine Berechtigung für diesen Bereich",
      });
      return;
    }
  }

  next();
});

if (process.env.NODE_ENV !== "production") {
  router.use("/", testCleanupRouter);
}

router.use("/qonto", qontoRouter);
router.use("/whatsapp", whatsappRouter);
router.use("/", employeesRouter);
router.use("/", customersRouter);
router.use("/", insuranceProvidersRouter);
router.use("/", timeTrackingRouter);
router.use("/", documentsRouter);
router.use("/", auditRouter);
router.use("/", lexwareExportRouter);
router.use("/", documentDeliveryRouter);
router.use("/", prospectsRouter);
router.use("/", importAppointmentsRouter);
router.use("/", contactMigrationRouter);

router.post("/twilio/test-call", requireSuperAdmin, asyncHandler("Testanruf fehlgeschlagen", async (_req: Request, res: Response) => {
  const result = await initiateTestCall();
  res.json(result);
}));

// Task #532: Manueller Trigger zum Nachholen fehlender Rechnungs-PDFs
// (Rechnung + ggf. Leistungsnachweis). Letzte Rettung, wenn der automatische
// Backfill in Prod eine Rechnung nicht erwischt hat (z.B. wegen wiederholtem
// Puppeteer-Fehler). Nur für Superadmins.
//
// WICHTIG (GoBD): Bereits persistierte PDFs werden NICHT überschrieben —
// `persistInvoicePdf` ist immutabel. Der Endpoint persistiert ausschließlich
// fehlende Pfade. Wenn schon alles da ist, antwortet er mit
// `regenerated: false` und schreibt KEINEN Audit-Eintrag.
router.post(
  "/billing/:id/regenerate-pdf",
  requireSuperAdmin,
  asyncHandler(
    "PDF konnte nicht erzeugt werden — bitte erneut versuchen oder den Support kontaktieren.",
    async (req: Request, res: Response) => {
      const id = requireIntParam(req.params.id, res);
      if (id === null) return;
      const invoice = await storage.getInvoice(id);
      if (!invoice) throw notFound("Rechnung nicht gefunden");

      const before = {
        pdfPath: invoice.pdfPath,
        leistungsnachweisPath: invoice.leistungsnachweisPath,
      };
      await persistInvoicePdf(id);
      const refreshed = await storage.getInvoice(id);
      const after = {
        pdfPath: refreshed?.pdfPath ?? null,
        leistungsnachweisPath: refreshed?.leistungsnachweisPath ?? null,
      };

      const regenerated =
        before.pdfPath !== after.pdfPath ||
        before.leistungsnachweisPath !== after.leistungsnachweisPath;

      if (regenerated) {
        await auditService.log(
          req.user!.id,
          "invoice_pdf_manually_regenerated",
          "invoice",
          id,
          {
            invoiceNumber: invoice.invoiceNumber,
            before,
            after,
          },
          req.ip,
        );
      }

      res.json({
        success: true,
        invoiceNumber: invoice.invoiceNumber,
        regenerated,
        pdfPath: after.pdfPath,
        leistungsnachweisPath: after.leistungsnachweisPath,
        message: regenerated
          ? "PDFs wurden nacherzeugt und im Speicher abgelegt."
          : "Es waren bereits alle PDFs vorhanden — nichts zu tun.",
      });
    },
  ),
);

export default router;
