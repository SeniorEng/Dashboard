import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  appointments, monthlyServiceRecords,
  notifications, serviceRecordAppointments,
} from "@shared/schema";
import { createTestCustomer, cleanupCustomer, createTestEmployee, deactivateTestEmployee } from "../test-utils";
import {
  collectOpenItems, sendOpenItemsReminders,
} from "../../server/services/open-items-reminder";

/**
 * Nach-Cutoff-Erinnerung an den Mitarbeiter (Ticket 6hVwwxG9cxWGphfp).
 *
 * Gemessen wird die Erhebung (`collectOpenItems`) und der Versand
 * (`sendOpenItemsReminders`) — dieselben Funktionen, die das Batch
 * ruft. Kein nachgebauter Zählweg: die Baseline dieses Tickets ist
 * genau daran schon einmal vorbeigelaufen.
 */

const JAHR = 2026;
const MONAT = 4;                     // Quellmonat, weit weg vom Lauftag
const STICHTAG = `${JAHR}-05-15`;    // 15. des Folgemonats
const VOR_STICHTAG = `${JAHR}-05-14`;

async function terminAnlegen(
  customerId: number,
  employeeId: number | null,
  tag: number,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const [a] = await db.insert(appointments).values({
    customerId,
    assignedEmployeeId: employeeId,
    date: `${JAHR}-${String(MONAT).padStart(2, "0")}-${String(tag).padStart(2, "0")}`,
    scheduledStart: "10:00:00", scheduledEnd: "11:00:00",
    durationPromised: 60, status, appointmentType: "Kundentermin",
    ...extra,
  }).returning();
  return a.id;
}

async function lnAnlegen(
  customerId: number, employeeId: number, status: string,
  opts: { employeeSigned?: boolean; customerSigned?: boolean; appointmentId?: number; deleted?: boolean } = {},
): Promise<number> {
  const [r] = await db.insert(monthlyServiceRecords).values({
    customerId, employeeId, year: JAHR, month: MONAT, status,
    employeeSignedAt: opts.employeeSigned ? new Date() : null,
    customerSignedAt: opts.customerSigned ? new Date() : null,
    deletedAt: opts.deleted ? new Date() : null,
  }).returning();
  if (opts.appointmentId != null) {
    await db.insert(serviceRecordAppointments).values({
      serviceRecordId: r.id, appointmentId: opts.appointmentId,
    });
  }
  return r.id;
}

async function aufraeumen(customerId: number, ...employeeIds: number[]): Promise<void> {
  for (const id of employeeIds) {
    await db.delete(notifications).where(eq(notifications.userId, id));
  }
  // `audit_log` wird NICHT geräumt: ein DB-Trigger verweigert DELETE
  // (GoBD-Unveränderbarkeit). Das ist richtig so — die Idempotenz-Sperre
  // dieses Dienstes sitzt genau in dieser Tabelle. Jede Probe legt
  // frische Mitarbeiter an, die Einträge kollidieren also nicht.
  await cleanupCustomer(customerId);
  for (const id of employeeIds) await deactivateTestEmployee(id);
}

