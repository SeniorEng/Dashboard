import { Router, Request, Response } from "express";
import { requireAdmin, requireAdminPermission, requireSuperAdmin } from "../middleware/auth";
import { adminPermissionStorage } from "../storage/admin-permissions";
import { asyncHandler } from "../lib/errors";
import { ADMIN_PERMISSION_KEYS, type AdminPermissionKey } from "@shared/schema";
import { z } from "zod";
import employeesRouter from "./admin/employees";
import customersRouter from "./admin/customers";
import insuranceProvidersRouter from "./admin/insurance-providers";
import timeTrackingRouter from "./admin/time-tracking";
import pricingRouter from "./admin/pricing";
import documentsRouter from "./admin/documents";
import auditRouter from "./admin/audit";
import lexwareExportRouter from "./admin/lexware-export";
import documentDeliveryRouter from "./admin/document-delivery";
import qualificationsRouter from "./admin/qualifications";
import prospectsRouter from "./admin/prospects";

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
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Benutzer-ID" });
    return;
  }
  const permissions = await adminPermissionStorage.getPermissions(userId);
  res.json({ permissions });
}));

const setPermissionsSchema = z.object({
  permissions: z.array(z.enum(ADMIN_PERMISSION_KEYS as unknown as [string, ...string[]])),
});

router.put("/users/:id/permissions", requireSuperAdmin, asyncHandler("Berechtigungen konnten nicht gespeichert werden", async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Benutzer-ID" });
    return;
  }
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
  "/qualifications": "users",
  "/lexware-export": "billing",
  "/document-delivery": "documents",
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
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Sie haben keine Berechtigung für diesen Bereich",
      });
      return;
    }
  }

  next();
});

router.use("/", employeesRouter);
router.use("/", customersRouter);
router.use("/", insuranceProvidersRouter);
router.use("/", timeTrackingRouter);
router.use("/", pricingRouter);
router.use("/", documentsRouter);
router.use("/", auditRouter);
router.use("/", lexwareExportRouter);
router.use("/", documentDeliveryRouter);
router.use("/qualifications", qualificationsRouter);
router.use("/", prospectsRouter);

export default router;
