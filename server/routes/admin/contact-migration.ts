import { Router } from "express";
import { requireSuperAdmin } from "../../middleware/auth";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { db } from "../../lib/db";
import { customerContacts, customers } from "@shared/schema";
import { LEGACY_CONTACT_TYPES, CONTACT_TYPE_SELECT_OPTIONS } from "@shared/domain/customers";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

const router = Router();

const validNewTypes = new Set<string>(CONTACT_TYPE_SELECT_OPTIONS.map((o) => o.value));

const migrateSchema = z.object({
  contactType: z.string().refine((v) => validNewTypes.has(v), {
    message: "Ungültiger neuer Kontakttyp",
  }),
});

router.get("/contact-migration/legacy", requireSuperAdmin, asyncHandler("Legacy-Kontakte konnten nicht geladen werden", async (_req, res) => {
  const rows = await db
    .select({
      id: customerContacts.id,
      customerId: customerContacts.customerId,
      customerName: customers.name,
      vorname: customerContacts.vorname,
      nachname: customerContacts.nachname,
      contactType: customerContacts.contactType,
      telefon: customerContacts.telefon,
      isPrimary: customerContacts.isPrimary,
      isActive: customerContacts.isActive,
    })
    .from(customerContacts)
    .innerJoin(customers, eq(customerContacts.customerId, customers.id))
    .where(
      inArray(customerContacts.contactType, [...LEGACY_CONTACT_TYPES])
    )
    .orderBy(customers.name, customerContacts.vorname);

  res.json(rows);
}));

router.patch("/contact-migration/:id", requireSuperAdmin, asyncHandler("Kontakttyp konnte nicht migriert werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const result = migrateSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: result.error.issues[0]?.message ?? "Ungültige Daten" });
    return;
  }

  const updated = await db
    .update(customerContacts)
    .set({ contactType: result.data.contactType, updatedAt: new Date() })
    .where(eq(customerContacts.id, id))
    .returning();

  if (updated.length === 0) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" });
    return;
  }

  res.json(updated[0]);
}));

export default router;
