import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/errors";
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
} from "../storage/notifications";

const router = Router();

router.get("/", requireAuth, asyncHandler("Benachrichtigungen konnten nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const limit = parseInt(req.query.limit as string) || 50;
  const result = await getNotifications(userId, Math.min(limit, 100));
  res.json(result);
}));

router.get("/unread-count", requireAuth, asyncHandler("Ungelesene Anzahl konnte nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const count = await getUnreadCount(userId);
  res.json({ count });
}));

router.patch("/:id/read", requireAuth, asyncHandler("Benachrichtigung konnte nicht als gelesen markiert werden", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: "Ungültige ID" });
  }
  const userId = req.user!.id;
  await markAsRead(id, userId);
  res.json({ success: true });
}));

router.post("/mark-all-read", requireAuth, asyncHandler("Benachrichtigungen konnten nicht als gelesen markiert werden", async (req, res) => {
  const userId = req.user!.id;
  await markAllAsRead(userId);
  res.json({ success: true });
}));

export default router;
