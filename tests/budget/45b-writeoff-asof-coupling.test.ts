/**
 * §45b-Verfall-as-of — der Write-Off darf rückwirkende Buchungen weder
 * fehlkoppeln noch den letzten gültigen Tag der Frist sperren.
 *
 * Ausgangslage (am echten Prod-Pfad reproduziert): Beim Buchen läuft
 * `syncCarryoverAndExpiry` VOR der FIFO-Zuordnung und legt für einen
 * abgelaufenen Übertrag einen `write_off` an. Zwei Defekte hingen daran:
 *
 *   (1) NULL-Fehlkopplung. Die Pro-Allocation-Sicht in `computeFifoAvailability`
 *       zählte `consumption`+`write_off` OHNE Datumsfilter, obwohl die
 *       Topf-Summe daneben auf `transactionDate` filtert. Ein später datierter
 *       Write-Off ließ den Übertrag für eine RÜCKWIRKENDE H1-Buchung bereits
 *       aufgezehrt aussehen → die Konsumtion fiel in den `allocationId = null`-
 *       Zweig. Der Reader exkludiert Verbrauch gegen herausgefallene Töpfe per
 *       `allocationId`, traf die NULL-Zeile nicht und belastete den laufenden
 *       Jahrestopf ein zweites Mal (Detektor: `45b-july-boundary-symmetry`,
 *       87.900 statt 91.700).
 *
 *   (2) Gesperrter 30.06. Der Write-Off war auf `expiresAt` (30.06.) datiert.
 *       Da die Verbrauchs-Summen `transactionDate <= Stichtag` zählen, war der
 *       Topf ausgerechnet an seinem letzten rechtlich gültigen Tag leer.
 *       §45b Abs. 3 lässt das Guthaben mit ABLAUF des 30.06. verfallen — der
 *       30.06. gehört noch zum Fenster. Der Write-Off trägt jetzt den 01.07.
 *
 * BEWUSSTE VERHALTENSÄNDERUNG (Weiche, von Alrik abgenommen): Eine Buchung mit
 * `transactionDate = 30.06.` greift nach dem Verfallslauf wieder auf den
 * Übertrag zu. Vorher war sie blockiert. Der zweite Block unten nagelt das fest.
 *
 * NICHT Gegenstand dieses Fixes: der Write-Off-BETRAG bleibt der volle
 * Übertrags-Rest, auch wenn eine rückwirkende Buchung ihn nachträglich teilweise
 * verbraucht. Die Verfügbarkeit stimmt (beide Zeilen werden symmetrisch
 * exkludiert); die Allocation ist in der Roh-Sicht aber überbucht und die
 * ausgewiesene Verfalls-Summe zu hoch. Siehe FINDING im PR — Korrektur per
 * kompensierender `reversal`-Zeile ist ein eigener Vorgang.
 *
 * Die Zeit wird bewusst eingefroren: Der Verfallslauf fragt `todayISO()` ("welche
 * Frist ist JETZT abgelaufen"), die Aussagen dieses Tests gelten aber unabhängig
 * davon, ob die Suite im 1. oder 2. Halbjahr läuft. Alle Aufrufe hier sind
 * Direkt-Storage-Aufrufe im Testprozess — es hängt kein App-Server mit eigener
 * Systemzeit daran (vgl. `race-writeoff.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices, budgetAllocations, budgetTransactions, services } from "@shared/schema";
import {
  computeFifoAvailability,
  createConsumptionTransaction,
} from "../../server/storage/budget/consumption-engine";
import {
  processExpiredCarryover,
  upsertCarryoverAllocation,
} from "../../server/storage/budget/allocation-storage";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { freezeTime, thawTime } from "../helpers/frozen-clock";
import { getAuthCookie, runCleanup } from "../test-utils";

const YEAR = new Date().getFullYear();
const PREV_YEAR = YEAR - 1;

const CARRYOVER_CENTS = 13100;
/** Übertrag aus PREV_YEAR ⇒ Fenster YEAR-01-01 .. YEAR-06-30 (carryoverWindowFor). */
const EXPIRES_AT = `${YEAR}-06-30`;
/** Rückwirkende Buchung im 1. Halbjahr, klar innerhalb des Übertrags-Fensters. */
const H1_DATE = `${YEAR}-02-16`;
/** Letzter rechtlich gültiger Tag der Frist. */
const LAST_VALID_DAY = EXPIRES_AT;
/** „Jetzt" nach dem Verfall — der Verfallslauf hat den Write-Off bereits gesetzt. */
const AFTER_EXPIRY = `${YEAR}-08-15T10:00:00+02:00`;