describe("Nach-Cutoff-Erinnerung — Erhebung", () => {
  it("OI-1 – dokumentierter Termin ohne Unterschrift zählt", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI1" });
    try {
      await terminAnlegen(c.id as number, emp.id, 7, "completed");
      const offen = await collectOpenItems(JAHR, MONAT);
      const meiner = offen.find(o => o.employeeId === emp.id);
      expect(meiner?.count, "completed ohne Unterschrift und ohne Nachweis ist offen").toBe(1);
      expect(meiner?.unsigned).toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-2 – ein Termin unter einem fertig signierten Nachweis zählt NICHT", async () => {
    // Gegenrichtung zu OI-1: ohne sie wäre der Test auch bei einer
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

  it("OI-3 – Pflegekasse: Nachweis wartet auf die Kundenunterschrift → zählt", async () => {
    // Die Lücke, die die Readiness-SSoT für DIESE Frage hat: für den
    // Monatsabschluss ist `employee_signed` erledigt, für die
    // Abrechnung fehlt die Kundenunterschrift noch.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI3" });
    try {
      const apptId = await terminAnlegen(c.id as number, emp.id, 9, "completed");
      await lnAnlegen(c.id as number, emp.id, "employee_signed", {
        employeeSigned: true, appointmentId: apptId,
      });
      const meiner = (await collectOpenItems(JAHR, MONAT)).find(o => o.employeeId === emp.id);
      expect(meiner?.count).toBe(1);
      expect(meiner?.awaitingCustomerSignature, "kommt aus dem Ergänzungs-Zweig").toBe(1);
      expect(meiner?.unsigned, "die Readiness-SSoT sieht ihn als erledigt").toBe(0);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-4 – Selbstzahler: derselbe Nachweis ist fertig und zählt NICHT", async () => {
    // Die zahlerabhängige Regel kommt aus `isServiceRecordSignedForBilling`
    // und wird hier NICHT zweitgeschrieben. Identischer Aufbau zu OI-3,
    // nur ein anderer Zahler — der Unterschied muss allein daher kommen.
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

  it("OI-5 – DEDUPLIZIERUNG: derselbe Termin aus zwei Quellen zählt EINMAL", async () => {
    // Ein `pending`-Nachweis trifft beide Zweige: der Termin ist für die
    // Readiness „completed, aber unsigniert" UND für den Ergänzungs-
    // Zweig „wartet auf die Kundenunterschrift". Würden die Quellen
    // addiert, stünde im Text eine Zahl, die es nicht gibt.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI5" });
    try {
      const apptId = await terminAnlegen(c.id as number, emp.id, 11, "completed");
      await lnAnlegen(c.id as number, emp.id, "pending", { appointmentId: apptId });
      const meiner = (await collectOpenItems(JAHR, MONAT)).find(o => o.employeeId === emp.id);
      expect(meiner?.unsigned, "Quelle 1 sieht ihn").toBe(1);
      expect(meiner?.awaitingCustomerSignature, "Quelle 2 sieht ihn auch").toBe(1);
      expect(meiner?.count, "1 + 1 wäre falsch — es ist EIN Termin").toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-6 – ZEIT-SCOPE: nur der Vormonat zählt, ältere Monate NICHT", async () => {
    // Die Ticket-Vorgabe nannte einen „Cross-Monats-Test: Nachweis aus
    // Juni feuert im September-Batch". Das widerspricht der finalen Spec
    // (Zeit-Scope „nur Vormonat"), und gebaut ist die Spec. Der Test
    // hält deshalb die Gegenrichtung fest — wer den Scope später weitet,
    // macht ihn rot und muss ihn bewusst ändern.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI6" });
    try {
      const [a] = await db.insert(appointments).values({
        customerId: c.id as number, assignedEmployeeId: emp.id,
        date: `${JAHR}-${String(MONAT - 2).padStart(2, "0")}-14`,
        scheduledStart: "10:00:00", scheduledEnd: "11:00:00",
        durationPromised: 60, status: "completed", appointmentType: "Kundentermin",
      }).returning();
      expect(a.id).toBeGreaterThan(0);

      expect(
        (await collectOpenItems(JAHR, MONAT)).find(o => o.employeeId === emp.id),
        "ein Termin aus einem früheren Monat gehört nicht in die Vormonats-Erinnerung",
      ).toBeUndefined();

      // Gegenprobe: im EIGENEN Monat abgefragt wird er sehr wohl
      // gefunden — sonst wäre der Test auch bei kaputter Erhebung grün.
      expect(
        (await collectOpenItems(JAHR, MONAT - 2)).find(o => o.employeeId === emp.id)?.count,
      ).toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-11 – VERTRETUNG: die Erinnerung geht an den Erbringer, nicht an den Zugewiesenen", async () => {
    // Der Fall, an dem die erste Fassung scheiterte. Zugewiesen an A,
    // geleistet von B: dokumentieren und unterschreiben kann nur B.
    // Zuordnung ist COALESCE(performed_by, assigned, primary) — dieselbe
    // SSoT, die Banner, Reminder und Auto-Close benutzen.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const zugewiesen = await createTestEmployee({ nachnamePrefix: "OI11A" });
    const erbringer = await createTestEmployee({ nachnamePrefix: "OI11B" });
    try {
      await terminAnlegen(c.id as number, zugewiesen.id, 12, "completed", {
        performedByEmployeeId: erbringer.id,
      });
      const offen = await collectOpenItems(JAHR, MONAT);
      expect(
        offen.find(o => o.employeeId === erbringer.id)?.count,
        "der Erbringer ist der Nachweis-Inhaber",
      ).toBe(1);
      expect(
        offen.find(o => o.employeeId === zugewiesen.id),
        "der Zugewiesene kann hier nichts tun und darf nichts bekommen",
      ).toBeUndefined();
    } finally {
      await aufraeumen(c.id as number, zugewiesen.id, erbringer.id);
    }
  });

  it("OI-12 – ERSTBERATUNG erscheint nie als offener Vorgang", async () => {
    // Erstberatungen werden dokumentiert, bekommen aber NIE eine
    // Unterschrift und können nie in einem Leistungsnachweis landen.
    // Ohne Carve-out stünden sie Monat für Monat in der Erinnerung,
    // ohne dass der Mitarbeiter sie je wegräumen könnte — der
    // Fehlalarm, den CLAUDE.md verbietet.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI12" });
    try {
      await terminAnlegen(c.id as number, emp.id, 13, "completed", {
        appointmentType: "Erstberatung",
      });
      expect(
        (await collectOpenItems(JAHR, MONAT)).find(o => o.employeeId === emp.id),
      ).toBeUndefined();

      // Gegenprobe mit demselben Aufbau, nur anderem Termin-Typ: der
      // Ausschluss muss AM TYP hängen und nicht daran, dass hier
      // ohnehin nichts gefunden würde.
      await terminAnlegen(c.id as number, emp.id, 14, "completed");
      expect(
        (await collectOpenItems(JAHR, MONAT)).find(o => o.employeeId === emp.id)?.count,
      ).toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-13 – soft-gelöschter Nachweis macht den Termin wieder offen", async () => {
    // Der Reconcile-Lauf storniert Nachweise soft und lässt die
    // Junction-Zeilen stehen — ausdrücklich, um die Termine zur
    // Neu-Dokumentation auszuweisen. Eine Erhebung, die nur die
    // Junction-Zeile sieht, hält den Termin für erledigt und macht ihn
    // in BEIDEN Zweigen unsichtbar.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI13" });
    try {
      const apptId = await terminAnlegen(c.id as number, emp.id, 15, "completed");
      await lnAnlegen(c.id as number, emp.id, "completed", {
        employeeSigned: true, customerSigned: true, appointmentId: apptId, deleted: true,
      });
      expect(
        (await collectOpenItems(JAHR, MONAT)).find(o => o.employeeId === emp.id)?.count,
        "die Junction-Zeile lebt, der Nachweis nicht — der Termin ist offen",
      ).toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-14 – noch nicht dokumentierter Termin zählt ebenfalls", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI14" });
    try {
      await terminAnlegen(c.id as number, emp.id, 16, "scheduled");
      const meiner = (await collectOpenItems(JAHR, MONAT)).find(o => o.employeeId === emp.id);
      expect(meiner?.count).toBe(1);
      expect(meiner?.notDocumented).toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });
});

describe("Nach-Cutoff-Erinnerung — Versand", () => {
  it("OI-7 – vor dem 15. geht nichts raus, ab dem 15. schon", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI7" });
    try {
      await terminAnlegen(c.id as number, emp.id, 17, "completed");

      const zuFrueh = await sendOpenItemsReminders(VOR_STICHTAG);
      expect(zuFrueh.skipped, "am 14. darf nichts rausgehen").toBe(true);
      expect(zuFrueh.notified).toBe(0);

      const amStichtag = await sendOpenItemsReminders(STICHTAG);
      expect(amStichtag.skipped).toBe(false);
      expect(amStichtag.notified).toBeGreaterThan(0);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-15 – NACHHOLEN: war die App am 15. unten, feuert der 17. noch", async () => {
    // Bei strikter Gleichheit auf den 15. fiele die Erinnerung für einen
    // ganzen Monat ersatzlos aus, wenn die App an dem Tag durchgehend
    // unten ist — still, ohne Log.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI15" });
    try {
      await terminAnlegen(c.id as number, emp.id, 18, "completed");
      const spaeter = await sendOpenItemsReminders(`${JAHR}-05-17`);
      expect(spaeter.skipped).toBe(false);
      const n = await db.select().from(notifications).where(and(
        eq(notifications.userId, emp.id),
        eq(notifications.type, "open_items_reminder"),
      ));
      expect(n.length, "der verpasste Stichtag wird nachgeholt").toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-8 – IDEMPOTENZ: weitere Läufe benachrichtigen nicht erneut", async () => {
    // Das Batch läuft täglich und der Scheduler startet bei jedem Deploy
    // neu. Seit dem Nachhol-Verhalten (`>=`) trägt die Sperre im
    // Audit-Log die ganze Last — eine Erinnerung, die täglich käme,
    // würde ignoriert.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI8" });
    try {
      await terminAnlegen(c.id as number, emp.id, 19, "completed");

      await sendOpenItemsReminders(STICHTAG);
      await sendOpenItemsReminders(STICHTAG);
      await sendOpenItemsReminders(`${JAHR}-05-16`);
      await sendOpenItemsReminders(`${JAHR}-05-17`);

      const n = await db.select().from(notifications).where(and(
        eq(notifications.userId, emp.id),
        eq(notifications.type, "open_items_reminder"),
      ));
      expect(n.length, "vier Läufe, genau eine Benachrichtigung").toBe(1);
    } finally {
      await aufraeumen(c.id as number, emp.id);
    }
  });

  it("OI-9 – der Text nennt die deduplizierte Termin-Zahl", async () => {
    // Zwei Termine: einer nur unsigniert, einer zusätzlich unter einem
    // pending-Nachweis (also in BEIDEN Quellen). Die Summe der Quellen
    // wäre 2 + 1 = 3; richtig sind 2.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI9" });
    try {
      await terminAnlegen(c.id as number, emp.id, 20, "completed");
      const zweiter = await terminAnlegen(c.id as number, emp.id, 21, "completed");
      await lnAnlegen(c.id as number, emp.id, "pending", { appointmentId: zweiter });

      const meiner = (await collectOpenItems(JAHR, MONAT)).find(o => o.employeeId === emp.id);
      expect(meiner?.unsigned).toBe(2);
      expect(meiner?.awaitingCustomerSignature).toBe(1);
      expect(meiner?.count).toBe(2);

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
    // Beim Kunden löst der Deaktivierungs-Guard das strukturell; für den
    // Mitarbeiter kommt der Filter aus der Readiness-SSoT selbst
    // (`is_active AND NOT is_admin`), nicht aus einer eigenen Abfrage.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "OI10" });
    try {
      await terminAnlegen(c.id as number, emp.id, 22, "completed");
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
