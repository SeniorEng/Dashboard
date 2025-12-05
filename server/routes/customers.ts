import { Router } from "express";
import { storage } from "../storage";
import { insertCustomerSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const user = req.user!;
    
    if (user.isAdmin) {
      const customers = await storage.getCustomers();
      return res.json(customers);
    }
    
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    const customers = await storage.getCustomersByIds(assignedCustomerIds);
    
    res.json(customers);
  } catch (error) {
    console.error("Failed to fetch customers:", error);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const user = req.user!;
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    if (!user.isAdmin) {
      const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
      if (!assignedCustomerIds.includes(id)) {
        return res.status(403).json({ error: "Access denied" });
      }
    }
    
    const customer = await storage.getCustomer(id);
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    res.json(customer);
  } catch (error) {
    console.error("Failed to fetch customer:", error);
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

router.post("/", async (req, res) => {
  try {
    const validatedData = insertCustomerSchema.parse(req.body);
    const customer = await storage.createCustomer(validatedData);
    res.status(201).json(customer);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ error: fromError(error).toString() });
    }
    console.error("Failed to create customer:", error);
    res.status(500).json({ error: "Failed to create customer" });
  }
});

export default router;
