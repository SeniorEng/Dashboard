import { Router } from "express";
import { insertTaskSchema, updateTaskSchema, birthdayCardTracking } from "@shared/schema";
import { 
  getTasksForUser, 
  getAllTasks, 
  getTaskById, 
  createTask, 
  updateTask, 
  deleteTask,
  getOpenTaskCount,
  ensureMonthClosingTask,
  parseBirthdayMarker,
  completeAllBirthdayTasks,
  reopenAllBirthdayTasks,
} from "../storage/tasks";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { storage } from "../storage";
import { timeTrackingStorage } from "../storage/time-tracking";
import { todayISO } from "@shared/utils/datetime";
import { asyncHandler } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { notificationService } from "../services/notification-service";
import { db } from "../lib/db";
import { and, eq } from "drizzle-orm";

const router = Router();

router.get("/", requireAuth, asyncHandler("Aufgaben konnten nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const isAdmin = req.user!.isAdmin;
  const includeCompleted = req.query.includeCompleted === "true";
  const all = req.query.all === "true";

  let tasks;
  if (isAdmin && all) {
    tasks = await getAllTasks(includeCompleted);
  } else {
    tasks = await getTasksForUser(userId, includeCompleted);
  }

  res.json(tasks);
}));

router.get("/count", requireAuth, asyncHandler("Aufgabenanzahl konnte nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const count = await getOpenTaskCount(userId);
  res.json({ count });
}));

router.get("/badge-count", requireAuth, asyncHandler("Badge-Anzahl konnte nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const isAdmin = req.user!.isAdmin;

  const today = todayISO();
  const customerIds = isAdmin ? undefined : await storage.getAssignedCustomerIds(userId);

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;

  const [userTaskCount, undocumentedAppts, openTasks, pendingRecords, monthClosing] = await Promise.all([
    getOpenTaskCount(userId),
    (customerIds && customerIds.length === 0) ? Promise.resolve(0) : storage.getUndocumentedAppointments(today, customerIds).then(a => a.length),
    timeTrackingStorage.getOpenTasks(userId).then(t => t.daysWithMissingBreaks?.length || 0),
    storage.getPendingServiceRecords(userId).then(r => r.length),
    timeTrackingStorage.getMonthClosing(userId, prevYear, prevMonth),
  ]);

  const monthClosingNeeded = !monthClosing || !!monthClosing.reopenedAt ? 1 : 0;
  const count = userTaskCount + undocumentedAppts + openTasks + pendingRecords + monthClosingNeeded;
  res.json({ count });
}));

router.get("/month-closing-reminder", requireAuth, asyncHandler("Monatsabschluss-Erinnerung konnte nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;

  const closing = await timeTrackingStorage.getMonthClosing(userId, prevYear, prevMonth);
  const isClosed = closing && !closing.reopenedAt;

  if (isClosed) {
    return res.json({ needed: false });
  }

  const task = await ensureMonthClosingTask(userId, prevMonth, prevYear);

  const monthNames = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ];

  res.json({
    needed: true,
    month: prevMonth,
    year: prevYear,
    monthName: monthNames[prevMonth - 1],
    taskId: task.id,
  });
}));

router.get("/:id", requireAuth, asyncHandler("Aufgabe konnte nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const task = await getTaskById(id);
  if (!task) {
    return res.status(404).json({ error: "Aufgabe nicht gefunden" });
  }

  const userId = req.user!.id;
  const isAdmin = req.user!.isAdmin;
  if (!isAdmin && task.assignedToUserId !== userId && task.createdByUserId !== userId) {
    return res.status(403).json({ error: "Keine Berechtigung" });
  }

  res.json(task);
}));

router.post("/", requireAuth, asyncHandler("Aufgabe konnte nicht erstellt werden", async (req, res) => {
  const parseResult = insertTaskSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ 
      error: "Validierungsfehler", 
      details: parseResult.error.errors 
    });
  }

  const data = parseResult.data;
  const userId = req.user!.id;
  const isAdmin = req.user!.isAdmin;

  if (!isAdmin && data.assignedToUserId && data.assignedToUserId !== userId) {
    return res.status(403).json({ 
      error: "Nur Admins können Aufgaben anderen zuweisen" 
    });
  }

  const task = await createTask(data, userId);

  const assignedTo = data.assignedToUserId || userId;
  if (assignedTo !== userId) {
    const { authService: authSvc } = await import("../services/auth");
    const creator = await authSvc.getUser(userId);
    const creatorName = creator?.displayName || "Jemand";
    notificationService.notifyTaskAssigned(task.id, data.title, assignedTo, creatorName);
  }

  res.status(201).json(task);
}));

router.patch("/:id", requireAuth, asyncHandler("Aufgabe konnte nicht aktualisiert werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const parseResult = updateTaskSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ 
      error: "Validierungsfehler", 
      details: parseResult.error.errors 
    });
  }

  const userId = req.user!.id;
  const isAdmin = req.user!.isAdmin;

  try {
    const task = await updateTask(id, parseResult.data, userId, isAdmin);
    if (!task) {
      return res.status(404).json({ error: "Aufgabe nicht gefunden" });
    }

    if (parseResult.data.status && isAdmin) {
      const marker = parseBirthdayMarker(task.description);
      if (marker) {
        const { personType, personId, year } = marker;
        await db.transaction(async (tx) => {
          if (parseResult.data.status === "completed") {
            const existing = await tx.select().from(birthdayCardTracking)
              .where(and(
                eq(birthdayCardTracking.personType, personType),
                eq(birthdayCardTracking.personId, personId),
                eq(birthdayCardTracking.year, year),
              ));

            if (existing.length > 0) {
              await tx.update(birthdayCardTracking)
                .set({ sent: true, sentAt: new Date(), sentByUserId: userId })
                .where(eq(birthdayCardTracking.id, existing[0].id));
            } else {
              await tx.insert(birthdayCardTracking)
                .values({ personType, personId, year, sent: true, sentAt: new Date(), sentByUserId: userId });
            }
            await completeAllBirthdayTasks(personType, personId, year, tx);
          } else {
            const existing = await tx.select().from(birthdayCardTracking)
              .where(and(
                eq(birthdayCardTracking.personType, personType),
                eq(birthdayCardTracking.personId, personId),
                eq(birthdayCardTracking.year, year),
              ));

            if (existing.length > 0 && existing[0].sent) {
              await tx.update(birthdayCardTracking)
                .set({ sent: false, sentAt: null, sentByUserId: null })
                .where(eq(birthdayCardTracking.id, existing[0].id));
            }
            await reopenAllBirthdayTasks(personType, personId, year, tx);
          }
        });
      }
    }

    res.json(task);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Berechtigung")) {
      return res.status(403).json({ error: error.message });
    }
    throw error;
  }
}));

router.delete("/:id", requireAuth, asyncHandler("Aufgabe konnte nicht gelöscht werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const userId = req.user!.id;
  const isAdmin = req.user!.isAdmin;

  try {
    const deleted = await deleteTask(id, userId, isAdmin);
    if (!deleted) {
      return res.status(404).json({ error: "Aufgabe nicht gefunden" });
    }

    res.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Berechtigung")) {
      return res.status(403).json({ error: error.message });
    }
    throw error;
  }
}));

export default router;
