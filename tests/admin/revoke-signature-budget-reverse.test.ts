/**
 * Task #70-FINDING — `POST /api/admin/revoke-signature/appointment/:id`
 * dreht die Budget-Buchung zurück.
 *
 * Der Befund: Die Route stellte denselben Zustand her wie
 * `POST /api/appointments/:id/reopen` und der LN-Korrekturweg (Signatur weg,
 * Status `documenting`), aber OHNE Budget-Reverse — die dritte Kopie derselben
 * Frage, und die einzige, die dabei Geld liegen ließ.
 *
 * Warum das eine **stille Unterbuchung** ist und nicht bloß eine Karteileiche:
 * der Dokumentations-Pfad übernimmt beim erneuten Abschluss eine vorhandene,
 * nicht-stornierte Buchung, statt neu zu buchen. Die alte, zu NIEDRIGE Buchung
 * blieb also stehen und die Aufwärts-Korrektur landete nie im Topf — ohne jede
 * Spur im Audit-Log.
 *
 * Der scharfe Fall ist deshalb (b): erst klein dokumentieren, Unterschrift
 * stornieren, GRÖSSER neu dokumentieren, und dann die Netto-Summe des Topfes
 * gegen den NEUEN Wert prüfen. Fehlt der Reverse, steht dort weiterhin der
 * alte, kleinere Betrag — der Test fällt mit einer Zahl, die den Geldschaden
 * direkt benennt.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, auditLog, budgetTransactions } from "@shared/schema";
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
let customerId: number;
let workday: string;
const cleanupApptIds: number[] = [];

/**
 * Netto-Buchungsstand des Termins. VORZEICHEN: ein Verbrauch
 * (`transaction_type = 'consumption'`) ist NEGATIV, die Gegenbuchung
 * (`reversal`) positiv — `netCents` ist also 0, wenn sauber storniert wurde,
 * und je kleiner (negativer), desto mehr ist verbraucht.
 */
async function budgetState(appointmentId: number): Promise<{
  netCents: number;
  reversals: number;
  consumptions: number;
}> {
  const rows = await db
    .select({
      transactionType: budgetTransactions.transactionType,
      amountCents: budgetTransactions.amountCents,
    })
    .from(budgetTransactions)
    .where(eq(budgetTransactions.appointmentId, appointmentId));
  return {
    netCents: rows.reduce((sum, r) => sum + r.amountCents, 0),
    reversals: rows.filter((r) => r.transactionType === "reversal").length,
    consumptions: rows.filter((r) => r.transactionType === "consumption").length,
  };
}

async function createAndDocument(time: string, minutes: number): Promise<number> {
  const createRes = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date: workday,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: minutes }],
    assignedEmployeeId: auth.user.id,
  });
  if (createRes.status !== 201) {
    throw new Error(`Termin-Anlage fehlgeschlagen: ${createRes.status} ${JSON.stringify(createRes.data)}`);
  }
  cleanupApptIds.push(createRes.data.id);
  await documentWith(createRes.data.id, time, minutes);
  return createRes.data.id;
}

