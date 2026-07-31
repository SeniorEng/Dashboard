/**
 * Task #1892 — Admin entfernt einen Termin aus einem unterschriebenen
 * Leistungsnachweis (reduktions-only).
 *
 * Realfall: Rechnung RE-2026-0417 ist bereits storniert (RE-2026-0500); der
 * Termin soll aus dem beidseitig unterschriebenen Sammel-LN heraus. Der LN
 * bündelt mehrere Monatstermine und muss als gültiger Nachweis erhalten
 * bleiben — nur mit einem Termin (und entsprechend weniger Wert) weniger.
 *
 * Abgedeckt:
 *   (a) Admin entfernt einen von mehreren Terminen → LN bleibt `completed`,
 *       beide Unterschriften erhalten, ein Termin weniger, Budget zurückgebucht.
 *   (b) letzter Termin entfernt → LN soft-gelöscht.
 *   (c) Termin auf einer AKTIVEN Entwurfs-Rechnung → 409, Meldung nennt
 *       „Entwurf verwerfen" (ein Entwurf wird NICHT storniert).
 *   (d) Nicht-Admin bleibt gesperrt.
 *   (e) Race: gleichzeitige Unterschrift vs. Admin-Korrektur bleibt konsistent.
 *   (f) DER Kernfall aus #1892: Rechnung gestellt UND storniert → Entfernen
 *       erlaubt. Das ist der Zweig, der das Prädikat „liegt auf einer AKTIVEN
 *       Rechnung" von einem simplen „ist abgerechnet?" unterscheidet.
 *   (g) Zwei-Kräfte-Einsatz → Korrektur wird ganz abgelehnt, nie halb
 *       ausgeführt (kein halber Einsatz auf einem signierten Nachweis).
 *   (h) Soft-gelöschte Termine halten den LN nicht künstlich „nicht leer".
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  apiDeleteAs,
  getAuthCookie,
  loginAs,
  uniqueId,
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  deactivateTestEmployee,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let year: number;
let month: number;
const workdays: string[] = [];

const cleanupCustomerIds: number[] = [];
const cleanupApptIds: number[] = [];
const cleanupEmployeeIds: number[] = [];

async function newCustomer(tag: string): Promise<number> {
  const cust = await createTestCustomer({ nachname: `LN1892-${tag}-${uniqueId()}` });
  const id = cust.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  return id;
}

async function createAndDocument(
  customerId: number,
  dateStr: string,
  time: string,
  assignedEmployeeId?: number,
): Promise<number> {
  const createRes = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date: dateStr,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
    assignedEmployeeId: assignedEmployeeId ?? auth.user.id,
  });
  if (createRes.status !== 201) {
    throw new Error(`Termin-Anlage fehlgeschlagen: ${createRes.status} ${JSON.stringify(createRes.data)}`);
  }
  cleanupApptIds.push(createRes.data.id);
  const docRes = await apiPost<any>(`/api/appointments/${createRes.data.id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "1892-Test" }],
  });
  if (docRes.status !== 200) {
    throw new Error(`Dokumentation fehlgeschlagen: ${docRes.status} ${JSON.stringify(docRes.data)}`);
  }
  return createRes.data.id;
}

/** Dokumentiert einen bereits angelegten Termin (z.B. ein Co-Visit-Partner-Leg). */
async function documentAppointment(appointmentId: number, time: string): Promise<void> {
  const docRes = await apiPost<any>(`/api/appointments/${appointmentId}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "1892-Test" }],
  });
  if (docRes.status !== 200) {
    throw new Error(`Dokumentation ${appointmentId} fehlgeschlagen: ${docRes.status} ${JSON.stringify(docRes.data)}`);
  }
}

/** Sammel-LN über die übergebenen Termine, danach beidseitig unterschrieben. */
async function createSignedRecord(
  customerId: number,
  appointmentIds: number[],
  employeeId?: number,
): Promise<number> {
  const res = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId: employeeId ?? auth.user.id,
    year,
    month,
    appointmentIds,
  });
  if (res.status !== 201) {
    throw new Error(`LN-Anlage fehlgeschlagen: ${res.status} ${JSON.stringify(res.data)}`);
  }
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost<any>(`/api/service-records/${res.data.id}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
      signingLocation: "Vor Ort",
    });
    if (sig.status !== 200) {
      throw new Error(`Unterschrift (${signerType}) fehlgeschlagen: ${sig.status} ${JSON.stringify(sig.data)}`);
    }
  }
  return res.data.id;
}

