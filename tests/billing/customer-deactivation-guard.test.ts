import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, customers, invoices, invoiceLineItems, monthlyServiceRecords, serviceRecordAppointments } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, createTestEmployee, deactivateTestEmployee, apiPatch } from "../test-utils";
import {
  DEACTIVATION_OVERRIDE_MIN_LENGTH,
  collectDeactivationBlockers,
  isBecomingInactive,
  isHardBlocked,
  isValidOverrideReason,
} from "../../server/services/customer-deactivation-guard";

/**
 * Deaktivierungs-Guard (Ticket 6hWcjpm3Q4V95Xwp).
 *
 * Wird ein Kunde inaktiv gesetzt, verschwindet er aus den
 * Standard-Listen — und offene Posten an ihm verschwinden mit. So
 * entstanden die Bestandsfaelle 93 und 89: beide inaktiv, beide mit
 * einem Nachweis, gegen den nie unterschrieben wurde.
 *
 * Gemessen wird die Erhebung (`collectDeactivationBlockers`), die
 * Uebergangs-Logik und der Endpunkt selbst — der Guard muss am
 * SERVER greifen, nicht nur im Formular.
 */

const JAHR = 2026;
const MONAT = 3;

async function lnAnlegen(
  customerId: number, employeeId: number, status: string,
  opts: { customerSigned?: boolean } = {},
): Promise<number> {
  const [r] = await db.insert(monthlyServiceRecords).values({
    customerId, employeeId, year: JAHR, month: MONAT, status,
    employeeSignedAt: new Date(),
    customerSignedAt: opts.customerSigned ? new Date() : null,
  }).returning();
  return r.id;
}

async function terminUnterLn(customerId: number, employeeId: number, recordId: number, tag: number): Promise<number> {
  const [a] = await db.insert(appointments).values({
    customerId, assignedEmployeeId: employeeId,
    date: `${JAHR}-${String(MONAT).padStart(2, "0")}-${String(tag).padStart(2, "0")}`,
    scheduledStart: "10:00:00", scheduledEnd: "11:00:00",
    durationPromised: 60, status: "completed", appointmentType: "Kundentermin",
  }).returning();
  await db.insert(serviceRecordAppointments).values({
    serviceRecordId: recordId, appointmentId: a.id,
  });
  return a.id;
}

async function rechnungAnlegen(
  customerId: number, status: string,
  opts: { appointmentId?: number; storniert?: boolean; invoiceType?: string } = {},
): Promise<number> {
  const [i] = await db.insert(invoices).values({
    customerId,
    invoiceNumber: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    billingType: "pflegekasse_gesetzlich",
    invoiceType: opts.invoiceType ?? "kasse",
    billingMonth: MONAT,
    billingYear: JAHR,
    recipientName: "Testkasse",
    status,
    storniertAt: opts.storniert ? new Date() : null,
  }).returning();
  if (opts.appointmentId != null) {
    await db.insert(invoiceLineItems).values({
      invoiceId: i.id,
      appointmentId: opts.appointmentId,
      appointmentDate: `${JAHR}-${String(MONAT).padStart(2, "0")}-05`,
      serviceDescription: "Testposten",
      durationMinutes: 60,
      unitPriceCents: 1000,
      totalCents: 1000,
    });
  }
  return i.id;
}

/**
 * Raeumt den Test-Kunden weg und PRUEFT, dass er wirklich weg ist.
 *
 * Die Pruefung ist der Punkt: `cleanupCustomer` ruft den
 * Purge-Endpunkt best-effort und verschluckt Fehler. Dieser Test legt
 * Rechnungen mit Positionen an — also genau die Daten, die unter dem
 * GoBD-Schutz stehen (Trigger `invoice_line_items_prevent_finalized_
 * mutation`, nur `entwurf` ist mutierbar). Der Purge darf das, weil er
 * `SET LOCAL app.allow_gobd_mutation = 'on'` setzt; scheitert er
 * trotzdem, bleibt hier ein Kunde liegen, und ein liegengebliebener
 * Kunde macht fremde Tests rot (`KV-LC.3` in `tests/customers.test.ts`
 * vergleicht globale Zaehler gegen Live-Abfragen).
 *
 * Deshalb wird nicht geglaubt, sondern nachgesehen. Selbst Rechnungen
 * loeschen waere falsch — es liefe gegen denselben Trigger.
 */
