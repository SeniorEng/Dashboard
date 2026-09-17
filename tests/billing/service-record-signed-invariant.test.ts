import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { monthlyServiceRecords } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, createTestEmployee, deactivateTestEmployee } from "../test-utils";
import {
  SERVICE_RECORD_SIGNED_CHECK_NAME,
  ensureServiceRecordSignedInvariant,
} from "../../server/startup/ensure-service-record-signed-invariant";

/**
 * Invariante `status = 'completed'` ⇒ `customer_signed_at IS NOT NULL`
 * (Ticket 6hWgf8W5hRq8W99G).
 *
 * ── Warum ein Verhaltens- und kein Quelltext-Test ────────────────────
 * Die Aussage ist nicht „im Code steht ein CHECK", sondern „die Datenbank
 * lässt diesen Zustand nicht zu". Das ist nur an der laufenden DB
 * prüfbar — ein Quelltext-Wächter würde die Constraint bestätigen und
 * nichts darüber sagen, ob sie greift.
 *
 * Der Unterschied ist nicht akademisch: `NOT VALID` wird regelmäßig als
 * „inaktiv" missverstanden. SI-2 und SI-3 zeigen, dass Postgres die
 * Bedingung sehr wohl bei jedem INSERT und jedem UPDATE prüft — es
 * unterlässt nur den einmaligen Vollscan über den Bestand.
 *
 * ── Warum die Invariante und nicht der Import-Pfad geprüft wird ──────
 * Erzeugt hat die 42 Bestandszeilen der Altdaten-Import. Ihn zu
 * reparieren schlösse die Klasse nicht: `updateServiceRecord(id, data)`
 * ist ein generischer Setter auf `IStorage`, und dass der Zustand heute
 * nur aus einem Pfad kommt, ist eine Eigenschaft der heutigen Aufrufer.
 * SI-4 prüft deshalb ausdrücklich den generischen Weg.
 */

const JAHR = 2026;
const MONAT = 5;

describe("Leistungsnachweis — Invariante `completed` verlangt Kundenunterschrift", () => {
  it("SI-1 – die Constraint existiert und ist NOT VALID", async () => {
    // Idempotenz gleich mitgeprüft: der Startup-Schritt läuft bei jedem
    // Boot, er darf beim zweiten Mal nicht scheitern.
    await ensureServiceRecordSignedInvariant();
    await ensureServiceRecordSignedInvariant();

    const r = await db.execute(sql`
      SELECT convalidated FROM pg_constraint
      WHERE conname = ${SERVICE_RECORD_SIGNED_CHECK_NAME}
        AND conrelid = 'monthly_service_records'::regclass
    `);
    expect(r.rows.length, "die Constraint muss angelegt sein").toBe(1);
    expect(
      (r.rows[0] as Record<string, unknown>).convalidated,
      "NOT VALID — der Altbestand (42 Zeilen aus dem Import) bleibt unberührt",
    ).toBe(false);
  });

  it("SI-2 – ein INSERT mit `completed` ohne Zeitstempel wird abgelehnt", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "SI2" });
    try {
      await expect(
        db.insert(monthlyServiceRecords).values({
          customerId: c.id as number, employeeId: emp.id,
          year: JAHR, month: MONAT, status: "completed",
          employeeSignedAt: new Date(),
          customerSignedAt: null,
        }),
        "genau der Zustand, den der Altdaten-Import erzeugt hat",
      ).rejects.toThrow();
    } finally {
      await cleanupCustomer(c.id as number);
      await deactivateTestEmployee(emp.id);
    }
  });

  it("SI-3 – ein UPDATE nach `completed` ohne Zeitstempel wird abgelehnt", async () => {
    // Der Weg, den der Import geht: erst `pending` anlegen, dann hart auf
    // `completed` setzen. Ohne diesen Fall wäre die Constraint gegen genau
    // den Erzeuger blind.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "SI3" });
    try {
      const [r] = await db.insert(monthlyServiceRecords).values({
        customerId: c.id as number, employeeId: emp.id,
        year: JAHR, month: MONAT, status: "pending",
      }).returning();

      await expect(
        db.update(monthlyServiceRecords)
          .set({ status: "completed" })
          .where(eq(monthlyServiceRecords.id, r.id)),
      ).rejects.toThrow();

      // Gegenprobe: der Nachweis steht unverändert da. Eine abgelehnte
      // Änderung darf nichts halb geschrieben haben.
      const [nachher] = await db.select({ status: monthlyServiceRecords.status })
        .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, r.id));
      expect(nachher.status).toBe("pending");
    } finally {
      await cleanupCustomer(c.id as number);
      await deactivateTestEmployee(emp.id);
    }
  });

  it("SI-4 – auch der GENERISCHE Setter kommt nicht daran vorbei", async () => {
    // Der eigentliche Punkt der Invariante. `updateServiceRecord` nimmt ein
    // beliebiges Partial entgegen — er ist der Weg, auf dem ein künftiger
    // Aufrufer den Zustand wieder erzeugen würde, ohne dass jemand den
    // Import anfasst.
    const { updateServiceRecord } = await import("../../server/storage/service-records-storage");
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "SI4" });
    try {
      const [r] = await db.insert(monthlyServiceRecords).values({
        customerId: c.id as number, employeeId: emp.id,
        year: JAHR, month: MONAT, status: "pending",
      }).returning();

      await expect(
        updateServiceRecord(r.id, { status: "completed" }),
        "die Datenbank gibt die Garantie, nicht die Sorgfalt des Aufrufers",
      ).rejects.toThrow();
    } finally {
      await cleanupCustomer(c.id as number);
      await deactivateTestEmployee(emp.id);
    }
  });

  it("SI-5 – der LEGITIME Weg geht weiterhin durch", async () => {
    // Gegenrichtung, und sie ist wichtig: eine Invariante, die auch den
    // richtigen Weg blockiert, wäre schlimmer als gar keine. `completed`
    // MIT Zeitstempel ist der Normalfall aus `signServiceRecord`.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "SI5" });
    try {
      const [r] = await db.insert(monthlyServiceRecords).values({
        customerId: c.id as number, employeeId: emp.id,
        year: JAHR, month: MONAT, status: "completed",
        employeeSignedAt: new Date(),
        customerSignedAt: new Date(),
      }).returning();
      expect(r.id).toBeGreaterThan(0);

      // Und die anderen Status bleiben ohne Kundenunterschrift erlaubt —
      // `pending` und `employee_signed` sind per Definition unsigniert.
      for (const status of ["pending", "employee_signed"]) {
        const [x] = await db.insert(monthlyServiceRecords).values({
          customerId: c.id as number, employeeId: emp.id,
          year: JAHR, month: MONAT + 1, status,
          customerSignedAt: null,
        }).returning();
        expect(x.status, `${status} darf ohne Kundenunterschrift existieren`).toBe(status);
      }
    } finally {
      await cleanupCustomer(c.id as number);
      await deactivateTestEmployee(emp.id);
    }
  });
});
