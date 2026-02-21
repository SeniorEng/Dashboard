import { Router } from "express";
import { requireAdmin } from "../middleware/auth";
import employeesRouter from "./admin/employees";
import customersRouter from "./admin/customers";
import insuranceProvidersRouter from "./admin/insurance-providers";
import timeTrackingRouter from "./admin/time-tracking";
import pricingRouter from "./admin/pricing";
import documentsRouter from "./admin/documents";
import auditRouter from "./admin/audit";
import lexwareExportRouter from "./admin/lexware-export";
import documentDeliveryRouter from "./admin/document-delivery";

const router = Router();

router.use(requireAdmin);

router.use("/", employeesRouter);
router.use("/", customersRouter);
router.use("/", insuranceProvidersRouter);
router.use("/", timeTrackingRouter);
router.use("/", pricingRouter);
router.use("/", documentsRouter);
router.use("/", auditRouter);
router.use("/", lexwareExportRouter);
router.use("/", documentDeliveryRouter);

export default router;
