import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../server/lib/db";
import { services } from "@shared/schema";
import { serviceCatalogStorage } from "../server/storage/service-catalog";
import { SERVICE_CATALOG_CODES } from "@shared/config/services";

/**
 * Phase 3.4: `shared/config/services.ts` ist die EINZIGE Quelle. Diese Suite
 * prüft die DB-seitige Durchsetzung (braucht eine echte DB → integration):
 *  - der Startup-Sync ERKENNT eine Konfig↔DB-Abweichung und wirft (Startfehler),
 *  - und unabhängig davon werden Nicht-Konfig-Services NIE über die Katalog-
 *    Leselisten ausgeliefert (Junk-Services sind by construction unmöglich).
 */
const JUNK_CODE = "__junk_not_in_catalog__";

async function deleteJunk(): Promise<void> {
  await db.delete(services).where(eq(services.code, JUNK_CODE));
}

async function insertJunk(): Promise<void> {
  await db.insert(services).values({
    code: JUNK_CODE,
    name: "Junk Service (Test)",
    unitType: "hours",
    defaultPriceCents: 100,
    vatRate: 19,
    isActive: true,
  });
}

describe("Service-Katalog-Sync (Konfig = SSoT)", () => {
  afterEach(deleteJunk);

  it("syncServiceCatalog wirft bei einem DB-Service, der nicht in der Konfig steht", async () => {
    await deleteJunk();
    await insertJunk();
    await expect(serviceCatalogStorage.syncServiceCatalog()).rejects.toThrow(
      /Service-Katalog-Abweichung/,
    );
  });

  it("Katalog-Leselisten liefern NIE einen Nicht-Konfig-Service aus", async () => {
    await deleteJunk();
    await insertJunk();
    const active = await serviceCatalogStorage.getAllServices(false);
    const all = await serviceCatalogStorage.getAllServices(true);

    expect(active.some((s) => s.code === JUNK_CODE)).toBe(false);
    expect(all.some((s) => s.code === JUNK_CODE)).toBe(false);

    // Jeder ausgelieferte Service ist ein Konfig-Service.
    const allowed = new Set(SERVICE_CATALOG_CODES);
    for (const s of all) {
      expect(s.code !== null && allowed.has(s.code)).toBe(true);
    }
  });
});
