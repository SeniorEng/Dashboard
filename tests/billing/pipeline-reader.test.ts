/**
 * Task #1405 — Integrationstest des Abrechnungs-Pipeline-Readers (Q4 SSoT).
 *
 * Verifiziert gegen eine echte DB + den laufenden App-Server:
 *   1. Struktur-Invarianten der `GET /api/billing/pipeline`-Antwort
 *      (6 Stufen, 5 Side-Zustände, Σ-Konsistenz Stufen/Side/Grand,
 *      Σ Karten-Cents === Stufen-Cents).
 *   2. €-Konservierung (Q1) als KREUZ-SSoT-Gleichheit: Der Pipeline-Reader und
 *      die bestehende Umsatz-Statistik (`getRevenueStats`) MÜSSEN für denselben
 *      Kunden im selben Monat exakt denselben „geplant"-Umsatz (scheduled-
 *      Termine) liefern — pro Kunde, also robust gegen Fremd-Testdaten in
 *      derselben Worker-DB.
 *   3. Per-Termin-Umsatz-Korrektheit: die „Offen"-Karte des Test-Kunden trägt
 *      exakt `Σ round(minutes/60 × default_price_cents)` (Integer-Cents).
 *
 * Sauberes Fixture (nur scheduled-Termine, keine Rechnungen/Stornos/No-Shows)
 * ⇒ alle €  leben in der Stufe „Offen", `sideTotalCents === 0`,
 * `stageTotalCents === grandTotalCents`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { apiGet, apiPost, getAuthCookie, uniqueId } from "../test-utils";
import { getRevenueStats } from "../../server/storage/statistics/revenue";
import { resolvePeriod } from "../../server/storage/statistics/common";
import type { BillingPipelineResponse } from "@shared/api/billing-pipeline";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let hwDefaultPriceCents: number;

// Werktage-Slot-Suche (nur Vergangenheit, im gewählten Monat).
const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Ein Monat, der vollständig in der Vergangenheit liegt (4 Monate zurück),
// damit Termine sofort als Vergangenheits-Slots anlegbar sind.
function pastMonth(): { year: number; month: number } {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 4);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

async function createCustomer(suffix: string): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Pipe",
    nachname: `Integ-${suffix}`,
    geburtsdatum: "1942-03-10",
    email: `pipe-${uniqueId()}@test.local`,
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 2,
    pflegegradSeit: "2024-01-01",
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
  });
  if (res.status !== 201) {
    throw new Error(`createCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.id;
}

async function createScheduledAppointment(
  customerId: number,
  year: number,
  month: number,
  durationMinutes: number,
  tag: string,
): Promise<void> {
  const lastDay = new Date(year, month, 0).getDate();
  const today = new Date();
  for (let day = lastDay; day >= 1; day--) {
    const d = new Date(year, month - 1, day);
    if (d >= today) continue;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymd(d);
    for (const time of SEED_TIMES) {
      const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `PIPE-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes }],
      });
      if (res.status === 201) return;
    }
  }
  throw new Error(`createScheduledAppointment(${tag}): kein freier Slot in ${year}-${month}`);
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const servicesRes = await apiGet<Array<{ id: number; unitType?: string; unit_type?: string; defaultPriceCents?: number; lohnartKategorie?: string }>>("/api/services/all");
  const services = servicesRes.data;
  const hw = services.find(
    (s) => (s.unitType ?? s.unit_type) === "hours" && (s.defaultPriceCents ?? 0) > 0,
  );
  if (!hw) throw new Error("Kein Stunden-Service mit Standardpreis gefunden");
  hwServiceId = hw.id;
  hwDefaultPriceCents = hw.defaultPriceCents ?? 0;
});

function round(n: number): number {
  return Math.round(n);
}

describe("GET /api/billing/pipeline — Pipeline-Reader (Task #1405)", () => {
  it("liefert 6 Stufen + 5 Side-Zustaende mit konsistenten Σ-Invarianten und €-Konservierung pro Kunde", async () => {
    const { year, month } = pastMonth();
    const customerId = await createCustomer(`P-${uniqueId()}`);

    const durations = [60, 30, 90];
    for (let i = 0; i < durations.length; i++) {
      await createScheduledAppointment(customerId, year, month, durations[i], `A${i}`);
    }
    const expectedCustomerCents = durations.reduce(
      (sum, m) => sum + round((m / 60) * hwDefaultPriceCents),
      0,
    );

    const res = await apiGet<BillingPipelineResponse>(`/api/billing/pipeline?year=${year}&month=${month}`);
    expect(res.status).toBe(200);
    const body = res.data;

    // --- Struktur-Invarianten ---
    // Status-Umbau: die Stufe `avis_erhalten` ist entfallen (7→6). Sie bildete
    // einen Zwischenzustand ab, den es nicht mehr gibt — der Avis ist eine
    // Zuordnung, kein Zustand. Eine Rechnung mit Avis wartet in `versendet`.
    expect(body.stages).toHaveLength(6);
    // Task #1874: „Wartet auf Kundenunterschrift" (3→4).
    // Status-Umbau: `storno_dokument` (4→5) — das Storno-DOKUMENT ist ein
    // eigener Zustand, nicht dasselbe wie die stornierte RECHNUNG.
    expect(body.sides).toHaveLength(5);
    expect(body.stages.map((s) => s.stage)).toEqual([
      "offen", "dokumentiert", "unterschrieben", "rechnung_erstellt", "versendet", "bezahlt",
    ]);

    const stageSum = body.stages.reduce((acc, s) => acc + s.totalCents, 0);
    const sideSum = body.sides.reduce((acc, s) => acc + s.totalCents, 0);
    expect(stageSum).toBe(body.totals.stageTotalCents);
    expect(sideSum).toBe(body.totals.sideTotalCents);
    expect(body.totals.grandTotalCents).toBe(body.totals.stageTotalCents + body.totals.sideTotalCents);

    // Task #1879 — Erwarteter Umsatz = Stufen-Summe + „Wartet auf
    // Kundenunterschrift" (übrige Side-Badges ausgeschlossen).
    const awaitingSide = body.sides.find((s) => s.state === "wartet_auf_kundenunterschrift");
    expect(body.totals.expectedRevenueTotalCents).toBe(
      body.totals.stageTotalCents + (awaitingSide?.totalCents ?? 0),
    );

    // Σ Karten-Cents je Stufe === Stufen-Cents (keine verlorenen €).
    for (const stage of body.stages) {
      const cardSum = stage.cards.reduce((acc, c) => acc + c.totalCents, 0);
      expect(cardSum, `Karten-Σ der Stufe ${stage.stage}`).toBe(stage.totalCents);
    }

    // --- Per-Termin-Umsatz-Korrektheit: „Offen"-Karte des Test-Kunden ---
    const offen = body.stages.find((s) => s.stage === "offen")!;
    const myCard = offen.cards.find((c) => c.customerId === customerId);
    expect(myCard, "Offen-Karte des Test-Kunden").toBeDefined();
    expect(myCard!.kind).toBe("customer");
    expect(myCard!.itemCount).toBe(durations.length);
    expect(myCard!.totalCents).toBe(expectedCustomerCents);
    expect(myCard!.aging).toBe("none");

    // --- €-Konservierung (Q1) als Kreuz-SSoT-Gleichheit, pro Kunde ---
    // Der Pipeline-Reader und die Umsatz-Statistik MÜSSEN denselben
    // „geplant"-Umsatz für denselben Kunden/Monat liefern.
    const revenue = await getRevenueStats(resolvePeriod({ year, month }));
    const revenueCustomerRow = revenue.byCustomer.find((r) => r.id === customerId);
    expect(revenueCustomerRow, "Umsatz-Statistik byCustomer-Zeile").toBeDefined();
    expect(myCard!.totalCents).toBe(revenueCustomerRow!.planned);
  });

  it("validiert Pflichtparameter year/month", async () => {
    const noYear = await apiGet<unknown>("/api/billing/pipeline?month=5");
    expect(noYear.status).toBe(400);
    const badMonth = await apiGet<unknown>("/api/billing/pipeline?year=2026&month=13");
    expect(badMonth.status).toBe(400);
  });
});
