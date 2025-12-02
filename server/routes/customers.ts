import { Router } from "express";
import { storage } from "../storage";
import { insertCustomerSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const customers = await storage.getCustomers();
    res.json(customers);
  } catch (error) {
    console.error("Failed to fetch customers:", error);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid customer ID" });
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
