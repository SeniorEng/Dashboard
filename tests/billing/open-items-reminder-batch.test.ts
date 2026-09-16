import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  appointments, customers, monthlyServiceRecords,
  notifications, serviceRecordAppointments,
} from "@shared/schema";
import { createTestCustomer, cleanupCustomer, createTestEmployee, deactivateTestEmployee } from "../test-utils";
import {
  collectOpenItems, sendOpenItemsReminders,
} from "../../server/services/open-items-reminder";

/**
 * MA-Erinnerung an offene Vorgänge (Ticket 6hVwwxG9cxWGphfp).
 *
 * Gemessen wird die Erhebung (`collectOpenItems`) und der Versand
 * (`sendOpenItemsReminders`) — dieselben Funktionen, die das Batch ruft.
 * Kein nachgebauter Zählweg: die Baseline dieses Tickets ist genau daran
 * schon einmal vorbeigelaufen (Admin-Modell gegen MA-Modell gemessen).
 */

const JAHR = 2026;
const MONAT = 4;            // Quelljahr-Monat, weit weg vom Lauftag
const STICHTAG = `${JAHR}-05-15`;   // 15. des Folgemonats
const KEIN_STICHTAG = `${JAHR}-05-14`;

async function terminAnlegen(customerId: number, employeeId: number, tag: number, status: string): Promise<number> {
  const [a] = await db.insert(appointments).values({
    customerId, assignedEmployeeId: employeeId,
    date: `${JAHR}-${String(MONAT).padStart(2, "0")}-${String(tag).padStart(2, "0")}`,
    scheduledStart: "10:00:00", scheduledEnd: "11:00:00",
    durationPromised: 60, status, appointmentType: "Kundentermin",
  }).returning();
  return a.id;
}

async function lnAnlegen(
  customerId: number, employeeId: number, status: string,
  opts: { employeeSigned?: boolean; customerSigned?: boolean; appointmentId?: number } = {},
): Promise<number> {
  const [r] = await db.insert(monthlyServiceRecords).values({
    customerId, employeeId, year: JAHR, month: MONAT, status,
    employeeSignedAt: opts.employeeSigned ? new Date() : null,
    customerSignedAt: opts.customerSigned ? new Date() : null,
  }).returning();
  if (opts.appointmentId != null) {
    await db.insert(serviceRecordAppointments).values({
      serviceRecordId: r.id, appointmentId: opts.appointmentId,
    });
  }
  return r.id;
}

async function aufraeumen(customerId: number, employeeId: number): Promise<void> {
  await db.delete(notifications).where(eq(notifications.userId, employeeId));
  // `audit_log` wird NICHT geräumt: ein DB-Trigger verweigert DELETE
  // (GoBD-Unveränderbarkeit). Das ist richtig so — die Idempotenz-Sperre
  // dieses Dienstes sitzt genau in dieser Tabelle. Jede Probe legt einen
  // frischen Mitarbeiter an, die Einträge kollidieren also nicht.
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
}

