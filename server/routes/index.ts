import { Router } from "express";
import appointmentsRouter from "./appointments";
import customersRouter from "./customers";
import authRouter from "./auth";
import adminRouter from "./admin";
import timeEntriesRouter from "./time-entries";
import birthdaysRouter from "./birthdays";
import budgetRouter from "./budget";
import tasksRouter from "./tasks";
import serviceRecordsRouter from "./service-records";
import servicesRouter from "./services";
import { searchRouter } from "./search";
import settingsRouter from "./settings";
import profileRouter from "./profile";
import { csrfProtection, csrfTokenHandler } from "../middleware/csrf";
import { authMiddleware } from "../middleware/auth";
import { cacheHeaders } from "../middleware/cache-headers";

const router = Router();

router.use(authMiddleware);
router.use(cacheHeaders);

router.get("/csrf-token", csrfTokenHandler);

router.use("/auth", authRouter);

router.use(csrfProtection);

router.use("/admin", adminRouter);

router.use("/appointments", appointmentsRouter);
router.use("/customers", customersRouter);
router.use("/time-entries", timeEntriesRouter);
router.use("/birthdays", birthdaysRouter);
router.use("/budget", budgetRouter);
router.use("/tasks", tasksRouter);
router.use("/service-records", serviceRecordsRouter);
router.use("/services", servicesRouter);
router.use("/search", searchRouter);
router.use("/settings", settingsRouter);
router.use("/profile", profileRouter);

export default router;
