import { Router } from "express";
import appointmentsRouter from "./appointments";
import customersRouter from "./customers";
import authRouter from "./auth";
import adminRouter from "./admin";
import timeEntriesRouter from "./time-entries";

const router = Router();

router.use("/auth", authRouter);
router.use("/admin", adminRouter);
router.use("/appointments", appointmentsRouter);
router.use("/customers", customersRouter);
router.use("/time-entries", timeEntriesRouter);

export default router;