async function kundeVollstaendigWeg(customerId: number, ...employeeIds: number[]): Promise<void> {
  await cleanupCustomer(customerId);

  const [rest] = await db.select({ id: customers.id })
    .from(customers).where(eq(customers.id, customerId));
  expect(rest, `Test-Kunde ${customerId} ist liegengeblieben — das macht fremde Tests rot`)
    .toBeUndefined();

  for (const id of employeeIds) await deactivateTestEmployee(id);
}

describe("Deaktivierungs-Guard — Uebergangs-Logik", () => {
  it("DG-1 – der STATUS-Wechsel ist eine Deaktivierung (der Weg des Produkts)", () => {
    // Der Dialog „Kunden deaktivieren" schickt genau das und KEIN
    // `inaktivAb`. Eine erste Fassung wachte allein ueber `inaktiv_ab`
    // und lief damit im Produkt ins Leere.
    expect(isBecomingInactive({ status: "aktiv" }, { status: "inaktiv" })).toBe(true);
    expect(isBecomingInactive(
      { status: "aktiv", inaktivAb: null },
      { status: "inaktiv" },
    ), "ohne jedes inaktivAb").toBe(true);
  });

  it("DG-1b – `inaktiv_ab` allein ist KEINE Deaktivierung (Weiche W3)", () => {
    // Eine Zwischenfassung wachte auch darueber. Das war inkonsistent:
    // `PATCH /customers/:id/contract` schreibt dieselbe Spalte
    // ungeguardet, und ein Vertragsende ist kein Zustandswechsel —
    // zwei Antworten auf dieselbe fachliche Frage. Der Vertrags-Pfad
    // bleibt bewusst offen, ihn zu haerten ist ein eigenes Ticket.
    expect(isBecomingInactive({ status: "aktiv" }, { inaktivAb: "2026-03-31" } as never)).toBe(false);
    expect(isBecomingInactive({ status: "aktiv" }, {})).toBe(false);
  });

  it("DG-2 – ein bereits inaktiver Kunde laeuft NICHT erneut gegen den Guard", () => {
    // Sonst wird der 409 zum Dauerzustand bei jedem Speichern und die
    // Begruendung zur Formalie, die man wegklickt.
    expect(isBecomingInactive({ status: "inaktiv" }, { status: "inaktiv" }), "unveraendert").toBe(false);
  });

  it("DG-3 – den Status nicht anzufassen ist keine Deaktivierung", () => {
    expect(isBecomingInactive({ status: "aktiv" }, {})).toBe(false);
    expect(isBecomingInactive({ status: "aktiv" }, { status: "aktiv" })).toBe(false);
  });

  it("DG-4 – Reaktivieren ist keine Deaktivierung", () => {
    expect(isBecomingInactive({ status: "inaktiv" }, { status: "aktiv" })).toBe(false);
  });

  it("DG-5 – die Begruendung braucht Substanz, nicht nur Zeichen", () => {
    expect(isValidOverrideReason(null)).toBe(false);
    expect(isValidOverrideReason("")).toBe(false);
    expect(isValidOverrideReason("kurz")).toBe(false);
    expect(isValidOverrideReason("   ".repeat(20)), "Leerzeichen zaehlen nicht").toBe(false);
    expect(isValidOverrideReason("Kunde verstorben, Angehoerige informiert")).toBe(true);
    expect(isValidOverrideReason("a".repeat(DEACTIVATION_OVERRIDE_MIN_LENGTH))).toBe(true);
    expect(isValidOverrideReason("a".repeat(DEACTIVATION_OVERRIDE_MIN_LENGTH - 1))).toBe(false);
  });
});

