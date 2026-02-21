import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { getHolidays } from "@shared/utils/holidays";

const router = Router();

router.get("/", requireAuth, (req: Request, res: Response) => {
  const year = parseInt(req.query.year as string);
  if (isNaN(year) || year < 2000 || year > 2100) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültiges Jahr" });
    return;
  }
  res.json(getHolidays(year));
});

export default router;