async function coveredAppointmentIds(recordId: number): Promise<number[]> {
  const res = await apiGet<any>(`/api/service-records/${recordId}/appointments`);
  const rows: any[] = Array.isArray(res.data) ? res.data : [];
  return rows.map((a) => a.id);
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;

  // Vormonat: dort sind die Termine vergangen und dokumentierbar.
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  year = prev.getFullYear();
  month = prev.getMonth() + 1;
  for (let day = 2; day <= 28 && workdays.length < 14; day++) {
    const cur = new Date(year, month - 1, day);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) {
      workdays.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }
});

afterAll(async () => {
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch { /* bereits weg */ }
  }
  for (const id of cleanupCustomerIds) {
    await cleanupCustomer(id);
  }
  for (const id of cleanupEmployeeIds) {
    await deactivateTestEmployee(id);
  }
});

describe("1892 — Admin entfernt Termin aus unterschriebenem Leistungsnachweis", () => {
  it("1892.1 – (a) LN bleibt completed mit beiden Unterschriften, ein Termin weniger, Budget zurückgebucht", async () => {
    const customerId = await newCustomer("a");
    const apptA = await createAndDocument(customerId, workdays[0], "09:00");
    const apptB = await createAndDocument(customerId, workdays[1], "09:00");
    const recordId = await createSignedRecord(customerId, [apptA, apptB]);

    const before = await apiGet<any>(`/api/service-records/${recordId}`);
    expect(before.data.status, "LN ist vor der Korrektur beidseitig unterschrieben").toBe("completed");
    expect(before.data.employeeSignedAt, "Mitarbeiter-Unterschrift vorhanden").toBeTruthy();
    expect(before.data.customerSignedAt, "Kunden-Unterschrift vorhanden").toBeTruthy();

    const txBefore = await apiGet<any[]>(`/api/budget/${customerId}/transactions?limit=100`);
    const reversalsBefore = (txBefore.data as any[]).filter((t) => t.transactionType === "reversal").length;

    const delRes = await apiDelete(`/api/appointments/${apptA}`);
    expect(delRes.status, `Admin-Löschung muss 200 liefern: ${JSON.stringify(delRes.data)}`).toBe(200);

    const gone = await apiGet<any>(`/api/appointments/${apptA}`);
    expect(gone.status, "Termin ist gelöscht").toBe(404);

    const after = await apiGet<any>(`/api/service-records/${recordId}`);
    expect(after.status, "LN existiert weiter").toBe(200);
    expect(after.data.status, "LN bleibt completed — kein neuer Status, kein Storno").toBe("completed");
    expect(after.data.employeeSignedAt, "Mitarbeiter-Unterschrift bleibt erhalten").toBe(before.data.employeeSignedAt);
    expect(after.data.customerSignedAt, "Kunden-Unterschrift bleibt erhalten").toBe(before.data.customerSignedAt);
    expect(after.data.employeeSignatureHash, "Signatur-Hash unverändert").toBe(before.data.employeeSignatureHash);
    expect(after.data.customerSignatureHash, "Signatur-Hash unverändert").toBe(before.data.customerSignatureHash);

    const covered = await coveredAppointmentIds(recordId);
    expect(covered, "entfernter Termin ist raus").not.toContain(apptA);
    expect(covered, "der andere Termin bleibt").toContain(apptB);

    const txAfter = await apiGet<any[]>(`/api/budget/${customerId}/transactions?limit=100`);
    const reversalsAfter = (txAfter.data as any[]).filter((t) => t.transactionType === "reversal").length;
    expect(reversalsAfter, "Budget des entfernten Termins wurde zurückgebucht").toBeGreaterThan(reversalsBefore);
  });

  it("1892.2 – (b) letzter Termin entfernt ⇒ LN wird soft-gelöscht", async () => {
    const customerId = await newCustomer("b");
    const appt = await createAndDocument(customerId, workdays[2], "09:00");
    const recordId = await createSignedRecord(customerId, [appt]);

    const delRes = await apiDelete(`/api/appointments/${appt}`);
    expect(delRes.status, `Admin-Löschung muss 200 liefern: ${JSON.stringify(delRes.data)}`).toBe(200);

    const after = await apiGet<any>(`/api/service-records/${recordId}`);
    expect(
      after.status,
      "Leerer LN ist kein Nachweis mehr und wird soft-gelöscht (nicht mehr abrufbar)",
    ).toBe(404);
  });

  it("1892.3 – (c) Termin auf AKTIVER Entwurfs-Rechnung ⇒ 409, Meldung nennt „Entwurf verwerfen“", async () => {
    const customerId = await newCustomer("c");
    const appt = await createAndDocument(customerId, workdays[3], "09:00");
    const recordId = await createSignedRecord(customerId, [appt]);

    const invoiceRes = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect([200, 201], `Rechnungslauf: ${JSON.stringify(invoiceRes.data)}`).toContain(invoiceRes.status);
    const generated: any[] = invoiceRes.data.invoices ?? [];
    expect(generated.length, "Rechnungslauf muss eine Rechnung erzeugen").toBeGreaterThanOrEqual(1);
    expect(
      generated.every((i) => i.status === "entwurf"),
      "frisch erzeugte Rechnungen sind Entwürfe — genau der Fall, den dieser Test prüft",
    ).toBe(true);

    const delRes = await apiDelete(`/api/appointments/${appt}`);
    expect(delRes.status, "abgerechneter Termin darf nicht entfernt werden").toBe(409);
    expect((delRes.data as any)?.error ?? (delRes.data as any)?.code).toBe("APPOINTMENT_INVOICED");
    // Ein Entwurf wird VERWORFEN, nicht storniert — die Meldung darf den
    // Admin nicht auf einen Weg schicken, den es für einen Entwurf nicht gibt.
    const message = String((delRes.data as any)?.message);
    expect(message, "Meldung nennt das Verwerfen des Entwurfs").toMatch(/verwerf/i);
    expect(message, "Meldung darf bei einem Entwurf NICHT zum Stornieren raten").not.toMatch(/stornier/i);

    // Nichts wurde angefasst: LN führt den Termin weiter.
    const covered = await coveredAppointmentIds(recordId);
    expect(covered, "abgewiesene Korrektur lässt den LN unverändert").toContain(appt);
  });

  it("1892.4 – (d) Nicht-Admin bleibt gesperrt — auch als zugewiesener Mitarbeiter", async () => {
    // Der Mitarbeiter ist EIGENER Mitarbeiter des Termins und dem Kunden
    // zugewiesen. Damit scheitert die Löschung nicht an der Zuständigkeit,
    // sondern genau an dem, was dieser Test prüft: die Korrektur an einem
    // unterschriebenen Nachweis bleibt Admins vorbehalten.
    const emp = await createTestEmployee({ nachnamePrefix: "LN1892NonAdmin" });
    cleanupEmployeeIds.push(emp.id);

    const customerId = await newCustomer("d");
    await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: emp.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    const appt = await createAndDocument(customerId, workdays[4], "09:00", emp.id);
    const recordId = await createSignedRecord(customerId, [appt], emp.id);

    const empAuth = await loginAs(emp.email, emp.password);
    const delRes = await apiDeleteAs(empAuth, `/api/appointments/${appt}`);
    expect(
      [403, 409],
      `Nicht-Admin muss abgewiesen werden, got ${delRes.status} ${JSON.stringify(delRes.data)}`,
    ).toContain(delRes.status);

    const covered = await coveredAppointmentIds(recordId);
    expect(covered, "LN bleibt unverändert").toContain(appt);
  });

  it("1892.5 – (e) Race: gleichzeitige Unterschrift vs. Admin-Korrektur bleibt konsistent", async () => {
    const customerId = await newCustomer("e");
    const apptA = await createAndDocument(customerId, workdays[5], "09:00");
    const apptB = await createAndDocument(customerId, workdays[6], "09:00");

    // Bewusst NICHT vorsigniert: die Mitarbeiter-Unterschrift ist der Gegner
    // im Rennen.
    const createRes = await apiPost<any>("/api/service-records", {
      customerId,
      employeeId: auth.user.id,
      year,
      month,
      appointmentIds: [apptA, apptB],
    });
    expect(createRes.status, "LN-Anlage").toBe(201);
    const recordId = createRes.data.id;

    const [signRes, delRes] = await Promise.all([
      apiPost<any>(`/api/service-records/${recordId}/sign`, {
        signerType: "employee",
        signatureData: validSignatureDataUrl(),
        signingLocation: "Vor Ort",
      }),
      apiDelete(`/api/appointments/${apptA}`),
    ]);

    // Beide Ausgänge sind zulässig — entscheidend ist, dass am Ende KEIN
    // widersprüchlicher Zustand steht: der LN zeigt nie auf einen gelöschten
    // Termin, und ein gelöschter Termin ist wirklich weg.
    const apptAfter = await apiGet<any>(`/api/appointments/${apptA}`);
    const covered = await coveredAppointmentIds(recordId);

    if (delRes.status === 200) {
      expect(apptAfter.status, "gelöschter Termin ist weg").toBe(404);
      expect(covered, "LN zeigt nicht mehr auf den gelöschten Termin").not.toContain(apptA);
    } else {
      expect(
        [403, 409],
        `abgewiesene Löschung muss 403/409 sein, got ${delRes.status} ${JSON.stringify(delRes.data)}`,
      ).toContain(delRes.status);
      expect(apptAfter.status, "abgewiesene Löschung lässt den Termin stehen").toBe(200);
      expect(covered, "LN führt den Termin weiter").toContain(apptA);
    }

    // Die Unterschrift ist entweder durchgelaufen oder sauber abgewiesen —
    // ein halb signierter Zustand darf nicht entstehen.
    const recordAfter = await apiGet<any>(`/api/service-records/${recordId}`);
    if (signRes.status === 200) {
      expect(recordAfter.data.status, "erfolgreiche Unterschrift ⇒ employee_signed").toBe("employee_signed");
      expect(recordAfter.data.employeeSignedAt).toBeTruthy();
    } else {
      expect(recordAfter.data?.status ?? "pending", "abgewiesene Unterschrift ⇒ LN bleibt pending").toBe("pending");
    }

    // Termin B überlebt in jedem Fall im Nachweis.
    expect(covered, "der zweite Termin bleibt im LN").toContain(apptB);
  });

  it("1892.6 – (f) KERNFALL: gestellte Rechnung storniert ⇒ Termin darf entfernt werden", async () => {
    // Der Realfall aus #1892 (RE-2026-0417 storniert über RE-2026-0500). Er
    // unterscheidet „liegt auf einer AKTIVEN Rechnung" von „ist irgendwann
    // abgerechnet worden": nach dem Storno ist der Termin wieder frei.
    const customerId = await newCustomer("f");
    const apptA = await createAndDocument(customerId, workdays[7], "09:00");
    const apptB = await createAndDocument(customerId, workdays[8], "09:00");
    const recordId = await createSignedRecord(customerId, [apptA, apptB]);

    const invoiceRes = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect([200, 201], `Rechnungslauf: ${JSON.stringify(invoiceRes.data)}`).toContain(invoiceRes.status);
    const generated: any[] = invoiceRes.data.invoices ?? [];
    expect(generated.length, "Rechnungslauf muss eine Rechnung erzeugen").toBeGreaterThanOrEqual(1);
    const mainInvoiceId = generated[0].id as number;

    // Rechnung STELLEN — erst dann ist Storno der fachlich richtige Weg.
    const sendRes = await apiPatch<any>(`/api/billing/${mainInvoiceId}/status`, { status: "versendet" });
    expect(sendRes.status, `versenden: ${JSON.stringify(sendRes.data)}`).toBe(200);

    // Solange sie steht: Entfernen abgelehnt, und JETZT ist „stornieren" der
    // richtige Rat (nicht „verwerfen" wie beim Entwurf).
    const blocked = await apiDelete(`/api/appointments/${apptA}`);
    expect(blocked.status, "gestellte Rechnung blockiert die Korrektur").toBe(409);
    expect((blocked.data as any)?.error ?? (blocked.data as any)?.code).toBe("APPOINTMENT_INVOICED");
    expect(String((blocked.data as any)?.message), "gestellte Rechnung ⇒ Storno-Weg").toMatch(/stornier/i);

    // Storno (mit Kaskade über etwaige Topf-Geschwister des Laufs).
    const stornoRes = await apiPatch<any>(`/api/billing/${mainInvoiceId}/status`, {
      status: "storniert",
      cascadeRun: true,
    });
    expect(stornoRes.status, `storno: ${JSON.stringify(stornoRes.data)}`).toBe(200);
    expect(stornoRes.data.status, "Original ist storniert").toBe("storniert");

    // Jetzt ist der Termin frei — genau das ist der Kern von #1892.
    const delRes = await apiDelete(`/api/appointments/${apptA}`);
    expect(
      delRes.status,
      `nach Storno muss die Korrektur durchgehen: ${JSON.stringify(delRes.data)}`,
    ).toBe(200);

    const after = await apiGet<any>(`/api/service-records/${recordId}`);
    expect(after.status, "LN existiert weiter (Termin B bleibt)").toBe(200);
    expect(after.data.status, "LN bleibt completed").toBe("completed");

    const covered = await coveredAppointmentIds(recordId);
    expect(covered, "stornierter Termin ist aus dem LN raus").not.toContain(apptA);
    expect(covered, "der zweite Termin bleibt").toContain(apptB);
  });

  it("1892.7 – (g) Zwei-Kräfte-Einsatz ⇒ Korrektur wird ganz abgelehnt, nie halb ausgeführt", async () => {
    // Ohne diesen Guard würde Leg A aus seinem signierten LN gelöst und
    // gelöscht, während das ebenfalls versiegelte Leg B still stehenbliebe
    // (`continue` in der Kaskade) — ein halber Einsatz auf einem
    // unterschriebenen Nachweis, und die Antwort meldete trotzdem Erfolg.
    const empB = await createTestEmployee({ nachnamePrefix: "LN1892CoVisit" });
    cleanupEmployeeIds.push(empB.id);

    const customerId = await newCustomer("g");
    await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: empB.id,
      backupEmployeeId2: null,
    });

    const date = workdays[9];
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId,
      date,
      scheduledStart: "09:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
      secondAssignedEmployeeId: empB.id,
    });
    expect(createRes.status, `Co-Visit-Anlage: ${JSON.stringify(createRes.data)}`).toBe(201);
    const groupId = createRes.data.coVisitGroupId;
    expect(groupId, "Co-Visit muss eine Gruppe haben").toBeTruthy();

    const list = await apiGet<any[]>(`/api/appointments?date=${date}&customerId=${customerId}`);
    const legs = (list.data as any[]).filter((a) => a.coVisitGroupId === groupId);
    expect(legs.length, "Zwei-Kräfte-Einsatz hat genau zwei Legs").toBe(2);
    for (const leg of legs) cleanupApptIds.push(leg.id);

    const legA = legs.find((l) => l.assignedEmployeeId === auth.user.id)!;
    const legB = legs.find((l) => l.assignedEmployeeId === empB.id)!;

    await documentAppointment(legA.id, "09:00");
    await documentAppointment(legB.id, "09:00");

    // Je Mitarbeiter ein eigener, beidseitig unterschriebener Nachweis — der
    // Normalfall, jeder bündelt seinen eigenen Monat.
    const recordA = await createSignedRecord(customerId, [legA.id], auth.user.id);
    const recordB = await createSignedRecord(customerId, [legB.id], empB.id);

    const delRes = await apiDelete(`/api/appointments/${legA.id}`);
    expect(
      delRes.status,
      `Co-Visit-Korrektur muss abgelehnt werden, got ${delRes.status} ${JSON.stringify(delRes.data)}`,
    ).toBe(409);
    expect((delRes.data as any)?.error ?? (delRes.data as any)?.code).toBe("APPOINTMENT_CO_VISIT_LOCKED");
    expect(String((delRes.data as any)?.message), "Meldung erklärt den Zwei-Kräfte-Fall").toMatch(/zwei-kräfte/i);

    // Entscheidend: KEIN Halbzustand. Beide Legs leben, beide Nachweise
    // führen ihren Termin unverändert.
    for (const legId of [legA.id, legB.id]) {
      const still = await apiGet<any>(`/api/appointments/${legId}`);
      expect(still.status, `Leg ${legId} lebt weiter`).toBe(200);
    }
    expect(await coveredAppointmentIds(recordA), "LN A unverändert").toContain(legA.id);
    expect(await coveredAppointmentIds(recordB), "LN B unverändert").toContain(legB.id);
  });

  it("1892.8 – (h) soft-gelöschter Termin hält den LN nicht künstlich „nicht leer“", async () => {
    // `deleteAppointment` ist ein SOFT-Delete: der ON-DELETE-CASCADE der
    // junction feuert nie, die Verknüpfungs-Zeile bleibt liegen. Zählte die
    // „ist der LN leer?"-Prüfung roh über die junction, hielte diese
    // Karteileiche den LN am Leben — Ergebnis wäre ein unterschriebener
    // Nachweis, der null Termine rendert.
    const customerId = await newCustomer("h");
    const apptA = await createAndDocument(customerId, workdays[10], "09:00");
    const apptB = await createAndDocument(customerId, workdays[11], "09:00");

    // LN anlegen, aber NOCH NICHT unterschreiben — solange er `pending` ist,
    // lässt sich Termin B regulär löschen (die junction-Zeile bleibt liegen).
    const createRes = await apiPost<any>("/api/service-records", {
      customerId,
      employeeId: auth.user.id,
      year,
      month,
      appointmentIds: [apptA, apptB],
    });
    expect(createRes.status, `LN-Anlage: ${JSON.stringify(createRes.data)}`).toBe(201);
    const recordId = createRes.data.id;

    const delB = await apiDelete(`/api/appointments/${apptB}`);
    expect(delB.status, `Löschen bei pending-LN: ${JSON.stringify(delB.data)}`).toBe(200);

    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost<any>(`/api/service-records/${recordId}/sign`, {
        signerType,
        signatureData: validSignatureDataUrl(),
        signingLocation: "Vor Ort",
      });
      expect(sig.status, `Unterschrift ${signerType}: ${JSON.stringify(sig.data)}`).toBe(200);
    }

    // Über den RENDERPFAD geprüft (nicht über die rohe junction): der LN führt
    // nur noch den einen lebenden Termin.
    const coveredBefore = await coveredAppointmentIds(recordId);
    expect(coveredBefore, "soft-gelöschter Termin wird nicht mehr gezeigt").not.toContain(apptB);
    expect(coveredBefore, "der lebende Termin steht im LN").toEqual([apptA]);

    // Letzten LEBENDEN Termin entfernen ⇒ der LN ist wirklich leer.
    const delA = await apiDelete(`/api/appointments/${apptA}`);
    expect(delA.status, `Admin-Korrektur: ${JSON.stringify(delA.data)}`).toBe(200);

    const after = await apiGet<any>(`/api/service-records/${recordId}`);
    expect(
      after.status,
      "LN ohne lebende Termine ist kein Nachweis mehr und wird soft-gelöscht — die Karteileiche darf ihn nicht am Leben halten",
    ).toBe(404);
  });
});
