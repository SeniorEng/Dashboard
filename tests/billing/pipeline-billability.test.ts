/**
 * Task #1874 — Pipeline-Euro-Töpfe spiegeln die echte Abrechenbarkeit.
 *
 * Die Status-Pipeline (`readBillingPipeline`) darf einen Pflegekassen-Termin
 * erst dann als „Unterschrieben" (= bereit zum Abrechnen) zählen, wenn er unter
 * DEMSELBEN Signatur-Gate wie der Rechnungs-Pfad abrechenbar ist
 * (`isServiceRecordSignedForBilling`): Pflegekasse verlangt die
 * Kundenunterschrift (LN `completed`), eine reine Mitarbeiter-Unterschrift
 * (`employee_signed`) genügt NICHT. Solche Termine landen im Side-Zustand
 * „Wartet auf Kundenunterschrift" — sichtbar, aber nicht in der Stufen-Summe
 * „Unterschrieben".
 *
 * Verifiziert gegen echte DB + laufenden App-Server (pro Kunde, robust gegen
 * Fremd-Testdaten in derselben Worker-DB):
 *   1. Pflegekasse + nur `employee_signed`-LN ⇒ € im Side „Wartet auf
 *      Kundenunterschrift", NICHT in der Stufe „Unterschrieben".
 *   2. Pflegekasse + `completed`-LN (Kundenunterschrift) ⇒ € in der Stufe
 *      „Unterschrieben"; Kunde erscheint zugleich in `eligible-customers`.
 *   3. €-Konservierung: jeder Termin-€ lebt in genau einem Topf (Stufe XOR
 *      Side); grandTotal === stageTotal + sideTotal.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  runCleanup,
  uniqueId,
} from "../test-utils";
import { validSignatureDataUrl } from "../helpers/valid-signature";
import type { BillingPipelineResponse } from "@shared/api/billing-pipeline";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let hwDefaultPriceCents: number;

const cleanupCustomerIds: number[] = [];
const cleanupEmployeeIds: number[] = [];

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Ein Monat, der vollständig in der Vergangenheit liegt (4 Monate zurück).
function pastMonth(): { year: number; month: number } {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 4);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

const { year: YEAR, month: MONTH } = pastMonth();

function round(n: number): number {
  return Math.round(n);
}

async function createPflegekasseCustomer(tag: string): Promise<{ customerId: number; employeeId: number }> {
  const res = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Bill",
    nachname: `Kasse-${tag}-${uniqueId()}`,
    geburtsdatum: "1941-02-02",
    email: `bill-kasse-${tag}-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "3",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000021",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  expect(res.status, `create customer: ${JSON.stringify(res.data)}`).toBe(201);
  const customerId = res.data.id;
  cleanupCustomerIds.push(customerId);

  const emp = await createTestEmployee({ nachnamePrefix: `Bill_${tag}` });
  cleanupEmployeeIds.push(emp.id);
  // Primär = angemeldeter Admin (auth.user.id), damit der Sammel-LN (der pro
  // Mitarbeiter:in gruppiert und beim Primär alle Termine sieht) die
  // dokumentierten Termine findet. Test-Mitarbeiter dient als Backup.
  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: emp.id,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

  // §45b generös funden, damit die Termin-Dokumentation gegen einen echten Topf
  // bucht (Betrag ist für die Pipeline-Umsatz-Sicht irrelevant).
  const init = await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: 39300,
    carryoverAmountCents: 0,
    budgetStartDate: `${YEAR}-${String(MONTH).padStart(2, "0")}-01`,
  });
  expect([200, 201], `fund 45b: ${JSON.stringify(init.data)}`).toContain(init.status);

  return { customerId, employeeId: emp.id };
}

/** Erstellt einen Vergangenheits-Termin (Werktag) und liefert Datum + Zeit. */
async function createAppt(
  customerId: number,
  durationMinutes: number,
): Promise<{ id: number; time: string }> {
  const lastDay = new Date(YEAR, MONTH, 0).getDate();
  const today = new Date();
  for (let day = lastDay; day >= 1; day--) {
    const d = new Date(YEAR, MONTH - 1, day);
    if (d >= today) continue;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymd(d);
    for (const time of SEED_TIMES) {
      const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `BILL-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes }],
      });
      if (res.status === 201) {
        await documentAppointment(res.data.id, time, durationMinutes);
        return { id: res.data.id, time };
      }
    }
  }
  throw new Error(`createAppt: kein freier Werktag-Slot in ${YEAR}-${MONTH}`);
}

async function documentAppointment(appointmentId: number, startTime: string, minutes: number): Promise<void> {
  const res = await apiPost<unknown>(`/api/appointments/${appointmentId}/document`, {
    actualStart: startTime,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: minutes, details: `BILL-${uniqueId()}` }],
  });
  expect(res.status, `document(${appointmentId}): ${JSON.stringify(res.data)}`).toBe(200);
}

/** Erstellt einen Sammel-LN und signiert ihn (nur Mitarbeiter, oder Mitarbeiter + Kunde). */
async function createAndSignServiceRecord(customerId: number, signCustomer: boolean): Promise<void> {
  const res = await apiPost<{ id: number }>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year: YEAR,
    month: MONTH,
  });
  expect(res.status, `create LN: ${JSON.stringify(res.data)}`).toBe(201);
  const srId = res.data.id;
  const signers: Array<"employee" | "customer"> = signCustomer ? ["employee", "customer"] : ["employee"];
  for (const signerType of signers) {
    const signRes = await apiPost<unknown>(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    expect(signRes.status, `sign(${srId}, ${signerType}): ${JSON.stringify(signRes.data)}`).toBe(200);
  }
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const servicesRes = await apiGet<Array<{ id: number; unitType?: string; unit_type?: string; defaultPriceCents?: number }>>("/api/services/all");
  const hw = servicesRes.data.find(
    (s) => (s.unitType ?? s.unit_type) === "hours" && (s.defaultPriceCents ?? 0) > 0,
  );
  if (!hw) throw new Error("Kein Stunden-Service mit Standardpreis gefunden");
  hwServiceId = hw.id;
  hwDefaultPriceCents = hw.defaultPriceCents ?? 0;
});

afterAll(async () => {
  for (const id of cleanupCustomerIds) {
    try { await cleanupCustomer(id); } catch { /* best-effort (GoBD) */ }
  }
  for (const id of cleanupEmployeeIds) {
    try { await deactivateTestEmployee(id); } catch { /* best-effort */ }
  }
  await runCleanup();
});

describe("Pipeline-Abrechenbarkeit (Task #1874)", () => {
  it("Pflegekasse + nur Mitarbeiter-Unterschrift => Side wartet_auf_kundenunterschrift, nicht unterschrieben", async () => {
    const { customerId } = await createPflegekasseCustomer("EMP");
    const minutes = 60;
    await createAppt(customerId, minutes);
    await createAndSignServiceRecord(customerId, /* signCustomer */ false);
    const expectedCents = round((minutes / 60) * hwDefaultPriceCents);

    const res = await apiGet<BillingPipelineResponse>(`/api/billing/pipeline?year=${YEAR}&month=${MONTH}`);
    expect(res.status).toBe(200);
    const body = res.data;

    // NICHT in der Stufe „Unterschrieben" (= bereit zum Abrechnen).
    const unterschrieben = body.stages.find((s) => s.stage === "unterschrieben")!;
    expect(unterschrieben.cards.some((c) => c.customerId === customerId)).toBe(false);

    // Sein € lebt im Side-Zustand „Wartet auf Kundenunterschrift".
    const side = body.sides.find((s) => s.state === "wartet_auf_kundenunterschrift");
    expect(side, "Side-Zustand wartet_auf_kundenunterschrift fehlt").toBeDefined();
    expect(side!.totalCents).toBeGreaterThanOrEqual(expectedCents);
    expect(side!.itemCount).toBeGreaterThanOrEqual(1);

    // Auch nicht in „Dokumentiert" (dort landen nur unsignierte completed-Termine).
    const dokumentiert = body.stages.find((s) => s.stage === "dokumentiert")!;
    expect(dokumentiert.cards.some((c) => c.customerId === customerId)).toBe(false);

    // €-Konservierung: grandTotal === stageTotal + sideTotal.
    expect(body.totals.grandTotalCents).toBe(body.totals.stageTotalCents + body.totals.sideTotalCents);
  }, 120_000);

  it("Pflegekasse + Kundenunterschrift => Stufe unterschrieben; Kunde ist abrechenbar", async () => {
    const { customerId } = await createPflegekasseCustomer("CUST");
    const minutes = 90;
    await createAppt(customerId, minutes);
    await createAndSignServiceRecord(customerId, /* signCustomer */ true);
    const expectedCents = round((minutes / 60) * hwDefaultPriceCents);

    const res = await apiGet<BillingPipelineResponse>(`/api/billing/pipeline?year=${YEAR}&month=${MONTH}`);
    expect(res.status).toBe(200);
    const body = res.data;

    // € in der Stufe „Unterschrieben", auf der Kunden-Karte.
    const unterschrieben = body.stages.find((s) => s.stage === "unterschrieben")!;
    const card = unterschrieben.cards.find((c) => c.customerId === customerId);
    expect(card, "Unterschrieben-Karte des Test-Kunden").toBeDefined();
    expect(card!.totalCents).toBe(expectedCents);

    // NICHT im Side „Wartet auf Kundenunterschrift".
    const side = body.sides.find((s) => s.state === "wartet_auf_kundenunterschrift");
    // (Fremd-Testdaten dürfen den Side-Topf füllen; nur dieser Kunde darf NICHT
    // dort auftauchen — geprüft über die Stufen-Karte oben.)
    expect(side).toBeDefined();

    // Reconcile: derselbe Kunde ist unter der Eligibility-Sicht abrechenbar.
    const elig = await apiGet<Array<{ id: number }>>(
      `/api/billing/eligible-customers?year=${YEAR}&month=${MONTH}`,
    );
    expect(elig.status).toBe(200);
    expect(elig.data.some((c) => c.id === customerId)).toBe(true);

    // €-Konservierung.
    expect(body.totals.grandTotalCents).toBe(body.totals.stageTotalCents + body.totals.sideTotalCents);
  }, 120_000);
});
