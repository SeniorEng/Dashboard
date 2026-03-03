import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler, badRequest } from "../lib/errors";
import { getHolidays } from "@shared/utils/holidays";

const router = Router();

router.get("/", requireAuth, asyncHandler("Feiertage konnten nicht geladen werden", async (req, res) => {
  const year = parseInt(req.query.year as string);
  if (isNaN(year) || year < 2000 || year > 2100) {
    throw badRequest("Ungültiges Jahr");
  }
  res.json(getHolidays(year));
}));

export default router;