async function documentWith(appointmentId: number, time: string, minutes: number): Promise<void> {
  const docRes = await apiPost<any>(`/api/appointments/${appointmentId}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: minutes, details: "Revoke-Budget-Test" }],
  });
  if (docRes.status !== 200) {
    throw new Error(`Dokumentation fehlgeschlagen: ${docRes.status} ${JSON.stringify(docRes.data)}`);
  }
}

/**
 * Die Route verlangt eine eigene `signature_data` am Termin. Im Normalfall
 * liegen die menschlichen Unterschriften am Leistungsnachweis; eine Signatur
 * direkt am Termin stammt aus dem Budget-Backfill (Task #876) oder aus dem
 * Direkt-Signaturpfad. Fuer den Test wird sie gesetzt, ohne einen
 * Leistungsnachweis anzulegen — sonst griffe die Lock-Pruefung.
 */
async function putDirectSignature(appointmentId: number): Promise<void> {
  await db
    .update(appointments)
    .set({
      signatureData: "data:image/png;base64,TEST-REVOKE",
      signatureHash: "test-hash",
      signedAt: new Date(),
      signedByUserId: auth.user.id,
    })
    .where(eq(appointments.id, appointmentId));
}

async function revoke(appointmentId: number): Promise<{ status: number; data: any }> {
  return apiPost<any>(`/api/admin/revoke-signature/appointment/${appointmentId}`, {
    reason: "Test: Unterschrift stornieren und neu dokumentieren",
  });
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;

  const cust = await createTestCustomer({ nachname: `REVOKE-${uniqueId()}` });
  customerId = cust.id as number;
  await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });

  // Werktag im Vormonat — vermeidet Kollisionen mit anderen Testdaten des Tages.
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const y = prev.getFullYear();
  const m = prev.getMonth() + 1;
  for (let day = 2; day <= 28; day++) {
    const cur = new Date(y, m - 1, day);
    if (cur.getDay() !== 0 && cur.getDay() !== 6) {
      workday = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      break;
    }
  }
});

afterAll(async () => {
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch { /* schon weg */ }
  }
  await cleanupCustomer(customerId);
});

describe("admin/audit revoke-signature — Budget-Reverse (Task #70-FINDING)", () => {
  it(
    "(a) storniert die Buchung des Termins: Gegenbuchung vorhanden, Netto 0",
    async () => {
      const apptId = await createAndDocument("07:00", 30);
      const before = await budgetState(apptId);
      expect(before.consumptions, "Dokumentation muss gebucht haben").toBeGreaterThan(0);
      expect(before.netCents, "vor dem Storno steht der Verbrauch im Topf").toBeLessThan(0);

      await putDirectSignature(apptId);
      const res = await revoke(apptId);
      expect(res.status, JSON.stringify(res.data)).toBe(200);

      const after = await budgetState(apptId);
      expect(after.reversals, "es MUSS eine Gegenbuchung geben").toBeGreaterThan(0);
      expect(after.netCents, "netto darf nichts mehr gebucht sein").toBe(0);
    },
    60_000,
  );

  it(
    "(b) DER GELDFALL: nach Storno + GRÖSSERER Neudokumentation trägt der Topf den NEUEN Wert, nicht den alten",
    async () => {
      const apptId = await createAndDocument("08:00", 30);
      const small = (await budgetState(apptId)).netCents;
      expect(small, "die kleine Dokumentation muss gebucht sein").toBeLessThan(0);

      await putDirectSignature(apptId);
      expect((await revoke(apptId)).status).toBe(200);

      // Aufwaerts-Korrektur: doppelte Dauer.
      await documentWith(apptId, "08:00", 60);
      const after = await budgetState(apptId);

      // Ohne den Reverse uebernaehme der Dokumentations-Pfad die alte,
      // nicht-stornierte Buchung — `after.netCents` bliebe auf `small` stehen
      // und die zusaetzliche halbe Stunde waere nie verbraucht worden.
      // Verbrauch ist negativ: "mehr verbraucht" heisst KLEINER.
      expect(
        after.netCents,
        `Unterbuchung: Topf traegt ${after.netCents} statt des groesseren neuen Verbrauchs (alt war ${small})`,
      ).toBeLessThan(small);
      expect(after.reversals, "die alte Buchung muss gegengebucht sein").toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "(c) der Termin ist danach wieder in Bearbeitung und traegt keine Signatur mehr",
    async () => {
      const apptId = await createAndDocument("09:00", 30);
      await putDirectSignature(apptId);
      expect((await revoke(apptId)).status).toBe(200);

      const [row] = await db
        .select({
          status: appointments.status,
          signatureData: appointments.signatureData,
          signedAt: appointments.signedAt,
        })
        .from(appointments)
        .where(eq(appointments.id, apptId));
      expect(row.status).toBe("documenting");
      expect(row.signatureData).toBeNull();
      expect(row.signedAt).toBeNull();
    },
    60_000,
  );

  it(
    "(d) das Audit-Log macht die Rueckbuchung sichtbar (sonst ist der Vorgang nicht rekonstruierbar)",
    async () => {
      const apptId = await createAndDocument("10:00", 30);
      await putDirectSignature(apptId);
      expect((await revoke(apptId)).status).toBe(200);

      const [entry] = await db
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "appointment"), eq(auditLog.entityId, apptId), eq(auditLog.action, "appointment_revoked")))
        .orderBy(desc(auditLog.id))
        .limit(1);

      expect(entry, "Audit-Eintrag muss existieren").toBeTruthy();
      const meta = entry.metadata as Record<string, unknown>;
      expect(meta.previousStatus).toBe("completed");
      expect(meta.reversedTransactions, "Zahl der Rueckbuchungen gehoert in den Eintrag").toBeGreaterThan(0);
      expect(meta.hadSignature).toBe(true);
    },
    60_000,
  );
});