const TZ_BEFORE = process.env.TZ;
let hwServiceId: number;
const handles: BudgetScenarioHandle[] = [];
const apptIds: number[] = [];

beforeAll(async () => {
  // Deterministische Zone: der Verfallslauf vergleicht lokale Tage via
  // `todayISO()` (analog `race-writeoff.test.ts` / `timezone.test.ts`).
  process.env.TZ = "Europe/Berlin";
  await getAuthCookie();
  const [hw] = await db.select().from(services).where(eq(services.code, "hauswirtschaft"));
  hwServiceId = hw.id;
});

afterEach(() => {
  thawTime();
});

afterAll(async () => {
  for (const id of apptIds.reverse()) {
    try {
      await db.delete(appointmentServices).where(eq(appointmentServices.appointmentId, id));
      await db.delete(appointments).where(eq(appointments.id, id));
    } catch { /* best-effort */ }
  }
  for (const h of handles) await h.cleanup();
  await runCleanup();
  if (TZ_BEFORE === undefined) delete process.env.TZ; else process.env.TZ = TZ_BEFORE;
});

/**
 * Kunde mit AUSSCHLIESSLICH dem geseedeten Übertrag als §45b-Geld: der Anker
 * liegt in der Zukunft, es gibt also keine Monats-Aufstockung, die die
 * Zuordnungs-Aussagen verwässern könnte.
 */
async function makeCarryoverOnlyCustomer(prefix: string): Promise<BudgetScenarioHandle> {
  const h = await setupBudgetScenario({
    customerNamePrefix: prefix,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
    pflegegradSeit: "2099-01-01",
    types: [
      { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { type: "umwandlung_45a", priority: 2, enabled: false },
      { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
    ],
  });
  handles.push(h);
  await upsertCarryoverAllocation({
    customerId: h.customerId,
    budgetType: "entlastungsbetrag_45b",
    sourceYear: PREV_YEAR,
    amountCents: CARRYOVER_CENTS,
  });
  return h;
}

async function carryoverAllocationId(customerId: number): Promise<number> {
  const [alloc] = await db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.customerId, customerId),
    eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    eq(budgetAllocations.source, "carryover"),
  ));
  expect(alloc, "Übertrags-Allokation muss existieren").toBeDefined();
  expect(alloc.expiresAt).toBe(EXPIRES_AT);
  return alloc.id;
}

async function book(h: BudgetScenarioHandle, date: string, minutes: number) {
  const [appt] = await db.insert(appointments).values({
    customerId: h.customerId,
    assignedEmployeeId: h.employeeId,
    appointmentType: "kundentermin",
    date,
    scheduledStart: "10:00:00",
    scheduledEnd: "11:00:00",
    durationPromised: minutes,
    status: "scheduled",
    notes: "45b-verfall-as-of",
  }).returning();
  apptIds.push(appt.id);
  await db.insert(appointmentServices).values({
    appointmentId: appt.id, serviceId: hwServiceId, plannedDurationMinutes: minutes,
  });
  return createConsumptionTransaction({
    customerId: h.customerId,
    appointmentId: appt.id,
    transactionDate: date,
    hauswirtschaftMinutes: minutes,
    alltagsbegleitungMinutes: 0,
    travelKilometers: 0,
    customerKilometers: 0,
    userId: h.employeeId,
  });
}

