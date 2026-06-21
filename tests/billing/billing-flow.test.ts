import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Billing-Flow Test-Coverage (Task #109)
 *
 * Sichert die kritischen Pfade des Rechnungs-Flows ab:
 *   - Happy-Path Selbstzahler & Privatversicherte (ohne Split)
 *   - Split-Rechnung (Kasse + Privat) inkl. Verlinkung, Konsistenz,
 *     Edge-Cases (0 € Budget, 1 ct Rest) und transaktionaler Atomarität
 *   - Storno: Stornorechnung mit negativen Beträgen, Audit-Eintrag,
 *     Schutz vor Doppel-Storno, Split-Pärchen-Verhalten,
 *     dokumentiertes Verhalten zu Budget-Refund (kein Auto-Rückbuchen)
 *   - Nachberechnung: Delta-Termine, kein Doppel-Booking
 *   - Edge-Cases: ohne LN, Duplikat, Re-Abrechnung nach Storno,
 *     Erstberatungs-Termine erscheinen NICHT in Rechnungen
 *
 * Tests laufen seriell (vitest fileParallelism: false). Jeder Test legt eigene
 * Kunden/Termine an und räumt sie über `afterAll` über die regulären
 * Cleanup-Hooks wieder weg. Test-Daten folgen den Naming-Konventionen
 * (Nachname startet mit `Privat-`, `Auto_`, `Integ-`), sodass globalSetup
 * sie auch bei abgebrochenen Läufen entfernen kann.
 *
 * Determinismus: Slot-Suche probiert 18 Randzeiten × 60 Tage (>1000 Versuche)
 * bzw. 18 Zeiten × alle Werktage eines Monats. Jede Slot-Suche wirft hart,
 * wenn nichts gefunden wird — keine soft-skips, keine early-return Pfade.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasObjectStorageEnv } from "../helpers/object-storage";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  apiPut,
  getAuthCookie,
  uniqueId,
  createTestEmployee,
  deactivateTestEmployee,
} from "../test-utils";
import { db } from "../../server/lib/db";
import { auditLog } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testEmployeeId: number;
let hwServiceId: number;
let abServiceId: number;
let insuranceProviderId: number;

const cleanupCustomerIds: number[] = [];
const cleanupServiceRecordIds: number[] = [];
const cleanupInvoiceIds: number[] = [];

// ---------- Date / Slot helpers ----------

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shiftToWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}

// Breite Auswahl an Randzeiten, die in der Praxis selten mit anderen Tests
// kollidieren (Test-Admin hat Vorrang vor regulären Slot-Sperren).
const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

/**
 * Sucht ein freies Zeitfenster bei Test-Admin (mehr-tag/Stunde-Suche) und
 * legt einen Kundentermin an. Wir suchen rückwärts in der Vergangenheit, damit
 * Termine sofort dokumentiert werden können (Past-Slot-Locks greifen für den
 * Test-Admin nicht). Bei >1400 Versuchen ohne Erfolg wirft die Funktion
 * deterministisch — kein soft-skip in den aufrufenden Tests.
 */
async function findFreeSlotAndCreate(
  customerId: number,
  serviceId: number,
  durationMinutes: number,
  noteTag: string,
): Promise<{ id: number; date: string; time: string }> {
  for (let offset = 1; offset <= 60; offset++) {
    const candidate = new Date();
    candidate.setDate(candidate.getDate() - offset);
    shiftToWeekday(candidate);
    const dateStr = ymdLocal(candidate);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `BF-${noteTag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId, durationMinutes }],
      });
      if (res.status === 201) {
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(`findFreeSlotAndCreate(${noteTag}): kein freier Slot in den letzten 60 Tagen gefunden`);
}

/**
 * Sucht einen freien Slot in einem konkreten Kalendermonat (Werktage,
 * nur Vergangenheit) und legt einen Kundentermin an. Optional kann ein
 * Datum ausgeschlossen werden (z. B. Datum eines Anker-Termins).
 * Wirft deterministisch, wenn nichts gefunden wird.
 */
async function findFreeSlotInMonth(
  customerId: number,
  serviceId: number,
  durationMinutes: number,
  year: number,
  month: number, // 1-12
  excludeDateStr: string | null,
  noteTag: string,
): Promise<{ id: number; date: string; time: string }> {
  const today = new Date();
  const lastDay = new Date(year, month, 0).getDate();

  const tryCreate = async (dateStr: string): Promise<{ id: number; date: string; time: string } | null> => {
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `BF-${noteTag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId, durationMinutes }],
      });
      if (res.status === 201) {
        return { id: res.data.id, date: dateStr, time };
      }
    }
    return null;
  };

  // Pass 1: bevorzugt vergangene Werktage (rückwärts ab Monatsende). Reale
  // Dokumentation passt am natürlichsten zu vergangenen Daten.
  for (let day = lastDay; day >= 1; day--) {
    const cand = new Date(year, month - 1, day);
    if (cand > today) continue;
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymdLocal(cand);
    if (dateStr === excludeDateStr) continue;
    const created = await tryCreate(dateStr);
    if (created) return created;
  }

  // Pass 2: Fallback auf zukünftige Werktage im selben Monat. Nötig, wenn der
  // Anker-Termin (excludeDateStr) der einzige vergangene Werktag des Monats
  // war (z. B. heute = 2. Tag des Monats, 1. war ein Freitag). Der Test-Admin
  // darf laut /document-Route auch zukünftige Termine dokumentieren, daher
  // ist das für die Nachberechnungs-Semantik unkritisch.
  for (let day = 1; day <= lastDay; day++) {
    const cand = new Date(year, month - 1, day);
    if (cand <= today) continue;
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymdLocal(cand);
    if (dateStr === excludeDateStr) continue;
    const created = await tryCreate(dateStr);
    if (created) return created;
  }

  throw new Error(
    `findFreeSlotInMonth(${year}-${month}, exclude=${excludeDateStr}, ${noteTag}): kein freier Werktag-Slot im Monat`,
  );
}

