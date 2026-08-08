/**
 * PR-A — Serialisierung des Korrekturwegs.
 *
 * Seit #70 ist „Leistungsnachweis löschen" ein regulärer Arbeitsablauf
 * (korrigieren → neu dokumentieren → neu unterschreiben) und kein Ausnahmefall
 * mehr. Damit wird ein vorbestehender Riss relevant: `signServiceRecord`
 * schrieb den Status-Übergang in einem bedingten UPDATE, das NUR auf
 * `status = expectedStatus` prüfte — nicht auf `deleted_at`. Eine gleichzeitig
 * committende Unterschrift landete deshalb auf einem Nachweis, den der
 * Korrekturweg gerade entfernt hatte: ein soft-gelöschter LN trug eine
 * Unterschrift, die kein Dokument mehr belegt.
 *
 * Geprüft:
 *   (a) `signServiceRecord` weist einen gelöschten Nachweis mit
 *       `ServiceRecordDeletedError` ab — NICHT mit der irreführenden „kann nur
 *       bei Status pending unterschreiben"-Meldung. Geprüft direkt an der
 *       Storage-Funktion, denn über HTTP ist dieser Fall gar nicht erreichbar:
 *       die Route liest den Nachweis vorher über `getServiceRecord`, das
 *       soft-gelöschte herausfiltert, und antwortet 404. Genau deshalb zielt
 *       der Guard auf das RENNFENSTER — die Löschung zwischen jenem Read und
 *       dem Commit der Unterschrift. Fall (d) fährt dieses Fenster.
 *   (b) Der gelöschte Nachweis bleibt unsigniert — der Guard verhindert den
 *       Schreibvorgang, er meldet ihn nicht bloß.
 *   (c) Der echte Out-of-Order-Fall (zweimal dieselbe Unterschrift) meldet
 *       weiterhin 400 mit der Status-Meldung. Ohne diesen Fall könnte der neue
 *       Zweig alles einsammeln und niemandem fiele es auf.
 *   (c2) Dasselbe für den KUNDEN-Übergang (`employee_signed → completed`) —
 *       er war an keiner Stelle abgesichert, und die 400-Zuordnung hängt am
 *       Substring „kann nur", den dieser PR angefasst hat.
 *   (d) Das Rennen selbst: gleichzeitige Unterschrift und LN-Korrektur enden
 *       nie in einem widersprüchlichen Zustand.
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../server/lib/db";
import { monthlyServiceRecords } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  signServiceRecord,
  ServiceRecordDeletedError,
} from "../../server/storage/service-records-storage";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestCustomer,
  cleanupCustomer,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let year: number;
let month: number;
const workdays: string[] = [];
const cleanupCustomerIds: number[] = [];
const cleanupApptIds: number[] = [];

async function newCustomer(tag: string): Promise<number> {
  const cust = await createTestCustomer({ nachname: `PRA-${tag}-${uniqueId()}` });
  const id = cust.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  return id;
}

async function createAndDocument(customerId: number, dateStr: string, time: string): Promise<number> {
  const createRes = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date: dateStr,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
    assignedEmployeeId: auth.user.id,
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
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "PR-A" }],
  });
  if (docRes.status !== 200) {
    throw new Error(`Dokumentation fehlgeschlagen: ${docRes.status} ${JSON.stringify(docRes.data)}`);
  }
  return createRes.data.id;
}

async function createRecord(customerId: number, appointmentIds: number[]): Promise<number> {
  const res = await apiPost<any>("/api/service-records", {
    customerId, employeeId: auth.user.id, year, month, appointmentIds,
  });
  if (res.status !== 201) {
    throw new Error(`LN-Anlage fehlgeschlagen: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.id;
}

function sign(recordId: number, signerType: "employee" | "customer") {
  return apiPost<any>(`/api/service-records/${recordId}/sign`, {
    signerType,
    signatureData: validSignatureDataUrl(),
    signingLocation: "Vor Ort",
  });
}

async function recordRow(recordId: number) {
  const [row] = await db.select({
    status: monthlyServiceRecords.status,
    deletedAt: monthlyServiceRecords.deletedAt,
    employeeSignatureData: monthlyServiceRecords.employeeSignatureData,
    customerSignatureData: monthlyServiceRecords.customerSignatureData,
  }).from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, recordId));
  return row;
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  year = prev.getFullYear();
  month = prev.getMonth() + 1;
  for (let day = 2; day <= 28 && workdays.length < 10; day++) {
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
  for (const id of cleanupCustomerIds) await cleanupCustomer(id);
});

describe("PR-A — Unterschrift vs. Korrekturweg", () => {
  it("(a)(b) Rennfenster deterministisch: Loeschung waehrend der Unterschrift ⇒ eigener Fehler, keine Signatur", async () => {
    const customerId = await newCustomer("del");
    const apptId = await createAndDocument(customerId, workdays[0], "09:00");
    const recordId = await createRecord(customerId, [apptId]);

    // Das Fenster, auf das der Guard zielt, laesst sich von aussen nicht
    // ansteuern: `signServiceRecord` liest den Nachweis zuerst ueber
    // `getServiceRecord` (filtert soft-geloescht heraus) und gibt bei einem
    // BEREITS geloeschten Nachweis `undefined` zurueck, ohne je zum UPDATE zu
    // kommen. Ueber HTTP antwortet die Route aus demselben Grund 404.
    //
    // Deterministisch wird es ueber einen gehaltenen Zeilen-Lock: Transaktion A
    // sperrt die LN-Zeile, der Unterschrifts-Versuch laeuft an und BLOCKIERT an
    // genau diesem Lock, danach loescht A soft und committet. Der wartende
    // UPDATE wird neu ausgewertet, trifft wegen `deleted_at` 0 Zeilen — und
    // genau dort greift der neue Zweig.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // ZWEITES Signal: es genuegt nicht, nur die FREIGABE zu synchronisieren.
    // Ohne dieses hier gaebe es zwischen dem Start der Halte-Transaktion und
    // dem Unterschrifts-Versuch kein `await` — nichts stellte sicher, dass der
    // Lock ueberhaupt schon gehalten wird. Gewaenne der Sign-Pfad das
    // Startrennen, committete er die Unterschrift und der Fall waere
    // falsch-rot. Beide Seiten ziehen hier ihre erste Pool-Verbindung; der
    // Vorsprung haenge sonst an zwei parallelen Handshakes, nicht an Logik.
    let lockAcquired!: () => void;
    const locked = new Promise<void>((r) => { lockAcquired = r; });

    const holder = db.transaction(async (txA) => {
      await txA.select({ id: monthlyServiceRecords.id })
        .from(monthlyServiceRecords)
        .where(eq(monthlyServiceRecords.id, recordId))
        .for("update");
      lockAcquired();
      await gate;
      await txA.update(monthlyServiceRecords)
        .set({ deletedAt: new Date() })
        .where(eq(monthlyServiceRecords.id, recordId));
    });

    // Erst wenn die Zeile nachweislich gesperrt ist, das Rennen starten.
    await locked;
    const signAttempt = signServiceRecord(
      recordId, validSignatureDataUrl(), "employee", auth.user.id, null, "Vor Ort",
    );
    // Kurz warten, damit der Versuch bis zum blockierenden UPDATE gelaufen ist.
    // Seit `await locked` oben ist das nur noch Komfort, keine Absicherung:
    // die Sperre wird bereits gehalten, ein zu kurzes Warten koennte den
    // Versuch hoechstens auf einen schon geloeschten Datensatz treffen lassen —
    // was denselben Fehler ergibt.
    await new Promise((r) => setTimeout(r, 400));
    release();
    await holder;

    // (a) Der ECHTE Grund, nicht die Status-Meldung.
    await expect(signAttempt).rejects.toThrow(ServiceRecordDeletedError);
    await signAttempt.catch((err: Error) => {
      expect(err.message).toContain("gelöscht");
      expect(err.message).not.toContain("kann nur");
    });

    // (b) Der Guard hat den Schreibvorgang verhindert, nicht bloss gemeldet.
    const row = await recordRow(recordId);
    expect(row.status).toBe("pending");
    expect(row.employeeSignatureData).toBeNull();
  });

  it("(c) echter Out-of-Order-Fall meldet weiterhin 400 mit Status-Meldung", async () => {
    const customerId = await newCustomer("ooo");
    const apptId = await createAndDocument(customerId, workdays[1], "10:00");
    const recordId = await createRecord(customerId, [apptId]);

    expect((await sign(recordId, "employee")).status).toBe(200);

    // Zweite Mitarbeiter-Unterschrift: Status ist jetzt `employee_signed`.
    const zweite = await sign(recordId, "employee");
    expect(zweite.status).toBe(400);
    expect((zweite.data as any).message).toContain("kann nur");
    // Der neue Zweig darf diesen Fall NICHT einsammeln.
    expect((zweite.data as any).error).not.toBe("RECORD_DELETED");
  });

  it("(c2) Kunden-Uebergang: eigene Out-of-Order-Meldung, ebenfalls 400", async () => {
    const customerId = await newCustomer("kunde");
    const apptId = await createAndDocument(customerId, workdays[3], "12:00");
    const recordId = await createRecord(customerId, [apptId]);

    // Kunde vor dem Mitarbeiter — der ZWEITE Uebergang
    // (`employee_signed -> completed`) ist an keiner anderen Stelle
    // abgesichert, und die 400-Zuordnung haengt am Substring "kann nur",
    // den dieser PR angefasst hat.
    const zuFrueh = await sign(recordId, "customer");
    expect(zuFrueh.status).toBe(400);
    expect((zuFrueh.data as any).message).toContain("kann nur");
    expect((zuFrueh.data as any).error).not.toBe("RECORD_DELETED");

    // Und der regulaere Weg funktioniert weiterhin.
    expect((await sign(recordId, "employee")).status).toBe(200);
    expect((await sign(recordId, "customer")).status).toBe(200);
    expect((await recordRow(recordId)).status).toBe("completed");
  });

  it("(d) Rennen: gleichzeitige Unterschrift und LN-Korrektur bleiben konsistent", async () => {
    const customerId = await newCustomer("race");
    const apptId = await createAndDocument(customerId, workdays[2], "11:00");
    const recordId = await createRecord(customerId, [apptId]);

    const [signRes, delRes] = await Promise.all([
      sign(recordId, "employee"),
      apiDelete(`/api/service-records/${recordId}`),
    ]);

    const row = await recordRow(recordId);

    // Beide Reihenfolgen sind zulaessig, und BEIDE koennen zu einem geloeschten
    // Nachweis MIT Unterschrift fuehren — naemlich wenn die Unterschrift zuerst
    // committet und die Loeschung danach laeuft. Das ist kein Fehler: die
    // Unterschrift wurde gueltig gegeben, der Nachweis erst danach korrigiert.
    //
    // Die Invariante ist enger und haengt am ERGEBNIS des Sign-Aufrufs:
    // was abgewiesen wurde, darf nicht geschrieben sein — und was durchlief,
    // muss geschrieben sein. Alles andere waere ein halber Zustand.
    if (signRes.status === 200) {
      expect(row.employeeSignatureData, "erfolgreiche Unterschrift muss geschrieben sein").not.toBeNull();
      expect(row.status).toBe("employee_signed");
    } else {
      expect(
        row.employeeSignatureData,
        "abgewiesene Unterschrift darf NICHTS geschrieben haben",
      ).toBeNull();
      expect(row.status).toBe("pending");
      // Wurde sie wegen der Loeschung abgewiesen, muss der Grund stimmen.
      if (row.deletedAt !== null) {
        expect([404, 409]).toContain(signRes.status);
        if (signRes.status === 409) {
          expect((signRes.data as any).error).toBe("RECORD_DELETED");
        }
      }
    }
    // Und die Loeschung selbst ist entweder durchgelaufen oder sauber abgewiesen.
    if (delRes.status !== 200) {
      expect([403, 409]).toContain(delRes.status);
      expect(row.deletedAt).toBeNull();
    }
  });
});
