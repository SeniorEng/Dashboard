import { Router } from "express";
import { insertTaskSchema, updateTaskSchema } from "@shared/schema";
import { 
  getTasksForUser, 
  getAllTasks, 
  getTaskById, 
  createTask, 
  updateTask, 
  deleteTask,
  getOpenTaskCount 
} from "../storage/tasks";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { storage } from "../storage";
import { timeTrackingStorage } from "../storage/time-tracking";
import { todayISO } from "@shared/utils/datetime";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
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
  } catch (error) {
    console.error("Error fetching tasks:", error);
    res.status(500).json({ error: "Aufgaben konnten nicht geladen werden" });
  }
});

router.get("/count", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const count = await getOpenTaskCount(userId);
    res.json({ count });
  } catch (error) {
    console.error("Error fetching task count:", error);
    res.status(500).json({ error: "Aufgabenanzahl konnte nicht geladen werden" });
  }
});

router.get("/badge-count", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.isAdmin;

    const today = todayISO();
    const customerIds = isAdmin ? undefined : await storage.getAssignedCustomerIds(userId);

    const [userTaskCount, undocumentedAppts, openTasks, pendingRecords] = await Promise.all([
      getOpenTaskCount(userId),
      storage.getUndocumentedAppointments(today, customerIds).then(a => a.length),
      timeTrackingStorage.getOpenTasks(userId).then(t => t.daysWithMissingBreaks?.length || 0),
      storage.getPendingServiceRecords(userId).then(r => r.length),
    ]);

    const count = userTaskCount + undocumentedAppts + openTasks + pendingRecords;
    res.json({ count });
  } catch (error) {
    console.error("Error fetching badge count:", error);
    res.status(500).json({ error: "Badge-Anzahl konnte nicht geladen werden" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Ungültige Aufgaben-ID" });
    }

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
  } catch (error) {
    console.error("Error fetching task:", error);
    res.status(500).json({ error: "Aufgabe konnte nicht geladen werden" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
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
    res.status(201).json(task);
  } catch (error) {
    console.error("Error creating task:", error);
    res.status(500).json({ error: "Aufgabe konnte nicht erstellt werden" });
  }
});

router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Ungültige Aufgaben-ID" });
    }

    const parseResult = updateTaskSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ 
        error: "Validierungsfehler", 
        details: parseResult.error.errors 
      });
    }

    const userId = req.user!.id;
    const isAdmin = req.user!.isAdmin;

    const task = await updateTask(id, parseResult.data, userId, isAdmin);
    if (!task) {
      return res.status(404).json({ error: "Aufgabe nicht gefunden" });
    }

    res.json(task);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Berechtigung")) {
      return res.status(403).json({ error: error.message });
    }
    console.error("Error updating task:", error);
    res.status(500).json({ error: "Aufgabe konnte nicht aktualisiert werden" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Ungültige Aufgaben-ID" });
    }

    const userId = req.user!.id;
    const isAdmin = req.user!.isAdmin;

    const deleted = await deleteTask(id, userId, isAdmin);
    if (!deleted) {
      return res.status(404).json({ error: "Aufgabe nicht gefunden" });
    }

    res.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Berechtigung")) {
      return res.status(403).json({ error: error.message });
    }
    console.error("Error deleting task:", error);
    res.status(500).json({ error: "Aufgabe konnte nicht gelöscht werden" });
  }
});

export default router;
