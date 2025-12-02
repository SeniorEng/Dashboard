import { Router } from "express";
import { storage } from "../storage";
import { updateAppointmentSchema, insertAppointmentSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const appointments = await storage.getAppointmentsWithCustomers();
    res.json(appointments);
  } catch (error) {
    console.error("Failed to fetch appointments:", error);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid appointment ID" });
    }
    
    const appointment = await storage.getAppointmentWithCustomer(id);
    
    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    
    res.json(appointment);
  } catch (error) {
    console.error("Failed to fetch appointment:", error);
    res.status(500).json({ error: "Failed to fetch appointment" });
  }
});

router.post("/", async (req, res) => {
  try {
    const validatedData = insertAppointmentSchema.parse(req.body);
    const appointment = await storage.createAppointment(validatedData);
    res.status(201).json(appointment);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ error: fromError(error).toString() });
    }
    console.error("Failed to create appointment:", error);
    res.status(500).json({ error: "Failed to create appointment" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid appointment ID" });
    }
    
    const validatedData = updateAppointmentSchema.parse(req.body);
    const appointment = await storage.updateAppointment(id, validatedData);
    
    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    
    res.json(appointment);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ error: fromError(error).toString() });
    }
    console.error("Failed to update appointment:", error);
    res.status(500).json({ error: "Failed to update appointment" });
  }
});

export default router;
