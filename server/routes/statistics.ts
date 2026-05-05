import { Router } from "express";
import { requireAuth } from "../middleware/auth";

import v2Router from "./statistics/v2";

const router = Router();
router.use(requireAuth);

router.use("/v2", v2Router);

export default router;