describe("Deaktivierungs-Guard — Erhebung der offenen Posten", () => {
  it("DG-6 – A: Nachweis ohne Kundenunterschrift blockiert HART", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG6" });
    try {
      await lnAnlegen(c.id as number, emp.id, "employee_signed");
      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.unsignedRecords.length).toBe(1);
      expect(isHardBlocked(b)).toBe(true);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-7 – A greift NICHT, wenn der Kunde unterschrieben hat", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG7" });
    try {
      await lnAnlegen(c.id as number, emp.id, "completed", { customerSigned: true });
      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.unsignedRecords.length).toBe(0);
      expect(isHardBlocked(b), "ein fertiger Nachweis blockiert nichts").toBe(false);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-8 – B: fertiger Nachweis ohne Rechnung ist WARNUNG, kein Blocker", async () => {
    // Die Messung vor dem Bau: B trifft 89 von 165 aktiven Kunden, meist
    // im laufenden Monat. Ein harter Riegel darauf waere eine Bremse,
    // keine Sicherung.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG8" });
    try {
      const lnId = await lnAnlegen(c.id as number, emp.id, "completed", { customerSigned: true });
      await terminUnterLn(c.id as number, emp.id, lnId, 5);
      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.uninvoicedRecords.length).toBe(1);
      expect(isHardBlocked(b), "B ist nur eine Warnung").toBe(false);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-9 – B: abgerechnete Termine tauchen nicht auf", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG9" });
    try {
      const lnId = await lnAnlegen(c.id as number, emp.id, "completed", { customerSigned: true });
      const apptId = await terminUnterLn(c.id as number, emp.id, lnId, 6);
      await rechnungAnlegen(c.id as number, "gestellt", { appointmentId: apptId });
      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.uninvoicedRecords.length).toBe(0);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-10 – B: eine STORNIERTE Rechnung deckt den Termin NICHT ab", async () => {
    // GoBD: Storno + Neuausstellung. Ohne `storniert_at IS NULL` waere ein
    // Termin, dessen einzige Rechnung storniert wurde, faelschlich
    // „abgerechnet" — und der offene Posten unsichtbar.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG10" });
    try {
      const lnId = await lnAnlegen(c.id as number, emp.id, "completed", { customerSigned: true });
      const apptId = await terminUnterLn(c.id as number, emp.id, lnId, 7);
      // „Storniert" ist laut `activeInvoiceSqlRaw` ein STATUS, nicht der
      // Zeitstempel — die erste Fassung dieses Tests setzte nur
      // `storniert_at` und pruefte damit an der kanonischen Regel vorbei.
      await rechnungAnlegen(c.id as number, "storniert", { appointmentId: apptId, storniert: true });
      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.uninvoicedRecords.length, "eine stornierte Rechnung deckt nicht ab").toBe(1);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-11 – B zaehlt NACHWEISE, nicht Termine", async () => {
    // Ein Nachweis mit drei offenen Terminen ist EIN offener Posten.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG11" });
    try {
      const lnId = await lnAnlegen(c.id as number, emp.id, "completed", { customerSigned: true });
      await terminUnterLn(c.id as number, emp.id, lnId, 8);
      await terminUnterLn(c.id as number, emp.id, lnId, 9);
      await terminUnterLn(c.id as number, emp.id, lnId, 10);
      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.uninvoicedRecords.length, "drei Termine, ein Nachweis").toBe(1);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-12 – C: Rechnung im Entwurf ist WARNUNG, kein Blocker", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    try {
      await rechnungAnlegen(c.id as number, "entwurf");
      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.draftInvoices.length).toBe(1);
      expect(isHardBlocked(b), "C ist nur eine Warnung").toBe(false);
    } finally {
      await kundeVollstaendigWeg(c.id as number);
    }
  });

  it("DG-20 – SELBSTZAHLER: `employee_signed` blockiert TROTZDEM (Weiche W2)", async () => {
    // ENTSCHIEDEN (Alrik, 16.09.2026). Die Frage von Trigger A ist „hat
    // der KUNDE unterschrieben?", NICHT „ist der Nachweis abrechenbar?".
    //
    // Beim Selbstzahler fallen die beiden auseinander — dort ist
    // `employee_signed` laut `isServiceRecordSignedForBilling` bereits
    // abrechnungsfertig. Der Guard blockiert ihn dennoch, weil die
    // Kundenunterschrift nicht nur Kassen-Compliance ist, sondern auch
    // operatives Kunden-Review: der Kunde bestaetigt die erhaltene
    // Leistung, unabhaengig vom Zahlungsweg.
    //
    // Wer die Signatur auf die Abrechenbarkeit verkuerzt, macht diesen
    // Test rot — und muss die Entscheidung dann bewusst zurueckdrehen.
    const c = await createTestCustomer({ billingType: "selbstzahler" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG20" });
    try {
      await lnAnlegen(c.id as number, emp.id, "employee_signed");
      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.unsignedRecords.length, "Unterschrift fehlt — unabhaengig vom Zahler").toBe(1);
      expect(isHardBlocked(b)).toBe(true);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-21 – B: eine GUTSCHRIFT deckt den Termin NICHT ab", async () => {
    // Der Fall, den eine handgeschriebene `storniert_at IS NULL`-Formel
    // verfehlt: an echten Daten gemessen tragen ALLE 114 Gutschriften
    // `storniert_at = NULL` und waeren als aktive Rechnung
    // durchgegangen. Deshalb kommt „aktive Rechnung" jetzt aus
    // `activeInvoiceForAppointmentExistsSqlRaw`.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG21" });
    try {
      const lnId = await lnAnlegen(c.id as number, emp.id, "completed", { customerSigned: true });
      const apptId = await terminUnterLn(c.id as number, emp.id, lnId, 12);
      await rechnungAnlegen(c.id as number, "gestellt", {
        appointmentId: apptId, invoiceType: "stornorechnung",
      });
      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.uninvoicedRecords.length, "eine Gutschrift ist keine Abrechnung").toBe(1);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-22 – B: unterdrueckter No-Show ist nichts abzurechnen, kein offener Posten", async () => {
    // Task #1536: ein No-Show mit unterdrueckter Ausfallrechnung erzeugt
    // ABSICHTLICH kein Line-Item. Ohne Carve-out haenge der Nachweis
    // dauerhaft als „nicht abgerechnet" fest — falsch-positiver Alarm,
    // und die Prod-Messung 89/165 waere nach oben verzerrt.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG22" });
    try {
      const lnId = await lnAnlegen(c.id as number, emp.id, "completed", { customerSigned: true });
      const apptId = await terminUnterLn(c.id as number, emp.id, lnId, 13);
      await db.update(appointments).set({
        status: "customer_no_show", noShowChargeSuppressed: true,
      }).where(eq(appointments.id, apptId));

      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.uninvoicedRecords.length, "nichts abzurechnen ist nicht dasselbe wie unberechnet").toBe(0);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-13 – ein Kunde ohne offene Posten meldet nichts", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    try {
      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.unsignedRecords.length).toBe(0);
      expect(b.uninvoicedRecords.length).toBe(0);
      expect(b.draftInvoices.length).toBe(0);
    } finally {
      await kundeVollstaendigWeg(c.id as number);
    }
  });
});