describe("MA-Erinnerung — Erhebung der offenen Vorgänge", () => {
  it("OI-1 – F1: dokumentierter Termin OHNE Leistungsnachweis zählt", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI1" });
    try {
      await terminAnlegen(c.id as number, emp.id, 7, "completed");
      const offen = await collectOpenItems(JAHR, MONAT);
      const meiner = offen.find(o => o.employeeId === emp.id);
      expect(meiner?.count, "ein dokumentierter Termin ohne LN ist ein offener Vorgang").toBe(1);
      expect(meiner?.appointmentsWithoutRecord).toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-2 – ein Termin MIT Leistungsnachweis zählt NICHT als F1", async () => {
    // Gegenrichtung zu OI-1: ohne sie würde der Test auch bei einer
    // Erhebung grün, die jeden dokumentierten Termin meldet.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI2" });
    try {
      const apptId = await terminAnlegen(c.id as number, emp.id, 8, "completed");
      await lnAnlegen(c.id as number, emp.id, "completed", {
        employeeSigned: true, customerSigned: true, appointmentId: apptId,
      });
      const offen = await collectOpenItems(JAHR, MONAT);
      expect(offen.find(o => o.employeeId === emp.id)).toBeUndefined();
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-3 – F4: employee_signed ohne Kundenunterschrift zählt (Pflegekasse)", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI3" });
    try {
      const apptId = await terminAnlegen(c.id as number, emp.id, 9, "completed");
      await lnAnlegen(c.id as number, emp.id, "employee_signed", {
        employeeSigned: true, appointmentId: apptId,
      });
      const offen = await collectOpenItems(JAHR, MONAT);
      expect(offen.find(o => o.employeeId === emp.id)?.count).toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-4 – F4 greift NICHT bei Selbstzahlern (Kundenunterschrift nicht nötig)", async () => {
    // Die kassenabhängige Regel aus `isServiceRecordSignedForBilling`:
    // beim Selbstzahler ist der LN mit MA-Unterschrift bereits gültig.
    const c = await createTestCustomer({ billingType: "selbstzahler" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI4" });
    try {
      const apptId = await terminAnlegen(c.id as number, emp.id, 10, "completed");
      await lnAnlegen(c.id as number, emp.id, "employee_signed", {
        employeeSigned: true, appointmentId: apptId,
      });
      const offen = await collectOpenItems(JAHR, MONAT);
      expect(offen.find(o => o.employeeId === emp.id)).toBeUndefined();
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-5 – DEDUPLIZIERUNG: ein pending-LN erfüllt F2 UND F3, zählt aber EINMAL", async () => {
    // Der Kern der Zähl-Regel. Ein `pending`-LN ohne beide Signaturen ist
    // gleichzeitig „Doku unvollständig" (F2) und „unsigniert" (F3). Würde
    // der Versand die Einzelsummen addieren, stünde im Text eine Zahl,
    // die es nicht gibt — ein Leistungsnachweis doppelt gezählt.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI5" });
    try {
      const apptId = await terminAnlegen(c.id as number, emp.id, 11, "completed");
      await lnAnlegen(c.id as number, emp.id, "pending", { appointmentId: apptId });
      const offen = await collectOpenItems(JAHR, MONAT);
      const meiner = offen.find(o => o.employeeId === emp.id);
      expect(meiner?.count, "F2 und F3 treffen denselben LN — er zählt einmal").toBe(1);
      expect(meiner?.serviceRecords).toBe(1);
      expect(meiner?.appointmentsWithoutRecord).toBe(0);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-6 – ZEIT-SCOPE: nur der Vormonat zählt, ältere Monate NICHT", async () => {
    // Die Ticket-Vorgabe nannte einen „Cross-Monats-Test: LN aus Juni
    // feuert im September-Batch". Das widerspricht der finalen Spec
    // (Zeit-Scope „nur Vormonat"), und gebaut ist die Spec. Der Test
    // hält deshalb die Gegenrichtung fest: ein älterer LN feuert NICHT.
    //
    // Damit ist die Entscheidung im Code sichtbar statt implizit — wer
    // den Scope später weitet, macht diesen Test rot und muss ihn
    // bewusst ändern.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI6" });
    try {
      const [alt] = await db.insert(monthlyServiceRecords).values({
        customerId: c.id as number, employeeId: emp.id,
        year: JAHR, month: MONAT - 2, status: "pending",
      }).returning();
      expect(alt.id).toBeGreaterThan(0);

      const offen = await collectOpenItems(JAHR, MONAT);
      expect(
        offen.find(o => o.employeeId === emp.id),
        "ein LN aus einem früheren Monat gehört nicht in die Vormonats-Erinnerung",
      ).toBeUndefined();

      // Gegenprobe: im EIGENEN Monat abgefragt, wird er sehr wohl gefunden —
      // sonst könnte der Test auch bei einer kaputten Erhebung grün sein.
      const imEigenenMonat = await collectOpenItems(JAHR, MONAT - 2);
      expect(imEigenenMonat.find(o => o.employeeId === emp.id)?.count).toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });
});

describe("MA-Erinnerung — Versand", () => {
  it("OI-7 – feuert NUR am 15.", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI7" });
    try {
      await terminAnlegen(c.id as number, emp.id, 12, "completed");

      const zuFrueh = await sendOpenItemsReminders(KEIN_STICHTAG);
      expect(zuFrueh.skipped, "am 14. darf nichts rausgehen").toBe(true);
      expect(zuFrueh.notified).toBe(0);

      const amStichtag = await sendOpenItemsReminders(STICHTAG);
      expect(amStichtag.skipped).toBe(false);
      expect(amStichtag.notified).toBeGreaterThan(0);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-8 – IDEMPOTENZ: ein zweiter Lauf am selben Tag benachrichtigt nicht erneut", async () => {
    // Das Batch laeuft taeglich und der Scheduler startet bei jedem
    // Deploy neu — ohne Sperre bekaeme der Mitarbeiter die Erinnerung
    // mehrfach, und eine Erinnerung, die zweimal kommt, wird ignoriert.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI8" });
    try {
      await terminAnlegen(c.id as number, emp.id, 13, "completed");

      await sendOpenItemsReminders(STICHTAG);
      const nachErstem = await db.select().from(notifications).where(and(
        eq(notifications.userId, emp.id),
        eq(notifications.type, "open_items_reminder"),
      ));
      expect(nachErstem.length).toBe(1);

      await sendOpenItemsReminders(STICHTAG);
      await sendOpenItemsReminders(STICHTAG);

      const nachDrei = await db.select().from(notifications).where(and(
        eq(notifications.userId, emp.id),
        eq(notifications.type, "open_items_reminder"),
      ));
      expect(nachDrei.length, "drei Laeufe, genau eine Benachrichtigung").toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-9 – der Text nennt die DEDUPLIZIERTE Zahl", async () => {
    // Zwei Vorgaenge: ein Termin ohne LN (F1) und ein pending-LN (F2+F3).
    // Die Einzelsummen waeren 1 + 2 = 3; richtig sind 2.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI9" });
    try {
      await terminAnlegen(c.id as number, emp.id, 14, "completed");
      const zweiter = await terminAnlegen(c.id as number, emp.id, 15, "completed");
      await lnAnlegen(c.id as number, emp.id, "pending", { appointmentId: zweiter });

      await sendOpenItemsReminders(STICHTAG);

      const [n] = await db.select().from(notifications).where(and(
        eq(notifications.userId, emp.id),
        eq(notifications.type, "open_items_reminder"),
      ));
      expect(n, "Benachrichtigung muss existieren").toBeTruthy();
      expect(n.message, `Text war: ${n.message}`).toContain("2 noch nicht abgeschlossene Vorgänge");
      expect(n.message).not.toContain("3 noch nicht");
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-10 – ausgeschiedene Mitarbeiter bekommen nichts", async () => {
    // Beim Kunden loest der Deaktivierungs-Guard das strukturell; fuer den
    // Mitarbeiter gibt es kein Gegenstueck, deshalb der Filter im Versand.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI10" });
    try {
      await terminAnlegen(c.id as number, emp.id, 16, "completed");
      await deactivateTestEmployee(emp.id);

      const r = await sendOpenItemsReminders(STICHTAG);
      expect(r.skipped).toBe(false);

      const n = await db.select().from(notifications).where(and(
        eq(notifications.userId, emp.id),
        eq(notifications.type, "open_items_reminder"),
      ));
      expect(n.length, "kein Versand an ausgeschiedene Mitarbeiter").toBe(0);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });
});

/** Ungenutzte Import-Warnung vermeiden — `customers` wird fuer Typen gebraucht. */
void customers;