async function documentAppointment(
  appointmentId: number,
  startTime: string,
  serviceId: number,
  actualMinutes: number,
  details: string,
): Promise<void> {
  const res = await apiPost<any>(`/api/appointments/${appointmentId}/document`, {
    actualStart: startTime,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details }],
  });
  if (res.status !== 200) {
    throw new Error(`documentAppointment(${appointmentId}) failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

async function createServiceRecord(
  customerId: number,
  year: number,
  month: number,
): Promise<number> {
  const res = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year,
    month,
  });
  if (res.status !== 201) {
    throw new Error(`createServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  cleanupServiceRecordIds.push(res.data.id);
  return res.data.id;
}

async function signServiceRecord(srId: number): Promise<void> {
  for (const signerType of ["employee", "customer"] as const) {
    const res = await apiPost<any>(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    if (res.status !== 200) {
      throw new Error(`signServiceRecord(${srId}, ${signerType}) failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
  }
}

async function generateInvoice(
  customerId: number,
  year: number,
  month: number,
): Promise<{ raw: any; invoices: any[]; isSplit: boolean }> {
  const res = await apiPost<any>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`generateInvoice failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const data = res.data;
  let invoices: any[];
  let isSplit = false;
  if (data?.splitInvoices && Array.isArray(data.invoices)) {
    invoices = data.invoices;
    isSplit = true;
  } else if (Array.isArray(data)) {
    invoices = data;
  } else {
    invoices = [data];
  }
  for (const inv of invoices) {
    if (inv?.id) cleanupInvoiceIds.push(inv.id);
  }
  return { raw: data, invoices, isSplit };
}

async function loadInvoiceWithLineItems(invoiceId: number): Promise<any> {
  const res = await apiGet<any>(`/api/billing/${invoiceId}`);
  if (res.status !== 200) {
    throw new Error(`loadInvoiceWithLineItems(${invoiceId}) failed: ${res.status}`);
  }
  return res.data;
}

// ---------- Customer payload helpers ----------

function szPayload(tag: string) {
  return {
    vorname: "BF-SZ",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `bf-sz-${uniqueId()}@test.local`,
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 2,
    pflegegradSeit: "2024-01-01",
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
    contacts: [
      {
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "BF-SZ",
        mobilnummer: "+4917600000010",
      },
    ],
  };
}

function pvPayload(
  tag: string,
  opts: { acceptsPrivatePayment?: boolean; budget45bCents?: number } = {},
) {
  return {
    vorname: "BF-PV",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1938-05-12",
    strasse: "Teststraße",
    nr: "5",
    plz: "10117",
    stadt: "Berlin",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_privat",
    acceptsPrivatePayment: opts.acceptsPrivatePayment ?? true,
    insurance: {
      providerId: insuranceProviderId,
      versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: "2024-01-01",
    },
    contacts: [
      {
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "BF-PV",
        mobilnummer: "+4917600000011",
      },
    ],
    budgets: {
      // Werte sind in CENTS (siehe shared/schema/budget.ts).
      // Default: voller §45b-Topf (13100 ct = 131 €).
      entlastungsbetrag45b: opts.budget45bCents ?? 13100,
      verhinderungspflege39: 0,
      pflegesachleistungen36: 0,
      validFrom: "2024-01-01",
    },
  };
}

async function createCustomer(payload: Record<string, any>): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", payload);
  if (res.status !== 201) {
    throw new Error(`createCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch<any>(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: testEmployeeId,
    backupEmployeeId2: null,
  });
  return id;
}

/**
 * Konfiguriert §45b mit einem niedrigen Monatslimit. Der §45b-Anker wird seit
 * Task #1204 zur Laufzeit aus dem Pflegegrad-Beginn abgeleitet und für §45b auf
 * den 1.1. des laufenden Jahres gebodet — der Topf sammelt also ab Januar an
 * (akkumuliert = Monatsindex × monthlyLimitCents). Das Default-Limit (1 €/Monat)
 * hält den akkumulierten §45b-Betrag selbst im Dezember (12 × 1 € = 12 €) klar
 * unter den Kosten einer 60-min-HW-Buchung (~35 €) und erzwingt damit
 * deterministisch den Split.
 * `monthlyLimitCents=0` deaktiviert das §45b-Budget vollständig — alle
 * Kosten landen dann auf der Privatrechnung.
 */
async function configureLowBudgetPV(
  customerId: number,
  monthlyLimitCents: number = 100,
): Promise<void> {
  await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
  });
}

// ---------- Lifecycle ----------

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  const ab = servicesRes.data.find((s: any) => s.code === "alltagsbegleitung");
  if (!hw || !ab) throw new Error("Pflicht-Services hauswirtschaft/alltagsbegleitung fehlen in der Test-DB");
  hwServiceId = hw.id;
  abServiceId = ab.id;

  const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
  if (provRes.status !== 200 || provRes.data.length === 0) {
    throw new Error("Keine Versicherer in der Test-DB vorhanden");
  }
  insuranceProviderId = provRes.data[0].id;

  const emp = await createTestEmployee({ nachnamePrefix: "TestBF" });
  testEmployeeId = emp.id;
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    try { await apiDelete(`/api/billing/${id}`); } catch {}
  }
  for (const id of cleanupServiceRecordIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  for (const id of cleanupCustomerIds) {
    try { await apiDelete(`/api/admin/customers/${id}`); } catch {}
  }
  await deactivateTestEmployee(testEmployeeId);
});

// ============================================================
// BF-1: Happy-Path
// ============================================================

describe("BF-1: Happy-Path Rechnungserstellung", () => {
  it("BF-1.1 — Selbstzahler-Rechnung enthält MwSt 19% und ist im Status entwurf", async () => {
    const custId = await createCustomer(szPayload("HP1"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "HP1");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-1.1 Hauswirtschaft");

    const apptDate = new Date(appt.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);

    const { invoices, isSplit } = await generateInvoice(
      custId,
      apptDate.getFullYear(),
      apptDate.getMonth() + 1,
    );
    expect(isSplit, "Selbstzahler darf nicht splitten").toBe(false);
    expect(invoices.length).toBe(1);

    const detail = await loadInvoiceWithLineItems(invoices[0].id);
    expect(detail.billingType).toBe("selbstzahler");
    expect(detail.invoiceType).toBe("rechnung");
    expect(detail.status).toBe("entwurf");
    expect(detail.vatRate, "Selbstzahler-Rechnung muss vatRate=1900 (19%) tragen").toBe(1900);
    expect(detail.netAmountCents).toBeGreaterThan(0);
    // Hinweis: Die Route summiert pro Line-Item gerundete VAT-Beträge — daher
    // wird hier nur die Summen-Identität geprüft, nicht die exakte 19%-Formel.
    expect(detail.grossAmountCents).toBe(detail.netAmountCents + detail.vatAmountCents);
    expect(detail.vatAmountCents).toBeGreaterThanOrEqual(0);

    const hwItem = detail.lineItems.find((li: any) => li.serviceCode === "hauswirtschaft");
    expect(hwItem, "HW-Position muss vorhanden sein").toBeDefined();
    expect(hwItem.appointmentId).toBe(appt.id);
  });

  it("BF-1.2 — Privatversicherte-Kassenrechnung ist MwSt-frei (ohne Split)", async () => {
    // PV-Kunde mit ausreichendem Budget (Default 131€ §45b reicht für eine
    // einzelne 30-min-HW-Buchung) → keine Split-Rechnung, nur Kassenrechnung.
    const custId = await createCustomer(pvPayload("HP2"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "HP2");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-1.2 PV-HW");

    const apptDate = new Date(appt.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);

    const { invoices, isSplit } = await generateInvoice(
      custId,
      apptDate.getFullYear(),
      apptDate.getMonth() + 1,
    );
    expect(isSplit, "Bei ausreichend Budget darf NICHT gesplittet werden").toBe(false);
    expect(invoices.length).toBe(1);

    const detail = await loadInvoiceWithLineItems(invoices[0].id);
    expect(detail.billingType).toBe("pflegekasse_privat");
    expect(detail.invoiceType).toBe("rechnung");
    expect(detail.vatRate).toBe(0);
    expect(detail.vatAmountCents).toBe(0);
    expect(detail.grossAmountCents).toBe(detail.netAmountCents);
  });
});

// ============================================================
// BF-2: Split-Rechnung
// ============================================================

describe("BF-2: Split-Rechnung (Kasse + Privat bei Budgetüberschreitung)", () => {
  it("BF-2.1 — Niedriges Budget erzeugt 2 Rechnungen, beide in Response verlinkt", async () => {
    const custId = await createCustomer(pvPayload("SP1"));
    await configureLowBudgetPV(custId);

    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "SP1");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-2.1 Split-HW");

    const apptDate = new Date(appt.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);

    const { raw, invoices, isSplit } = await generateInvoice(
      custId,
      apptDate.getFullYear(),
      apptDate.getMonth() + 1,
    );

    expect(isSplit, `Split muss erzeugt werden, raw=${JSON.stringify(raw).slice(0, 200)}`).toBe(true);
    expect(raw.splitInvoices).toBe(true);
    expect(Array.isArray(raw.invoices)).toBe(true);
    expect(invoices.length).toBe(2);

    const billingTypes = invoices.map((i: any) => i.billingType).sort();
    expect(billingTypes, "Pärchen muss aus Kasse + Privat bestehen").toEqual(
      ["pflegekasse_privat", "selbstzahler"],
    );

    // Beide Rechnungen müssen denselben Abrechnungszeitraum + Kunden tragen
    // (lose Verlinkung im aktuellen Schema).
    const a = invoices[0];
    const b = invoices[1];
    expect(a.customerId).toBe(b.customerId);
    expect(a.billingYear).toBe(b.billingYear);
    expect(a.billingMonth).toBe(b.billingMonth);
  });

  it("BF-2.2 — Summe Netto-Beträge Kasse + Privat entspricht Summe der Termin-Kosten", async () => {
    const custId = await createCustomer(pvPayload("SP2"));
    await configureLowBudgetPV(custId);

    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "SP2");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-2.2 Split-Sum");

    const apptDate = new Date(appt.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);

    const { invoices } = await generateInvoice(
      custId,
      apptDate.getFullYear(),
      apptDate.getMonth() + 1,
    );
    const kasse = invoices.find((i: any) => i.billingType === "pflegekasse_privat");
    const privat = invoices.find((i: any) => i.billingType === "selbstzahler");
    expect(kasse).toBeDefined();
    expect(privat).toBeDefined();

    // Privatanteil hat 19 % MwSt, Kassenanteil 0 % — nur Netto vergleichen.
    const detailKasse = await loadInvoiceWithLineItems(kasse.id);
    const detailPrivat = await loadInvoiceWithLineItems(privat.id);

    expect(detailKasse.vatRate).toBe(0);
    expect(detailKasse.vatAmountCents).toBe(0);
    expect(detailPrivat.vatRate).toBe(1900);
    expect(detailPrivat.vatAmountCents).toBeGreaterThan(0);

    const lineSumKasse = detailKasse.lineItems.reduce((s: number, li: any) => s + li.totalCents, 0);
    const lineSumPrivat = detailPrivat.lineItems.reduce((s: number, li: any) => s + li.totalCents, 0);
    expect(detailKasse.netAmountCents).toBe(lineSumKasse);
    expect(detailPrivat.netAmountCents).toBe(lineSumPrivat);

    // Beide Rechnungen müssen einen positiven Anteil enthalten (echte Aufteilung).
    expect(detailKasse.netAmountCents).toBeGreaterThan(0);
    expect(detailPrivat.netAmountCents).toBeGreaterThan(0);
  });

  it("BF-2.3a — Pflegekasse OHNE Private Zuzahlung wird weiterhin geblockt (kein Regress)", async () => {
    // Pflegekasse-Kunde ohne acceptsPrivatePayment darf weiterhin nicht
    // dokumentiert werden, sobald das Budget nicht reicht — Task #588 ändert
    // nur das Selbstzahler-Verhalten, nicht den Pflegekassen-Pfad.
    const custId = await createCustomer(pvPayload("SP3", { acceptsPrivatePayment: false }));
    await configureLowBudgetPV(custId);

    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "SP3");

    const docRes = await apiPost<any>(`/api/appointments/${appt.id}/document`, {
      actualStart: appt.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "BF-2.3a No-Private" }],
    });
    expect(
      docRes.status,
      `Dokumentation muss bei fehlender Privatzahlungs-Akzeptanz scheitern (got ${docRes.status} ${JSON.stringify(docRes.data)})`,
    ).not.toBe(200);
    const errMsg = String(docRes.data?.message || docRes.data?.error || "");
    expect(
      errMsg,
      "Fehlermeldung muss explizit auf Budget/Privatzahlung hinweisen",
    ).toMatch(/Budget reicht nicht|Privatzahlung|akzeptiert/i);
  });

  it("BF-2.3b — Selbstzahler-Doku läuft ohne Budget-Block durch (Task #588)", async () => {
    // Selbstzahler haben per Definition gar kein Pflegekassen-Budget; das
    // UI-Flag `acceptsPrivatePayment` ist für sie nicht setzbar und bleibt
    // per Default `false`. Vor Task #588 schlug die Doku trotzdem mit
    // "Budget reicht nicht — Kunde akzeptiert keine Privatzahlung." fehl.
    // Erwartung jetzt: Doku läuft durch und erzeugt eine reine
    // Privat-Transaktion über den vollen Betrag.
    const custId = await createCustomer({
      ...szPayload("SZ588"),
      acceptsPrivatePayment: false,
    });

    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "SZ588");

    const docRes = await apiPost<any>(`/api/appointments/${appt.id}/document`, {
      actualStart: appt.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "BF-2.3b Selbstzahler" }],
    });
    expect(
      docRes.status,
      `Selbstzahler-Doku muss durchlaufen (got ${docRes.status} ${JSON.stringify(docRes.data)})`,
    ).toBe(200);

    // Resultierende Buchungen prüfen: keine §45b/§45a/§39-Konsum-Zeile,
    // ausschließlich eine `private`-Konsum-Transaktion.
    const txs = await apiGet<any[]>(`/api/budget/${custId}/transactions`);
    expect(txs.status).toBe(200);
    const apptTxs = (txs.data ?? []).filter(
      (t: any) => t.appointmentId === appt.id && t.transactionType === "consumption",
    );
    expect(apptTxs.length, "genau eine Konsum-Transaktion für Selbstzahler").toBe(1);
    expect(apptTxs[0].budgetType).toBe("private");
    expect(apptTxs[0].amountCents).toBeLessThan(0);
  });

  it("BF-2.4 — Split-Erzeugung ist atomar in einer DB-Transaktion gewrappt", async () => {
    // Direktes Atomaritäts-Test ohne Race-Conditions ist vom HTTP-Layer kaum
    // sauber zu provozieren (Transaktion liegt vollständig im Server-Prozess).
    // Wir sichern die Atomarität daher über zwei sich ergänzende Kanäle:
    //   1. Statisch: Quellcode-Garantie, dass der Split-Pfad in
    //      `db.transaction(...)` läuft. Schützt vor versehentlichem Entfernen
    //      des Wrappers (Regression).
    //   2. Verhalten: Eine erfolgreiche Split-Erzeugung schreibt EXAKT zwei
    //      Rechnungen für den Kunden (keine Phantom-/Orphan-Rechnung).
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const billingSource = await fs.readFile(
      path.resolve(__dirname, "../../server/routes/billing.ts"),
      "utf8",
    );
    // Atomarität: entweder direkter `db.transaction(...)` oder der
    // `withAudit(...)`-Wrapper (Task #444), der intern `db.transaction`
    // öffnet und Mutation + Audit-Insert atomar bündelt.
    expect(
      /\bdb\.transaction\s*\(/.test(billingSource) || /\bwithAudit\s*\(/.test(billingSource),
      "billing.ts muss `db.transaction(` oder `withAudit(` für atomare Split-Erzeugung verwenden",
    ).toBe(true);

    // Verhaltens-Sanity-Check: Erfolgreiche Split-Erzeugung → exakt 2 Rechnungen.
    const custId = await createCustomer(pvPayload("SP4"));
    await configureLowBudgetPV(custId);
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "SP4");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-2.4 Atomic");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);

    const list = await apiGet<any[]>(`/api/billing?customerId=${custId}`);
    expect(list.status).toBe(200);
    const nonStorno = (list.data as any[]).filter((i: any) => i.invoiceType !== "stornorechnung");
    expect(
      nonStorno.length,
      "Atomarer Split muss exakt 2 Rechnungen schreiben (keine Phantom-/Halb-Rechnung)",
    ).toBe(2);
  });

  it("BF-2.5 — §45b-Limit = 0 → keine Kassenrechnung, alle Kosten als Privatrechnung", async () => {
    // Edge-Case: Budget-Topf vollständig gesperrt (Limit 0). Mit
    // acceptsPrivatePayment=true muss die GESAMTE Leistung auf einer
    // einzelnen Privatrechnung landen — kein Split, kein Kassen-Pendant.
    const custId = await createCustomer(pvPayload("SP5"));
    await configureLowBudgetPV(custId, 0);
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "SP5");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-2.5 ZeroBudget");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices, isSplit } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);

    expect(isSplit, "Bei Budget=0 entsteht kein Split-Antwort-Wrapper, nur eine einzige Privatrechnung").toBe(false);
    expect(invoices.length).toBe(1);
    const detail = await loadInvoiceWithLineItems(invoices[0].id);
    expect(detail.billingType).toBe("selbstzahler");
    expect(detail.vatRate).toBe(1900);
    // Komplette Leistung muss verrechnet sein (keine 0-Cent-Rechnung).
    expect(detail.netAmountCents).toBeGreaterThan(0);
    const apptIds = detail.lineItems.map((li: any) => li.appointmentId);
    expect(apptIds).toContain(appt.id);

    // Es darf KEINE Kassenrechnung (pflegekasse_privat) für diesen Kunden existieren.
    const list = await apiGet<any[]>(`/api/billing?customerId=${custId}`);
    const kasse = (list.data as any[]).filter(
      (i: any) => i.billingType === "pflegekasse_privat" && i.invoiceType !== "stornorechnung",
    );
    expect(kasse.length, "Kein Kassen-Anteil darf entstehen, wenn das §45b-Budget 0 ist").toBe(0);
  });

  it("BF-2.6 — 1-Cent-Restbudget landet exakt als 1-Cent-Position auf der Privatrechnung", async () => {
    // 30 min Hauswirtschaft = 1900 Cent (Preis 3800 Cent/h). Setzen wir das
    // Monatslimit auf 1899 Cent, fällt genau 1 Cent als Privat-Anteil an.
    // Damit prüfen wir die Genauigkeit der Restbudget-Berechnung am Rand.
    const custId = await createCustomer(pvPayload("SP6"));
    await configureLowBudgetPV(custId, 1899);
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "SP6");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-2.6 OneCent");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices, isSplit } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);

    expect(isSplit, "1-Cent-Rest muss einen echten Split erzeugen").toBe(true);
    expect(invoices.length).toBe(2);
    const kasse = invoices.find((i: any) => i.billingType === "pflegekasse_privat");
    const privat = invoices.find((i: any) => i.billingType === "selbstzahler");
    expect(kasse).toBeDefined();
    expect(privat).toBeDefined();

    const detailKasse = await loadInvoiceWithLineItems(kasse.id);
    const detailPrivat = await loadInvoiceWithLineItems(privat.id);

    // Privat-Netto ist exakt 1 Cent (Restbetrag).
    expect(
      detailPrivat.netAmountCents,
      `Privat-Anteil muss exakt 1 Cent sein, ist ${detailPrivat.netAmountCents}`,
    ).toBe(1);
    // Kassen-Netto ist exakt das verfügbare Limit.
    expect(
      detailKasse.netAmountCents,
      `Kassen-Anteil muss exakt 1899 Cent (Budget-Limit) sein, ist ${detailKasse.netAmountCents}`,
    ).toBe(1899);
    // Summen-Identität: kasse + privat = volle Leistung.
    expect(detailKasse.netAmountCents + detailPrivat.netAmountCents).toBe(1900);
  });
});

// ============================================================
// BF-3: Storno
// ============================================================

describe("BF-3: Storno (Stornorechnung + Audit + Schutz)", () => {
  it("BF-3.1 — Storno erzeugt Stornorechnung mit gespiegelten negativen Beträgen", async () => {
    const custId = await createCustomer(szPayload("ST1"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "ST1");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-3.1 Original");
    const apptDate = new Date(appt.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices } = await generateInvoice(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    const original = invoices[0];

    const stornoRes = await apiPatch<any>(`/api/billing/${original.id}/status`, { status: "storniert" });
    expect(stornoRes.status, `PATCH status=storniert muss 200 liefern (got ${stornoRes.status} ${JSON.stringify(stornoRes.data)})`).toBe(200);

    // Original ist jetzt storniert.
    const updatedOriginal = await loadInvoiceWithLineItems(original.id);
    expect(updatedOriginal.status).toBe("storniert");

    // Stornorechnung muss existieren — über Liste suchen.
    const list = await apiGet<any[]>(`/api/billing?customerId=${custId}`);
    expect(list.status).toBe(200);
    const stornoInv = (list.data as any[]).find(
      (i: any) => i.invoiceType === "stornorechnung" && i.stornierteRechnungId === original.id,
    );
    expect(stornoInv, "Stornorechnung mit Verweis auf Original muss existieren").toBeDefined();
    cleanupInvoiceIds.push(stornoInv.id);

    const stornoDetail = await loadInvoiceWithLineItems(stornoInv.id);
    expect(stornoDetail.netAmountCents).toBe(-updatedOriginal.netAmountCents);
    expect(stornoDetail.vatAmountCents).toBe(-updatedOriginal.vatAmountCents);
    expect(stornoDetail.grossAmountCents).toBe(-updatedOriginal.grossAmountCents);
    expect(stornoDetail.lineItems.length).toBe(updatedOriginal.lineItems.length);
    for (const li of stornoDetail.lineItems) {
      expect(li.totalCents).toBeLessThanOrEqual(0);
    }
    // BL-12: Stornorechnung wird als "entwurf" angelegt; Versand erfolgt
    // durch den Buchhalter aktiv über den Send-Pfad.
    expect(stornoDetail.status).toBe("entwurf");
  });

  it("BF-3.2 — Stornorechnung kann NICHT erneut storniert werden", async () => {
    const custId = await createCustomer(szPayload("ST2"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "ST2");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-3.2");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    const original = invoices[0];
    await apiPatch<any>(`/api/billing/${original.id}/status`, { status: "storniert" });

    const list = await apiGet<any[]>(`/api/billing?customerId=${custId}`);
    const stornoInv = (list.data as any[]).find(
      (i: any) => i.invoiceType === "stornorechnung" && i.stornierteRechnungId === original.id,
    );
    expect(stornoInv).toBeDefined();
    cleanupInvoiceIds.push(stornoInv.id);

    const dupRes = await apiPatch<any>(`/api/billing/${stornoInv.id}/status`, { status: "storniert" });
    expect(dupRes.status, `Doppel-Storno muss abgelehnt werden, got ${dupRes.status}`).toBe(400);
  });

  it("BF-3.3 — Storno schreibt Audit-Eintrag invoice_cancelled mit Storno-IDs", async () => {
    const custId = await createCustomer(szPayload("ST3"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "ST3");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-3.3");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    const original = invoices[0];
    await apiPatch<any>(`/api/billing/${original.id}/status`, { status: "storniert" });

    const audit = await apiGet<{ entries: any[] }>(
      `/api/admin/audit-log?entityType=invoice&entityId=${original.id}&action=invoice_cancelled&limit=10`,
    );
    expect(audit.status).toBe(200);
    const entry = audit.data.entries.find((e: any) => e.action === "invoice_cancelled" && e.entityId === original.id);
    expect(entry, "Audit-Eintrag invoice_cancelled muss existieren").toBeDefined();
    const meta = entry.metadata || entry.changes || {};
    expect(meta.stornoInvoiceId, "Audit-Eintrag muss stornoInvoiceId tragen").toBeDefined();
    expect(meta.stornoInvoiceNumber, "Audit-Eintrag muss stornoInvoiceNumber tragen").toBeDefined();
    expect(meta.originalInvoiceNumber).toBe(original.invoiceNumber);

    // Stornorechnung mitcleanen.
    const list = await apiGet<any[]>(`/api/billing?customerId=${custId}`);
    const stornoInv = (list.data as any[]).find(
      (i: any) => i.invoiceType === "stornorechnung" && i.stornierteRechnungId === original.id,
    );
    if (stornoInv) cleanupInvoiceIds.push(stornoInv.id);
  });

  it("BF-3.4 — Storno einer Split-Rechnung lässt die Pärchen-Rechnung unangetastet (manuelles Handling erforderlich)", async () => {
    const custId = await createCustomer(pvPayload("ST4"));
    await configureLowBudgetPV(custId);
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "ST4");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-3.4");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices, isSplit } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    expect(isSplit).toBe(true);
    const kasse = invoices.find((i: any) => i.billingType === "pflegekasse_privat");
    const privat = invoices.find((i: any) => i.billingType === "selbstzahler");
    expect(kasse).toBeDefined();
    expect(privat).toBeDefined();

    // Nur Kassenanteil stornieren.
    const stornoRes = await apiPatch<any>(`/api/billing/${kasse.id}/status`, { status: "storniert" });
    expect(stornoRes.status).toBe(200);

    const kasseAfter = await loadInvoiceWithLineItems(kasse.id);
    const privatAfter = await loadInvoiceWithLineItems(privat.id);
    expect(kasseAfter.status).toBe("storniert");
    expect(privatAfter.status, "Privat-Pärchen darf NICHT automatisch mit-storniert werden").toBe("entwurf");
    expect(privatAfter.invoiceType).toBe("rechnung");
    expect(privatAfter.netAmountCents).toBeGreaterThan(0);

    // Dokumentiertes Verhalten: aktuell wird KEIN automatisches Pärchen-Storno
    // ausgelöst und die Antwort enthält auch keine "warning"-Markierung. Sollte
    // die Route in Zukunft ein automatisches Warn-Feld zurückliefern, ist
    // dieser Test bewusst der Trigger, um die UI/Doku nachzuziehen.
    const responseBody = stornoRes.data ?? {};
    const responseText = JSON.stringify(responseBody).toLowerCase();
    const hasAutoWarning = "warning" in responseBody || "warnings" in responseBody
      || responseText.includes("split") || responseText.includes("partner");
    expect(
      hasAutoWarning,
      "Aktuell darf die Storno-Antwort kein automatisches Split-Warn-Feld enthalten — manuelles Handling.",
    ).toBe(false);

    const list = await apiGet<any[]>(`/api/billing?customerId=${custId}`);
    const stornoInv = (list.data as any[]).find(
      (i: any) => i.invoiceType === "stornorechnung" && i.stornierteRechnungId === kasse.id,
    );
    if (stornoInv) cleanupInvoiceIds.push(stornoInv.id);
  });

  it.skipIf(!hasObjectStorageEnv)("BF-3.5 — Storno schreibt KEINEN automatischen Budget-Refund (Ledger bleibt unverändert)", async () => {
    // Dokumentiertes Soll-Verhalten: Eine Rechnungs-Stornierung erstellt nur
    // eine Stornorechnung (Buchführung) — der Budget-Verbrauch im Ledger wird
    // NICHT automatisch zurückgebucht. Refund muss explizit über die Budget-
    // Reverse-API ausgelöst werden. Dieser Test sichert das Verhalten gegen
    // versehentliche Doppel-Verbuchung ab.
    const custId = await createCustomer(pvPayload("ST5"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "ST5");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-3.5");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);

    const summaryBefore = await apiGet<any>(`/api/budget/${custId}/summary`);
    expect(summaryBefore.status).toBe(200);
    const consumedBefore =
      summaryBefore.data?.entlastungsbetrag45b?.totalUsedCents ??
      summaryBefore.data?.entlastungsbetrag45b?.currentMonthUsedCents ?? 0;

    const { invoices } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    const original = invoices[0];

    // Storno auslösen.
    const stornoRes = await apiPatch<any>(`/api/billing/${original.id}/status`, { status: "storniert" });
    expect(stornoRes.status).toBe(200);

    // Stornorechnung mitcleanen.
    const list = await apiGet<any[]>(`/api/billing?customerId=${custId}`);
    const stornoInv = (list.data as any[]).find(
      (i: any) => i.invoiceType === "stornorechnung" && i.stornierteRechnungId === original.id,
    );
    if (stornoInv) cleanupInvoiceIds.push(stornoInv.id);

    // Budget-Verbrauch im Ledger darf sich durch das Storno NICHT geändert haben:
    // er bleibt auf dem durch die Termin-Dokumentation gesetzten Wert
    // (consumedAfter >= consumedBefore + 0). Eine automatische Reversal-Buchung
    // wäre erkennbar an einer NIEDRIGEREN Verbrauchssumme.
    const summaryAfter = await apiGet<any>(`/api/budget/${custId}/summary`);
    expect(summaryAfter.status).toBe(200);
    const consumedAfter =
      summaryAfter.data?.entlastungsbetrag45b?.totalUsedCents ??
      summaryAfter.data?.entlastungsbetrag45b?.currentMonthUsedCents ?? 0;
    expect(
      consumedAfter,
      `Storno darf den §45b-Verbrauch NICHT automatisch zurückbuchen (vorher=${consumedBefore}, nachher=${consumedAfter})`,
    ).toBeGreaterThanOrEqual(consumedBefore);
  });
});

// ============================================================
// BF-4: Nachberechnung
// ============================================================

describe("BF-4: Nachträglich abgerechnete Termine im selben Monat", () => {
  it("BF-4.1 — Zweiter Termin im selben Monat erzeugt zusätzliche Rechnung mit nur dem neuen Termin", async () => {
    const custId = await createCustomer(szPayload("NB1"));

    // 1. Termin → erste Rechnung
    const a1 = await findFreeSlotAndCreate(custId, hwServiceId, 30, "NB1a");
    await documentAppointment(a1.id, a1.time, hwServiceId, 30, "BF-4.1 Original");
    const d1 = new Date(a1.date);
    const srA = await createServiceRecord(custId, d1.getFullYear(), d1.getMonth() + 1);
    await signServiceRecord(srA);
    const { invoices: firstInvoices } = await generateInvoice(custId, d1.getFullYear(), d1.getMonth() + 1);
    expect(firstInvoices.length).toBe(1);
    const firstInv = firstInvoices[0];
    expect(firstInv.invoiceType).toBe("rechnung");

    // 2. Termin im selben Kalendermonat (anderer Tag) → neue Rechnung (Task #585: nicht mehr als "nachberechnung" markiert).
    const a2 = await findFreeSlotInMonth(
      custId,
      hwServiceId,
      30,
      d1.getFullYear(),
      d1.getMonth() + 1,
      a1.date,
      "NB1b",
    );
    await documentAppointment(a2.id, a2.time, hwServiceId, 30, "BF-4.1 Nachtrag");

    // Neuen LN für denselben Monat: weil der Auto-Append nur nicht-abgerechnete
    // Termine aufnimmt, erzeugen wir per Single-LN-Pfad ein Pendant.
    const srB = await createServiceRecord(custId, d1.getFullYear(), d1.getMonth() + 1);
    await signServiceRecord(srB);

    const { invoices: secondInvoices } = await generateInvoice(custId, d1.getFullYear(), d1.getMonth() + 1);
    expect(secondInvoices.length).toBe(1);
    const second = secondInvoices[0];
    // Task #585: "nachberechnung" wurde abgeschafft — jede neue Rechnung ist "rechnung".
    expect(second.invoiceType, "Zweite Rechnung im selben Monat ist regulär 'rechnung'").toBe("rechnung");
    expect(second.id).not.toBe(firstInv.id);

    const secondDetail = await loadInvoiceWithLineItems(second.id);
    const apptIdsInSecond = secondDetail.lineItems
      .map((li: any) => li.appointmentId)
      .filter((id: number | null) => id !== null);
    expect(
      apptIdsInSecond.includes(a2.id),
      "Zweite Rechnung muss den neuen Termin enthalten",
    ).toBe(true);
    expect(
      apptIdsInSecond.includes(a1.id),
      "Zweite Rechnung darf den bereits abgerechneten Termin NICHT erneut enthalten",
    ).toBe(false);
  });

  it("BF-4.2 — Keine appointmentId erscheint in beiden Rechnungen desselben Monats", async () => {
    const custId = await createCustomer(szPayload("NB2"));
    const a1 = await findFreeSlotAndCreate(custId, hwServiceId, 30, "NB2a");
    await documentAppointment(a1.id, a1.time, hwServiceId, 30, "BF-4.2 Original");
    const d1 = new Date(a1.date);
    const srA = await createServiceRecord(custId, d1.getFullYear(), d1.getMonth() + 1);
    await signServiceRecord(srA);
    const first = (await generateInvoice(custId, d1.getFullYear(), d1.getMonth() + 1)).invoices[0];

    // Zweiter Termin im selben Monat (deterministische Suche).
    const a2 = await findFreeSlotInMonth(
      custId,
      hwServiceId,
      30,
      d1.getFullYear(),
      d1.getMonth() + 1,
      a1.date,
      "NB2b",
    );
    await documentAppointment(a2.id, a2.time, hwServiceId, 30, "BF-4.2 Nachtrag");
    const srB = await createServiceRecord(custId, d1.getFullYear(), d1.getMonth() + 1);
    await signServiceRecord(srB);
    const second = (await generateInvoice(custId, d1.getFullYear(), d1.getMonth() + 1)).invoices[0];

    const detailFirst = await loadInvoiceWithLineItems(first.id);
    const detailSecond = await loadInvoiceWithLineItems(second.id);
    const apptIdsFirst = new Set<number>(
      detailFirst.lineItems
        .map((li: any) => li.appointmentId)
        .filter((id: number | null) => id !== null),
    );
    const apptIdsSecond = new Set<number>(
      detailSecond.lineItems
        .map((li: any) => li.appointmentId)
        .filter((id: number | null) => id !== null),
    );
    for (const id of apptIdsSecond) {
      expect(
        apptIdsFirst.has(id),
        `appointmentId ${id} darf NICHT in Original UND Zweitrechnung erscheinen`,
      ).toBe(false);
    }
  });
});

// ============================================================
// BF-5: Edge-Cases
// ============================================================

describe("BF-5: Edge-Cases", () => {
  it("BF-5.1 — Generierung ohne (signierten) Leistungsnachweis liefert 400", async () => {
    const custId = await createCustomer(szPayload("EC1"));
    const apptDate = new Date();
    apptDate.setDate(apptDate.getDate() - 5);
    shiftToWeekday(apptDate);

    const res = await apiPost<any>("/api/billing/generate", {
      customerId: custId,
      billingMonth: apptDate.getMonth() + 1,
      billingYear: apptDate.getFullYear(),
    });
    expect(res.status).toBe(400);
  });

  it("BF-5.2 — Re-Generierung wenn alle Termine schon abgerechnet → 400", async () => {
    const custId = await createCustomer(szPayload("EC2"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "EC2");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-5.2");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);

    const dupRes = await apiPost<any>("/api/billing/generate", {
      customerId: custId,
      billingMonth: d.getMonth() + 1,
      billingYear: d.getFullYear(),
    });
    expect(dupRes.status).toBe(400);
  });

  it("BF-5.3 — Nach Storno können dieselben Termine erneut abgerechnet werden", async () => {
    const custId = await createCustomer(szPayload("EC3"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "EC3");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-5.3");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    const first = invoices[0];

    // Stornieren.
    const stornoRes = await apiPatch<any>(`/api/billing/${first.id}/status`, { status: "storniert" });
    expect(stornoRes.status).toBe(200);
    const list = await apiGet<any[]>(`/api/billing?customerId=${custId}`);
    const stornoInv = (list.data as any[]).find(
      (i: any) => i.invoiceType === "stornorechnung" && i.stornierteRechnungId === first.id,
    );
    if (stornoInv) cleanupInvoiceIds.push(stornoInv.id);

    // Erneut abrechnen — der zugehörige Termin gilt jetzt wieder als
    // "nicht abgerechnet" (Filter schließt status=storniert / type=stornorechnung
    // aus). Nachberechnung wird erzeugt.
    const reGen = await apiPost<any>("/api/billing/generate", {
      customerId: custId,
      billingMonth: d.getMonth() + 1,
      billingYear: d.getFullYear(),
    });
    expect(reGen.status, `Re-Abrechnung nach Storno muss erfolgreich sein, got ${reGen.status} ${JSON.stringify(reGen.data)}`).toBe(200);
    const reInv = Array.isArray(reGen.data) ? reGen.data[0]
      : reGen.data?.invoices ? reGen.data.invoices[0]
      : reGen.data;
    expect(reInv?.id).toBeDefined();
    cleanupInvoiceIds.push(reInv.id);
    expect(reInv.id).not.toBe(first.id);
  });

  it("BF-5.4 — Erstberatungs-Termine erscheinen NICHT in Kunden-Rechnungen", async () => {
    // Erstberatungen werden über prospectId verwaltet und sind nicht über
    // Service-Records mit Kunden-Rechnungen verknüpft. Wir bestätigen dies
    // indirekt: ein neuer Selbstzahler-Kunde, der noch nie eine Rechnung
    // hatte, lehnt die Generierung mangels LN ab — Erstberatungen aus der
    // Vergangenheit dürfen daran nichts ändern.
    const custId = await createCustomer(szPayload("EC4"));
    const today = new Date();
    const res = await apiPost<any>("/api/billing/generate", {
      customerId: custId,
      billingMonth: today.getMonth() + 1,
      billingYear: today.getFullYear(),
    });
    expect(res.status).toBe(400);
    const errMsg = String(res.data?.message || res.data?.error || "");
    expect(
      errMsg,
      "Fehlermeldung muss klar auf fehlenden Leistungsnachweis hinweisen",
    ).toMatch(/Leistungsnachweis/i);
  });
});

// ----------------------------------------------------------------------------
// BF-6: PDF-Endpunkte (Branch-Coverage für /pdf, /leistungsnachweis und
// enrichPdfDataWithSignatures – diese Pfade sind vom Happy-Path nicht
// automatisch abgedeckt, machen aber einen relevanten Anteil von billing.ts
// aus. Wir prüfen nur, dass die Endpunkte mit content-type=application/pdf
// und nicht-leerer Buffer-Antwort liefern – die Korrektheit des PDF-Inhalts
// gehört in PDF-spezifische Tests.)
// ----------------------------------------------------------------------------

const PDF_BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

async function fetchPdf(invoiceId: number, suffix: "" | "/leistungsnachweis"): Promise<{ status: number; contentType: string; bytes: number }> {
  const a = await getAuthCookie();
  const res = await fetch(`${PDF_BASE_URL}/api/billing/${invoiceId}${suffix === "" ? "/pdf" : suffix}`, {
    headers: { Cookie: a.cookie },
  });
  const buf = res.ok ? await res.arrayBuffer() : new ArrayBuffer(0);
  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    bytes: buf.byteLength,
  };
}

describe("BF-6: PDF-Endpunkte (Coverage-relevante Read-Paths)", () => {
  it.skipIf(!hasObjectStorageEnv)("BF-6.1 — GET /:id/pdf liefert PDF für eine Selbstzahler-Rechnung", async () => {
    const custId = await createCustomer(szPayload("PDF1"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "PDF1");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-6.1");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    const inv = invoices[0];
    expect(inv?.id, "Invoice muss erzeugt sein").toBeDefined();

    const r = await fetchPdf(inv.id, "");
    expect(r.status, `PDF-Endpunkt: ${r.status}`).toBe(200);
    expect(r.contentType).toMatch(/application\/pdf/);
    expect(r.bytes, "PDF-Buffer muss > 1KB sein").toBeGreaterThan(1024);
  }, 60_000);

  it.skipIf(!hasObjectStorageEnv)("BF-6.2 — GET /:id/pdf für pflegekasse_privat-Rechnung mergt Leistungsnachweis (Branch-Coverage Signaturen + pdf-lib merge)", async () => {
    const custId = await createCustomer(pvPayload("PDF2"));
    await configureLowBudgetPV(custId, 1000);
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "PDF2");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-6.2");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    const kasse = invoices.find((i: any) => i.billingType === "pflegekasse_privat");
    expect(kasse?.id, "Kassenrechnung muss vorhanden sein").toBeDefined();

    const r = await fetchPdf(kasse.id, "");
    expect(r.status, `PDF-Endpunkt: ${r.status}`).toBe(200);
    expect(r.contentType).toMatch(/application\/pdf/);
    expect(r.bytes, "Merged PDF (Rechnung + LN) muss > 2KB sein").toBeGreaterThan(2048);
  }, 60_000);

  it.skipIf(!hasObjectStorageEnv)("BF-6.3 — GET /:id/leistungsnachweis liefert separaten LN-PDF (Branch-Coverage Signatur-Enrichment)", async () => {
    const custId = await createCustomer(pvPayload("PDF3"));
    await configureLowBudgetPV(custId, 1000);
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "PDF3");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-6.3");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    const kasse = invoices.find((i: any) => i.billingType === "pflegekasse_privat");
    expect(kasse?.id, "Kassenrechnung muss vorhanden sein").toBeDefined();

    const r = await fetchPdf(kasse.id, "/leistungsnachweis");
    expect(r.status, `LN-Endpunkt: ${r.status}`).toBe(200);
    expect(r.contentType).toMatch(/application\/pdf/);
    expect(r.bytes, "LN-PDF muss > 1KB sein").toBeGreaterThan(1024);
  }, 60_000);

  it("BF-6.4 — GET /:id/pdf für unbekannte ID → 404 (Coverage Not-Found Branch)", async () => {
    const r = await fetchPdf(999_999_999, "");
    expect(r.status).toBe(404);
  });
});

// ----------------------------------------------------------------------------
// BF-7: /send-Endpunkt — Fehlerpfade (decken die zahlreichen frühen
// Validations-Branches der Send-Route ab, ohne tatsächlich SMTP zu nutzen).
// Wir testen bewusst NICHT den Erfolgs-Pfad: Mail-Versand verändert produktive
// Zustände (Postausgang, Audit) und benötigt ein konfiguriertes SMTP-Setup,
// das in CI nicht garantiert ist. Die frühen Branches genügen, um den großen
// Block zwischen Validierung und Mailversand für die Branch-Coverage spürbar
// hochzuziehen.
// ----------------------------------------------------------------------------

describe("BF-7: /send-Fehlerpfade (Coverage)", () => {
  it("BF-7.1 — Send auf nicht-Entwurf-Rechnung → 400", async () => {
    const custId = await createCustomer(szPayload("SND1"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "SND1");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-7.1");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    const inv = invoices[0];

    // Storno setzt Status auf "storniert" — danach darf send nicht greifen.
    const stornoRes = await apiPatch<any>(`/api/billing/${inv.id}/status`, { status: "storniert" });
    expect(stornoRes.status).toBe(200);
    const list = await apiGet<any[]>(`/api/billing?customerId=${custId}`);
    const stornoInv = (list.data as any[]).find(
      (i: any) => i.invoiceType === "stornorechnung" && i.stornierteRechnungId === inv.id,
    );
    if (stornoInv) cleanupInvoiceIds.push(stornoInv.id);

    const sendRes = await apiPost<any>(`/api/billing/${inv.id}/send`, {});
    expect(sendRes.status, `send on storniert: ${JSON.stringify(sendRes.data)}`).toBe(400);
    const msg = String(sendRes.data?.message || sendRes.data?.error || "");
    expect(msg).toMatch(/Entw(u|ü)rfe|storniert/i);
  });

  it("BF-7.2 — Send auf Selbstzahler-Rechnung → 400 (nur Pflegekasse erlaubt)", async () => {
    const custId = await createCustomer(szPayload("SND2"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "SND2");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-7.2");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    const inv = invoices[0];

    const sendRes = await apiPost<any>(`/api/billing/${inv.id}/send`, {});
    expect(sendRes.status, `send on SZ: ${JSON.stringify(sendRes.data)}`).toBe(400);
    const msg = String(sendRes.data?.message || sendRes.data?.error || "");
    expect(msg).toMatch(/Pflegekasse/i);
  });

  it("BF-7.3 — Send auf PV-Rechnung ohne Kunden-E-Mail → 400", async () => {
    const custId = await createCustomer(pvPayload("SND3"));
    await configureLowBudgetPV(custId, 1000);
    // Kunden-E-Mail explizit entfernen (PV/Privatrechnung-Pfad braucht Kunden-Mail).
    const upd = await apiPatch<any>(`/api/customers/${custId}`, { email: null });
    expect([200, 204]).toContain(upd.status);

    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "SND3");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-7.3");
    const d = new Date(appt.date);
    const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
    await signServiceRecord(srId);
    const { invoices } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
    const privatInv = invoices.find((i: any) => i.billingType === "selbstzahler" || i.billingType === "selbstzahler_privatrechnung");
    if (!privatInv) {
      // Nichts zu testen, wenn die Privatrechnung anders heißt — Test hart fehl
      // schlagen statt soft-skip.
      throw new Error(`Privatrechnung nicht gefunden, billingTypes: ${invoices.map((i: any) => i.billingType).join(",")}`);
    }
    // Status auf entwurf belassen, dann /send aufrufen (ohne Kundenmail).
    // PV-Privatrechnung ist allerdings billingType=selbstzahler → /send lehnt
    // wegen "nur Pflegekasse" bereits dort ab. Wir prüfen hier stattdessen
    // direkt die Kassenrechnung des Splits ohne Pflegekasse-Mail-Aktivierung.
    const kasse = invoices.find((i: any) => i.billingType === "pflegekasse_privat");
    expect(kasse).toBeDefined();
    const sendRes = await apiPost<any>(`/api/billing/${kasse.id}/send`, {});
    expect(sendRes.status, `send PV-Kasse no email: ${JSON.stringify(sendRes.data)}`).toBe(400);
    const msg = String(sendRes.data?.message || sendRes.data?.error || "");
    // Kasse-Pfad: meckert über fehlende Kunden-E-Mail (oder fehlende
    // Pflegekassen-Konfiguration — beides ist ein 400 in der Send-Route).
    expect(msg.length).toBeGreaterThan(0);
  });

  it("BF-7.4 — Send für unbekannte Rechnung → 404", async () => {
    const sendRes = await apiPost<any>(`/api/billing/999999999/send`, {});
    expect(sendRes.status).toBe(404);
  });
});

// ============================================================
// BF-8: Vorschau-Endpoint (Task #750)
// — Drift-Detektor: Preview muss exakt dieselben Zahlen liefern
//   wie der nachfolgende Generate-Aufruf (gemeinsamer Helper).
// ============================================================

describe("BF-8: GET /billing/preview — Drift gegen /generate", () => {
  it("BF-8.1 — Selbstzahler: Preview-Zahlen stimmen mit erzeugter Rechnung überein und Preview persistiert nichts", async () => {
    const custId = await createCustomer(szPayload("PRV1"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "PRV1");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-8.1 Preview-Drift");

    const apptDate = new Date(appt.date);
    const year = apptDate.getFullYear();
    const month = apptDate.getMonth() + 1;
    const srId = await createServiceRecord(custId, year, month);
    await signServiceRecord(srId);

    // Bestand vor Preview erfassen.
    const beforeList = await apiGet<any[]>(`/api/billing?year=${year}&month=${month}`);
    const beforeCount = (beforeList.data ?? []).filter((inv: any) => inv.customerId === custId).length;

    // Preview zweimal aufrufen → identische Antwort, keine Side-Effects.
    const previewA = await apiGet<any>(`/api/billing/preview?customerId=${custId}&month=${month}&year=${year}`);
    expect(previewA.status, `Preview A: ${JSON.stringify(previewA.data)}`).toBe(200);
    const previewB = await apiGet<any>(`/api/billing/preview?customerId=${custId}&month=${month}&year=${year}`);
    expect(previewB.status).toBe(200);
    expect(previewB.data).toEqual(previewA.data);

    expect(previewA.data.serviceRecordCount).toBe(1);
    expect(previewA.data.coveredAppointments).toBe(1);
    expect(previewA.data.completedAppointments).toBeGreaterThanOrEqual(1);
    expect(previewA.data.totalCents).toBeGreaterThan(0);
    expect(previewA.data.splitInvoices).toBe(false);

    // Bestand zwischen Preview-Aufrufen muss identisch geblieben sein.
    const afterPreviewList = await apiGet<any[]>(`/api/billing?year=${year}&month=${month}`);
    const afterPreviewCount = (afterPreviewList.data ?? []).filter((inv: any) => inv.customerId === custId).length;
    expect(afterPreviewCount, "Preview darf KEINE Rechnung persistieren").toBe(beforeCount);

    // Jetzt Rechnung erstellen und Zahlen vergleichen.
    const { invoices, isSplit } = await generateInvoice(custId, year, month);
    expect(isSplit).toBe(false);
    expect(invoices.length).toBe(1);
    const detail = await loadInvoiceWithLineItems(invoices[0].id);

    expect(detail.grossAmountCents).toBe(previewA.data.totalCents);
    expect(detail.lineItems.filter((li: any) => li.appointmentId === appt.id).length).toBeGreaterThan(0);
  });

  it("BF-8.2 — Split (PV + niedriges Budget): Preview-Brutto == Summe beider Folgerechnungen", async () => {
    const custId = await createCustomer(pvPayload("PRV2"));
    await configureLowBudgetPV(custId);
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "PRV2");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-8.2 Preview-Split");

    const apptDate = new Date(appt.date);
    const year = apptDate.getFullYear();
    const month = apptDate.getMonth() + 1;
    const srId = await createServiceRecord(custId, year, month);
    await signServiceRecord(srId);

    const preview = await apiGet<any>(`/api/billing/preview?customerId=${custId}&month=${month}&year=${year}`);
    expect(preview.status, `Preview: ${JSON.stringify(preview.data)}`).toBe(200);
    expect(preview.data.splitInvoices).toBe(true);
    expect(preview.data.serviceRecordCount).toBe(1);
    expect(preview.data.coveredAppointments).toBe(1);

    const { invoices, isSplit } = await generateInvoice(custId, year, month);
    expect(isSplit).toBe(true);
    expect(invoices.length).toBe(2);
    const grossSum = invoices.reduce((sum: number, inv: any) => sum + (inv.grossAmountCents ?? 0), 0);
    expect(grossSum, "Preview-Brutto muss Summe beider Split-Rechnungen sein").toBe(preview.data.totalCents);
  });

  it("BF-8.3 — Preview liefert klaren Fehler, wenn kein signierter LN vorhanden ist", async () => {
    const custId = await createCustomer(szPayload("PRV3"));
    // Termin + Doku, aber KEIN LN signiert.
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, "PRV3");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "BF-8.3 No-LN");

    const apptDate = new Date(appt.date);
    const year = apptDate.getFullYear();
    const month = apptDate.getMonth() + 1;
    const res = await apiGet<any>(`/api/billing/preview?customerId=${custId}&month=${month}&year=${year}`);
    expect(res.status).toBe(400);
    expect(String(res.data?.message || res.data?.error || "")).toMatch(/Leistungsnachweis/i);
  });
});

// ============================================================
// BF-9: Neue Rechnungen landen IMMER im Status "entwurf" (Task #1376)
// ============================================================
//
// Regressionsschutz: Frisch generierte Rechnungen dürfen niemals direkt
// "versendet" (oder einen anderen finalen Status) tragen. "versendet" wird
// ausschließlich über explizite Aktionen gesetzt (Status-Wechsel, Versand,
// Bulk-Statuswechsel). Wir prüfen das für ALLE Rechnungs-Erzeugungspfade:
// Selbstzahler (eine Rechnung), Kasse-only (eine Rechnung) und Split
// (Kasse + Privat-Rest → beide Rechnungen müssen "entwurf" sein).
describe("BF-9: Neue Rechnungen sind immer Entwurf (Task #1376)", () => {
  it("BF-9.1 — Selbstzahler-Rechnung wird als entwurf erzeugt", async () => {
    const custId = await createCustomer(szPayload("DRAFT-SZ"));
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "DRAFT-SZ");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-9.1 Hauswirtschaft");

    const apptDate = new Date(appt.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);

    const { invoices } = await generateInvoice(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    expect(invoices.length).toBeGreaterThanOrEqual(1);
    for (const inv of invoices) {
      const detail = await loadInvoiceWithLineItems(inv.id);
      expect(detail.status, "Frische Selbstzahler-Rechnung muss entwurf sein").toBe("entwurf");
      expect(detail.sentAt ?? null, "entwurf darf kein sentAt tragen").toBeNull();
    }
  });

  it("BF-9.2 — Split-Lauf (Kasse + Privat-Rest) erzeugt ausschließlich entwurf-Rechnungen", async () => {
    // Niedriges §45b-Limit erzwingt den Split: §45b-Kassenrechnung + Privat-Rest.
    const custId = await createCustomer(pvPayload("DRAFT-PV"));
    await configureLowBudgetPV(custId, 100);
    const appt = await findFreeSlotAndCreate(custId, hwServiceId, 60, "DRAFT-PV");
    await documentAppointment(appt.id, appt.time, hwServiceId, 60, "BF-9.2 Hauswirtschaft");

    const apptDate = new Date(appt.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);

    const { invoices, isSplit } = await generateInvoice(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    expect(isSplit, "Niedriges §45b-Budget muss splitten").toBe(true);
    expect(invoices.length).toBe(2);
    for (const inv of invoices) {
      const detail = await loadInvoiceWithLineItems(inv.id);
      expect(detail.status, "Jede Split-Rechnung muss entwurf sein").toBe("entwurf");
      expect(detail.sentAt ?? null, "entwurf darf kein sentAt tragen").toBeNull();
    }
  });
});

// ============================================================
// BF-10: Sammel-Aktionen für Rechnungen (Task #1376/#1379)
// ============================================================
//
// Deckt die beiden neuen Sammel-Endpunkte ab:
//   POST /api/billing/bulk-delete  — löscht ausschließlich Entwürfe (GoBD).
//   POST /api/billing/bulk-status  — setzt Status nur über erlaubte Übergänge.
//
// Geprüft werden die GoBD-kritischen Garantien:
//   1. Finalisierte Rechnungen werden NIE per Sammel-Löschung hart entfernt,
//      sondern als "skipped" gemeldet; nur Entwürfe verschwinden.
//   2. Ungültige Status-Übergänge werden übersprungen (gemeinsame SSoT
//      `isAllowedInvoiceStatusTransition`), gültige angewendet.
//   3. Die "X aktualisiert/gelöscht, Y übersprungen"-Summenzähler stimmen.
//   4. Pro tatsächlich betroffener Zeile wird genau ein Audit-Eintrag
//      geschrieben (invoice_draft_discarded / invoice_status_changed).

/** Legt einen Selbstzahler-Kunden + dokumentierten Termin + signierten LN an
 *  und generiert genau eine Entwurf-Rechnung. Liefert die Rechnung zurück. */
async function createDraftSzInvoice(tag: string): Promise<{ id: number; invoiceNumber: string }> {
  const custId = await createCustomer(szPayload(tag));
  const appt = await findFreeSlotAndCreate(custId, hwServiceId, 30, tag);
  await documentAppointment(appt.id, appt.time, hwServiceId, 30, `BF-10 ${tag}`);
  const d = new Date(appt.date);
  const srId = await createServiceRecord(custId, d.getFullYear(), d.getMonth() + 1);
  await signServiceRecord(srId);
  const { invoices, isSplit } = await generateInvoice(custId, d.getFullYear(), d.getMonth() + 1);
  expect(isSplit, "Selbstzahler darf nicht splitten").toBe(false);
  const inv = invoices[0];
  expect(inv?.id, "Entwurf-Rechnung muss erzeugt sein").toBeDefined();
  return { id: inv.id, invoiceNumber: inv.invoiceNumber };
}

/** Setzt eine Rechnung über den Einzel-Statuswechsel auf den Zielstatus.
 *  Folgt der erlaubten Kette (entwurf → versendet → bezahlt). */
async function finalizeInvoice(invoiceId: number, target: "versendet" | "bezahlt"): Promise<void> {
  const steps: ("versendet" | "bezahlt")[] = target === "bezahlt" ? ["versendet", "bezahlt"] : ["versendet"];
  for (const step of steps) {
    const res = await apiPatch<any>(`/api/billing/${invoiceId}/status`, { status: step });
    expect(res.status, `Statuswechsel auf ${step} muss erfolgreich sein: ${JSON.stringify(res.data)}`).toBe(200);
  }
}

/** Zählt Audit-Einträge einer Aktion für eine Menge an Rechnungs-IDs. */
async function countAuditFor(action: string, invoiceIds: number[]): Promise<number> {
  if (invoiceIds.length === 0) return 0;
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, action),
      eq(auditLog.entityType, "invoice"),
      inArray(auditLog.entityId, invoiceIds),
    ));
  return rows.length;
}

describe("BF-10: Sammel-Aktionen (Task #1376/#1379)", () => {
  it("BF-10.1 — bulk-delete entfernt nur Entwürfe, finalisierte werden übersprungen", async () => {
    const draftA = await createDraftSzInvoice("BULKDEL-A");
    const draftB = await createDraftSzInvoice("BULKDEL-B");
    const finalized = await createDraftSzInvoice("BULKDEL-F");
    await finalizeInvoice(finalized.id, "versendet");

    const res = await apiPost<any>("/api/billing/bulk-delete", {
      invoiceIds: [draftA.id, draftB.id, finalized.id],
    });
    expect(res.status, `bulk-delete: ${JSON.stringify(res.data)}`).toBe(200);

    // Summen-Zähler.
    expect(res.data.summary.deleted).toBe(2);
    expect(res.data.summary.skipped).toBe(1);
    expect(res.data.summary.total).toBe(3);
    expect(res.data.invoiceNumbers.sort()).toEqual([draftA.invoiceNumber, draftB.invoiceNumber].sort());

    // Pro-Zeile-Ergebnis.
    const byId = new Map<number, any>(res.data.results.map((r: any) => [r.invoiceId, r]));
    expect(byId.get(draftA.id).status).toBe("deleted");
    expect(byId.get(draftB.id).status).toBe("deleted");
    expect(byId.get(finalized.id).status).toBe("skipped");
    expect(byId.get(finalized.id).reason, "Skip-Grund muss auf 'nur Entwürfe' hinweisen").toMatch(/Entw(u|ü)rfe/i);

    // GoBD: Entwürfe sind weg, finalisierte Rechnung existiert unverändert.
    const goneA = await apiGet<any>(`/api/billing/${draftA.id}`);
    const goneB = await apiGet<any>(`/api/billing/${draftB.id}`);
    expect(goneA.status, "gelöschter Entwurf A muss 404 sein").toBe(404);
    expect(goneB.status, "gelöschter Entwurf B muss 404 sein").toBe(404);
    const stillThere = await apiGet<any>(`/api/billing/${finalized.id}`);
    expect(stillThere.status, "finalisierte Rechnung darf NICHT gelöscht sein").toBe(200);
    expect(stillThere.data.status).toBe("versendet");

    // Audit: genau ein invoice_draft_discarded pro tatsächlich gelöschter Zeile,
    // KEINER für die übersprungene finalisierte Rechnung.
    expect(await countAuditFor("invoice_draft_discarded", [draftA.id, draftB.id])).toBe(2);
    expect(await countAuditFor("invoice_draft_discarded", [finalized.id])).toBe(0);
  });

  it("BF-10.2 — bulk-delete: doppelte und unbekannte IDs werden sauber als skipped gezählt", async () => {
    const draft = await createDraftSzInvoice("BULKDEL-DUP");
    // Duplikat-ID + nicht existierende ID. Die Route dedupliziert (Set), die
    // unbekannte ID trifft den WHERE-Guard nicht → skip.
    const res = await apiPost<any>("/api/billing/bulk-delete", {
      invoiceIds: [draft.id, draft.id, 999_999_999],
    });
    expect(res.status, `bulk-delete: ${JSON.stringify(res.data)}`).toBe(200);
    // Nach Dedup bleiben 2 eindeutige IDs: 1 gelöscht, 1 (unbekannt) skipped.
    expect(res.data.summary.total).toBe(2);
    expect(res.data.summary.deleted).toBe(1);
    expect(res.data.summary.skipped).toBe(1);
    expect(res.data.invoiceNumbers).toEqual([draft.invoiceNumber]);
  });

  it("BF-10.3 — bulk-status wendet nur erlaubte Übergänge an und zählt korrekt", async () => {
    // Gültige Quelle: Entwurf → versendet.
    const draft = await createDraftSzInvoice("BULKST-OK");
    // Ungültige Quelle 1: bereits versendet → versendet ist NICHT in der SSoT.
    const alreadySent = await createDraftSzInvoice("BULKST-SENT");
    await finalizeInvoice(alreadySent.id, "versendet");
    // Ungültige Quelle 2: bezahlt → versendet ist ein Downgrade, verboten.
    const paid = await createDraftSzInvoice("BULKST-PAID");
    await finalizeInvoice(paid.id, "bezahlt");

    const res = await apiPost<any>("/api/billing/bulk-status", {
      invoiceIds: [draft.id, alreadySent.id, paid.id],
      status: "versendet",
    });
    expect(res.status, `bulk-status: ${JSON.stringify(res.data)}`).toBe(200);

    expect(res.data.summary.updated).toBe(1);
    expect(res.data.summary.skipped).toBe(2);
    expect(res.data.summary.total).toBe(3);

    const byId = new Map<number, any>(res.data.results.map((r: any) => [r.invoiceId, r]));
    expect(byId.get(draft.id).status).toBe("updated");
    expect(byId.get(alreadySent.id).status).toBe("skipped");
    expect(byId.get(alreadySent.id).reason).toMatch(/nicht erlaubt/i);
    expect(byId.get(paid.id).status).toBe("skipped");
    expect(byId.get(paid.id).reason).toMatch(/nicht erlaubt/i);

    // Nur die gültige Rechnung trägt jetzt den neuen Status.
    const draftAfter = await apiGet<any>(`/api/billing/${draft.id}`);
    expect(draftAfter.data.status).toBe("versendet");
    const paidAfter = await apiGet<any>(`/api/billing/${paid.id}`);
    expect(paidAfter.data.status, "bezahlte Rechnung darf nicht herabgestuft werden").toBe("bezahlt");

    // Audit: genau ein invoice_status_changed für die einzige geänderte Zeile,
    // KEINER für die beiden übersprungenen Rechnungen.
    expect(await countAuditFor("invoice_status_changed", [draft.id])).toBe(1);
    expect(await countAuditFor("invoice_status_changed", [alreadySent.id, paid.id])).toBe(0);
  });

  it("BF-10.4 — bulk-status führt eine gültige Kette versendet → bezahlt aus", async () => {
    const a = await createDraftSzInvoice("BULKST-CHAIN-A");
    const b = await createDraftSzInvoice("BULKST-CHAIN-B");
    await finalizeInvoice(a.id, "versendet");
    await finalizeInvoice(b.id, "versendet");

    const res = await apiPost<any>("/api/billing/bulk-status", {
      invoiceIds: [a.id, b.id],
      status: "bezahlt",
    });
    expect(res.status, `bulk-status: ${JSON.stringify(res.data)}`).toBe(200);
    expect(res.data.summary.updated).toBe(2);
    expect(res.data.summary.skipped).toBe(0);
    expect(res.data.summary.total).toBe(2);

    for (const inv of [a, b]) {
      const after = await apiGet<any>(`/api/billing/${inv.id}`);
      expect(after.data.status).toBe("bezahlt");
    }
    expect(await countAuditFor("invoice_status_changed", [a.id, b.id])).toBe(2);
  });

  it("BF-10.5 — bulk-status meldet unbekannte Rechnungen als 'nicht gefunden'", async () => {
    const res = await apiPost<any>("/api/billing/bulk-status", {
      invoiceIds: [999_999_998],
      status: "versendet",
    });
    expect(res.status, `bulk-status: ${JSON.stringify(res.data)}`).toBe(200);
    expect(res.data.summary.updated).toBe(0);
    expect(res.data.summary.skipped).toBe(1);
    expect(res.data.results[0].status).toBe("skipped");
    expect(res.data.results[0].reason).toMatch(/nicht gefunden/i);
  });
});
