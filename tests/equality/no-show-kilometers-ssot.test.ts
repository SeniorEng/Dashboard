/**
 * Task #1565 — SSoT: No-Show-Kilometer haben genau EINE Quelle.
 *
 * Historischer Zustand: Bei einem Kunden-No-Show (`status = 'customer_no_show'`)
 * lag die "vergebliche Anfahrt"-Kilometerzahl in ZWEI Feldern:
 *   - `travelKilometers`  → gelesen von der Zeitübersicht-Kachel "Leerfahrten"
 *                            (`server/storage/time-tracking/overview.ts`)
 *   - `noShowKilometers`  → gelesen vom Abrechnungs-Pfad
 *                            (`server/services/invoice-data.ts`, No-Show-Charge)
 * Der Schreibpfad kopierte denselben Wert in beide Felder — ein latenter
 * Dual-Write. Sobald nur eines der beiden Felder nachträglich mutiert wurde
 * (z.B. eine Termin-Korrektur, die nur `travelKilometers` schreibt), drifteten
 * Anzeige und Buchung auseinander.
 *
 * Nach #1565 ist `noShowKilometers` die EINZIGE Quelle. Dieser Test setzt die
 * beiden Felder bewusst auf UNTERSCHIEDLICHE Werte (Poison-Wert in
 * `travelKilometers`, echter Wert in `noShowKilometers`) und prüft, dass sowohl
 * die Anzeige (`getTimeOverview` → Leerfahrten) als auch die Buchung
 * (`buildLineItemsFromAppointments` → No-Show-Charge) den SSoT-Wert
 * `noShowKilometers` lesen und den Poison-Wert `travelKilometers` ignorieren.
 *
 * Sollte ein Lesepfad je wieder auf `travelKilometers` zurückfallen, wird
 * dieser Test rot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, customers } from "@shared/schema";
import { getTimeOverview } from "../../server/storage/time-tracking/overview";
import { buildLineItemsFromAppointments } from "../../server/services/invoice-data";
import {
  createTestCustomer,
  createTestEmployee,
  getAuthCookie,
  runCleanup,
  trackCleanup,
} from "../test-utils";

// Weit in der Zukunft, damit der Datensatz kein anderes Test-/Seed-Fenster
// kreuzt. Direkte DB-Inserts → Wochenend-/Cutoff-Policies spielen keine Rolle.
const YEAR = 2033;
const MONTH = 5;
const DATE = `${YEAR}-0${MONTH}-12`;

// Bewusst divergente Werte: der SSoT-Wert steht in `noShowKilometers`,
// der Poison-Wert in `travelKilometers`. Ein Lesepfad, der noch
// `travelKilometers` liest, würde den Poison-Wert sehen.
const SSOT_KM = 30;
const POISON_KM = 999;
const KM_RATE_CENTS = 100; // 1,00 € / km → Charge = km * Satz (Wartezeit = 0)

let emp: { id: number };
let customerId: number;
let appointmentId = 0;

beforeAll(async () => {
  await getAuthCookie();
  emp = await createTestEmployee({ nachnamePrefix: "NoShowKm" });

  const customer = await createTestCustomer();
  customerId = customer.id as number;
  trackCleanup(async () => {
    try {
      const { apiPost } = await import("../test-utils");
      await apiPost(`/api/admin/test-cleanup/purge-customers`, { ids: [customerId] });
    } catch {
      /* best-effort */
    }
  });

  // Selbstzahler-Cancellation-Policy: km-basiert (kein Pauschal-/Wartezeit-
  // Anteil), damit die No-Show-Charge exakt km * Satz ist.
  await db
    .update(customers)
    .set({
      cancellationPolicyType: "travel_plus_wait",
      cancellationKmRateCents: KM_RATE_CENTS,
      cancellationHourlyRateCents: 0,
      cancellationFlatCents: 0,
    })
    .where(eq(customers.id, customerId));

  const [inserted] = await db
    .insert(appointments)
    .values({
      customerId,
      appointmentType: "kundentermin",
      date: DATE,
      scheduledStart: "09:00",
      scheduledEnd: "10:00",
      durationPromised: 60,
      status: "customer_no_show",
      assignedEmployeeId: emp.id,
      performedByEmployeeId: emp.id,
      noShowWaitMinutes: 0,
      // Divergenz: SSoT ≠ Poison.
      noShowKilometers: SSOT_KM,
      travelKilometers: POISON_KM,
    })
    .returning({ id: appointments.id });
  appointmentId = inserted.id;
});

afterAll(async () => {
  await runCleanup();
});

describe("Task #1565 — No-Show-Kilometer SSoT (noShowKilometers)", () => {
  it("Anzeige (Leerfahrten) liest noShowKilometers, nicht travelKilometers", async () => {
    const overview = await getTimeOverview(emp.id, { year: YEAR, month: MONTH });
    expect(overview.leerfahrten!.count).toBe(1);
    expect(overview.leerfahrten!.kilometers).toBe(SSOT_KM);
    expect(overview.leerfahrten!.kilometers).not.toBe(POISON_KM);
  });

  it("Buchung (No-Show-Charge) liest noShowKilometers, nicht travelKilometers", async () => {
    const { lineItems } = await buildLineItemsFromAppointments(
      [appointmentId],
      customerId,
      "selbstzahler",
    );
    const noShowLine = lineItems.find(li => li.serviceCode === "no_show_charge");
    expect(noShowLine).toBeDefined();
    // Charge = km * Satz. SSoT (30) → 3000 Cent; Poison (999) → 99900 Cent.
    expect(noShowLine!.totalCents).toBe(SSOT_KM * KM_RATE_CENTS);
    expect(noShowLine!.totalCents).not.toBe(POISON_KM * KM_RATE_CENTS);
  });

  it("Anzeige und Buchung leiten beide dieselbe km-Quelle ab", async () => {
    const overview = await getTimeOverview(emp.id, { year: YEAR, month: MONTH });
    const { lineItems } = await buildLineItemsFromAppointments(
      [appointmentId],
      customerId,
      "selbstzahler",
    );
    const noShowLine = lineItems.find(li => li.serviceCode === "no_show_charge");
    // Beide Pfade müssen aus demselben Feld denselben km-Wert ableiten.
    expect(noShowLine!.totalCents / KM_RATE_CENTS).toBe(overview.leerfahrten!.kilometers);
  });
});