describe("Deaktivierungs-Guard — am Endpunkt", () => {
  it("DG-14 – der Guard greift am SERVER, nicht nur im Formular", async () => {
    // Bypass-sicher: ein direkter PATCH ohne Begruendung muss 409
    // bekommen, auch wenn kein Formular beteiligt ist.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG14" });
    try {
      await lnAnlegen(c.id as number, emp.id, "employee_signed");

      // GENAU die Nutzlast des Deaktivieren-Dialogs — kein `inaktivAb`.
      const res = await apiPatch<any>(`/api/admin/customers/${c.id}`, {
        status: "inaktiv",
        deactivationReason: "kein_interesse",
        deactivationNote: null,
      });
      expect(res.status, `Antwort war: ${JSON.stringify(res.data)}`).toBe(409);
      expect(res.data?.code).toBe("DEACTIVATION_BLOCKED");
      expect(res.data?.details?.unsignedRecords?.length).toBe(1);

      // Der Kunde ist NICHT deaktiviert worden.
      const [nachher] = await db.select({ status: customers.status })
        .from(customers).where(eq(customers.id, c.id as number));
      expect(nachher.status, "die Blockade muss auch wirken").toBe("aktiv");
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-15 – mit Begruendung geht es durch", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG15" });
    try {
      await lnAnlegen(c.id as number, emp.id, "employee_signed");

      const res = await apiPatch<any>(`/api/admin/customers/${c.id}`, {
        status: "inaktiv",
        deactivationOverrideReason: "Kunde verstorben, Angehoerige informiert",
      });
      expect(res.status, `Antwort war: ${JSON.stringify(res.data)}`).toBe(200);

      const [nachher] = await db.select({ status: customers.status })
        .from(customers).where(eq(customers.id, c.id as number));
      expect(nachher.status).toBe("inaktiv");
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-16 – eine zu kurze Begruendung zaehlt nicht", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG16" });
    try {
      await lnAnlegen(c.id as number, emp.id, "pending");
      const res = await apiPatch<any>(`/api/admin/customers/${c.id}`, {
        status: "inaktiv",
        deactivationOverrideReason: "egal",
      });
      expect(res.status).toBe(409);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-17 – B und C allein blockieren NICHT", async () => {
    // Die Kernentscheidung des Tickets: 118 von 165 aktiven Kunden
    // treffen irgendeinen Trigger, Treiber sind B und C. Ein Riegel
    // darauf waere eine Bremse bei sieben von zehn Deaktivierungen.
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG17" });
    try {
      const lnId = await lnAnlegen(c.id as number, emp.id, "completed", { customerSigned: true });
      await terminUnterLn(c.id as number, emp.id, lnId, 11);   // B
      await rechnungAnlegen(c.id as number, "entwurf");        // C

      const b = await collectDeactivationBlockers(c.id as number);
      expect(b.uninvoicedRecords.length, "B liegt an").toBe(1);
      expect(b.draftInvoices.length, "C liegt an").toBe(1);

      const res = await apiPatch<any>(`/api/admin/customers/${c.id}`, {
        status: "inaktiv",
      });
      expect(res.status, `Antwort war: ${JSON.stringify(res.data)}`).toBe(200);
      expect(res.data?.deactivationFindings?.uninvoicedRecords?.length,
        "B/C muessen den Aufrufer erreichen, nicht nur das Audit-Log").toBe(1);
      expect(res.data?.deactivationFindings?.draftInvoices?.length).toBe(1);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });

  it("DG-18 – ein Kunde ohne offene Posten wird ohne Begruendung inaktiv", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    try {
      const res = await apiPatch<any>(`/api/admin/customers/${c.id}`, {
        status: "inaktiv",
      });
      expect(res.status, `Antwort war: ${JSON.stringify(res.data)}`).toBe(200);
    } finally {
      await kundeVollstaendigWeg(c.id as number);
    }
  });

  it("DG-19 – ein bereits inaktiver Kunde laeuft nicht erneut in den 409", async () => {
    const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich" });
    const emp = await createTestEmployee({ nachnamePrefix: "DG19" });
    try {
      // Erst sauber deaktivieren, DANN den offenen Posten anlegen — so
      // entsteht genau der Zustand der Bestandsfaelle.
      const erst = await apiPatch<any>(`/api/admin/customers/${c.id}`, {
        status: "inaktiv",
      });
      expect(erst.status).toBe(200);
      await lnAnlegen(c.id as number, emp.id, "employee_signed");

      const res = await apiPatch<any>(`/api/admin/customers/${c.id}`, {
        status: "inaktiv",
      });
      expect(res.status, "schon inaktiv — kein neuer Uebergang, kein zweiter 409").toBe(200);
    } finally {
      await kundeVollstaendigWeg(c.id as number, emp.id);
    }
  });
});