describe("§45b-Verfall-as-of — Write-Off koppelt rückwirkende Buchungen nicht mehr auf NULL", () => {
  it("H1-Buchung nach dem Verfallslauf hängt am Übertrag, nicht an allocationId=NULL", async () => {
    const h = await makeCarryoverOnlyCustomer("T45BVA-COUPLE");
    const allocId = await carryoverAllocationId(h.customerId);

    freezeTime(AFTER_EXPIRY);

    // Verfallslauf zuerst — exakt die Reihenfolge, die `createCascadeConsumption`
    // beim Buchen ohnehin herstellt (sync VOR FIFO).
    const written = await processExpiredCarryover(h.customerId);
    expect(written, "Verfallslauf muss genau einen Write-Off erzeugen").toHaveLength(1);
    expect(written[0].allocationId).toBe(allocId);

    const tx = await book(h, H1_DATE, 60);

    // Kern der Regression: die rückwirkende Buchung liegt IM Übertrags-Fenster
    // und muss deshalb an der Übertrags-Allokation hängen. Vor dem Fix war das
    // `null`, weil der (später datierte) Write-Off die Allokation in der
    // Pro-Allocation-Sicht ohne as-of-Filter bereits aufgezehrt hat.
    expect(tx.allocationId, "Konsumtion muss an den Übertrag gekoppelt sein").toBe(allocId);

    const rows = await db.select().from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, h.customerId))
      .orderBy(asc(budgetTransactions.id));
    expect(
      rows.filter(r => r.transactionType === "consumption" && r.allocationId === null),
      "keine NULL-gekoppelte §45b-Konsumtion im Übertrags-Fenster",
    ).toHaveLength(0);
  });

  it("Write-Off ist auf den 01.07. datiert (erster Tag NACH der Frist), nicht auf den 30.06.", async () => {
    const h = await makeCarryoverOnlyCustomer("T45BVA-DATE");
    const allocId = await carryoverAllocationId(h.customerId);

    freezeTime(AFTER_EXPIRY);
    const written = await processExpiredCarryover(h.customerId);

    expect(written).toHaveLength(1);
    expect(written[0].transactionDate).toBe(`${YEAR}-07-01`);
    expect(written[0].allocationId).toBe(allocId);
    // Der Betrag bleibt der volle Übertrag (Weiche A) — hier nur festgehalten,
    // damit eine spätere Reversal-Korrektur bewusst an diesem Test vorbeimuss.
    expect(Math.abs(written[0].amountCents)).toBe(CARRYOVER_CENTS);
  });
});

describe("§45b-Verfall-as-of — der 30.06. bleibt ein nutzbarer Tag (bewusste Verhaltensänderung)", () => {
  it("Buchung mit transactionDate = 30.06. greift nach dem Verfallslauf noch auf den Übertrag zu", async () => {
    const h = await makeCarryoverOnlyCustomer("T45BVA-LASTDAY");
    const allocId = await carryoverAllocationId(h.customerId);

    freezeTime(AFTER_EXPIRY);
    await processExpiredCarryover(h.customerId);

    // Vor dem Fix: 0 — der auf den 30.06. datierte Write-Off zehrte den Topf an
    // seinem letzten gültigen Tag auf.
    const avail = await computeFifoAvailability(h.customerId, "entlastungsbetrag_45b", LAST_VALID_DAY);
    expect(avail.totalAvailable, "am 30.06. steht der Übertrag noch voll bereit").toBe(CARRYOVER_CENTS);

    const tx = await book(h, LAST_VALID_DAY, 60);
    expect(Math.abs(tx.amountCents)).toBeGreaterThan(0);
    expect(tx.allocationId, "auch die 30.06.-Buchung hängt am Übertrag").toBe(allocId);
  });

  it("ab dem 01.07. ist der Übertrag verbraucht — der Verfall wirkt unverändert", async () => {
    const h = await makeCarryoverOnlyCustomer("T45BVA-AFTER");
    await carryoverAllocationId(h.customerId);

    freezeTime(AFTER_EXPIRY);
    await processExpiredCarryover(h.customerId);

    const avail = await computeFifoAvailability(h.customerId, "entlastungsbetrag_45b", `${YEAR}-07-01`);
    expect(avail.totalAvailable, "am 01.07. ist der Übertrag verfallen").toBe(0);
  });
});
