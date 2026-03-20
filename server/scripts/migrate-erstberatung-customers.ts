import { db } from "../lib/db";
import { customers, prospects, appointments } from "@shared/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

async function migrateErstberatungCustomers() {
  console.log("[migration] Starting erstberatung customer migration...");

  const erstberatungCustomers = await db
    .select()
    .from(customers)
    .where(and(eq(customers.status, "erstberatung"), isNull(customers.deletedAt)));

  console.log(`[migration] Found ${erstberatungCustomers.length} erstberatung customers to migrate`);

  if (erstberatungCustomers.length === 0) {
    console.log("[migration] No erstberatung customers found. Nothing to do.");
    return;
  }

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const customer of erstberatungCustomers) {
    try {
      const linkedProspects = await db
        .select()
        .from(prospects)
        .where(and(
          eq(prospects.convertedCustomerId, customer.id),
          isNull(prospects.deletedAt),
        ));

      if (linkedProspects.length === 0) {
        console.warn(`[migration] WARNING: Customer ${customer.id} (${customer.name}) has no linked prospect. Skipping.`);
        skipped++;
        continue;
      }

      const prospect = linkedProspects[0];

      await db.transaction(async (tx) => {
        await tx.update(appointments)
          .set({
            prospectId: prospect.id,
            customerId: null,
          })
          .where(and(
            eq(appointments.customerId, customer.id),
            isNull(appointments.deletedAt),
          ));

        await tx.update(prospects)
          .set({
            status: "erstberatung_durchgeführt",
            convertedCustomerId: null,
            updatedAt: new Date(),
          })
          .where(eq(prospects.id, prospect.id));

        await tx.update(customers)
          .set({
            deletedAt: new Date(),
            status: "inaktiv",
          })
          .where(eq(customers.id, customer.id));
      });

      migrated++;
      console.log(`[migration] Migrated customer ${customer.id} (${customer.name}) → prospect ${prospect.id}`);
    } catch (err) {
      errors++;
      console.error(`[migration] ERROR migrating customer ${customer.id} (${customer.name}):`, err);
    }
  }

  console.log(`[migration] Complete: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
}

migrateErstberatungCustomers()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[migration] Fatal error:", err);
    process.exit(1);
  });
