import { Router } from "express";
import appointmentsRouter from "./appointments";
import customersRouter from "./customers";
import authRouter from "./auth";
import adminRouter from "./admin";

const router = Router();

router.use("/auth", authRouter);
router.use("/admin", adminRouter);
router.use("/appointments", appointmentsRouter);
router.use("/customers", customersRouter);

export default router;
