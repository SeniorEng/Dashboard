import { describe, expect, it } from "vitest";
import { db } from "../../server/lib/db";
import { appointments } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { chronologischeReihenfolge } from "../../server/storage/budget/abrechnungs-lauf";

/**
 * Die Reihenfolge eines Abrechnungs-Laufs — die eine Sache, die Vorschau
 * (Probelauf) und Erstellen teilen müssen und die die Buchungs-Engine nicht
 * kennt. Die Fenster je Topf setzt die Engine selbst um; seit die Vorschau
 * die echte Neubuchung fährt, gibt es dafür keine eigene Nachbildung mehr.
 *
 * Gemessen (Gegenprobe M4 in #193): in falscher Reihenfolge bekommt die Kasse
 * MEHR, als im Topf ist — ein früh datierter Termin sieht die Buchung eines
 * später datierten nicht.
 */
describe("Abrechnungs-Lauf — Reihenfolge", () => {
  it("AL-1 – nach Datum, dann Uhrzeit, dann ID — unabhängig von der Anlage-Reihenfolge", async () => {
    await getAuthCookie();
    const id = (await createTestCustomer({
      pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
    })).id as number;
    try {
      // Absichtlich NICHT chronologisch angelegt: die IDs steigen gegen den Kalender.
      const anlage: Array<[string, string]> = [
        ["2026-06-17", "09:00"],
        ["2026-06-03", "14:00"],
        ["2026-06-03", "08:00"],
        ["2026-06-10", "09:00"],
      ];
      const ids: Record<string, number> = {};
      for (const [datum, zeit] of anlage) {
        const [t] = await db.insert(appointments).values({
          customerId: id, date: datum, scheduledStart: zeit, durationPromised: 60,
          status: "completed", appointmentType: "Betreuung",
        } as never).returning({ id: appointments.id });
        ids[`${datum} ${zeit}`] = t.id;
      }
      const reihenfolge = await chronologischeReihenfolge(Object.values(ids));
      expect(reihenfolge, "der Lauf bucht nicht in Kalender-Reihenfolge").toEqual([
        ids["2026-06-03 08:00"],
        ids["2026-06-03 14:00"],
        ids["2026-06-10 09:00"],
        ids["2026-06-17 09:00"],
      ]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
});
