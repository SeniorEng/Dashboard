import { Router } from "express";
import appointmentsRouter from "./appointments";
import customersRouter from "./customers";

const router = Router();

router.use("/appointments", appointmentsRouter);
router.use("/customers", customersRouter);

export default router;
