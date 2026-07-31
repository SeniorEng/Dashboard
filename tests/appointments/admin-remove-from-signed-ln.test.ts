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
 *   (c) Termin auf AKTIVER Rechnung → 409 (Storno first).
 *   (d) Nicht-Admin bleibt gesperrt.
 *   (e) Race: gleichzeitige Unterschrift vs. Admin-Korrektur bleibt konsistent.
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
  for (let day = 2; day <= 28 && workdays.length < 8; day++) {
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

  it("1892.3 – (c) Termin auf AKTIVER Rechnung ⇒ 409, kein stiller Abbruch", async () => {
    const customerId = await newCustomer("c");
    const appt = await createAndDocument(customerId, workdays[3], "09:00");
    const recordId = await createSignedRecord(customerId, [appt]);

    const invoiceRes = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect([200, 201], `Rechnungslauf: ${JSON.stringify(invoiceRes.data)}`).toContain(invoiceRes.status);

    const delRes = await apiDelete(`/api/appointments/${appt}`);
    expect(delRes.status, "abgerechneter Termin darf nicht entfernt werden").toBe(409);
    expect((delRes.data as any)?.error ?? (delRes.data as any)?.code).toBe("APPOINTMENT_INVOICED");
    expect(String((delRes.data as any)?.message), "Meldung nennt den Storno-Weg").toMatch(/stornier/i);

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
});
