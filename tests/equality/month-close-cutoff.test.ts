/**
 * Task #427 — Equality: Monatsabschluss-Cutoff (Banner vs. Server-Enforcement).
 *
 * Vergleich:
 *   Anzeige  = `GET /api/time-entries/month-close/cutoff/:year/:month`
 *              (was die UI dem Nutzer als Cutoff-Datum anzeigt).
 *   Buchung  = `computeMonthCloseCutoff(year, month)` aus
 *              `shared/utils/month-close-cutoff` — die Quelle, die der
 *              Auto-Close-Scheduler und `isCutoffDay` für die tatsächliche
 *              Schließung verwenden.
 *
 * Drift-Kategorie: Banner zeigt einen Cutoff (z.B. 8.) während der Scheduler
 * bereits am 7. schließt. Beide MÜSSEN bit-identisch sein.
 *
 * Zusätzlich: Smoke-Test, dass Banner.daysUntilCutoff mit
 * `daysUntilCutoff(today, ...)` aus dem Domain-Modul übereinstimmt.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  apiGet,
  apiPostAs,
  createTestEmployee,
  getAuthCookie,
  loginAs,
  runCleanup,
} from "../test-utils";
import { assertDisplayEqualsBooking } from "../helpers/equality-check";
import {
  computeMonthCloseCutoff,
  daysUntilCutoff,
  previousMonth,
} from "@shared/utils/month-close-cutoff";
import { setupBudgetScenario } from "../helpers/budget-scenarios";
import { closeMonth } from "../../server/storage/time-tracking/month-closing";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

interface MonthCtx {
  year: number;
  month: number;
}

describe("Equality Monatsabschluss-Cutoff — Banner-API vs Domain-Funktion", () => {
  it("Cutoff-Endpoint liefert exakt computeMonthCloseCutoff()", async () => {
    const cases: Array<{ name: string; year: number; month: number }> = [
      { name: "Standard-Werktag (Nov 2025 → Dez 8)", year: 2025, month: 11 },
      { name: "8. fällt auf Samstag (Okt 2025 → Fr 7. Nov)", year: 2025, month: 10 },
      { name: "8. fällt auf Sonntag (Jan 2026 → Fr 6. Feb)", year: 2026, month: 1 },
      { name: "Jahreswechsel (Dez 2025 → Jan 2026)", year: 2025, month: 12 },
    ];

    await assertDisplayEqualsBooking<
      MonthCtx,
      { cutoffEpochDays: number },
      { cutoffEpochDays: number },
      number
    >({
      domain: "Monatsabschluss-Cutoff",
      scenarios: cases.map((c) => ({
        name: c.name,
        setup: async () => ({ year: c.year, month: c.month }),
        read: async (ctx) => {
          const r = await apiGet<{ cutoff: string; year: number; month: number }>(
            `/api/time-entries/month-close/cutoff/${ctx.year}/${ctx.month}`,
          );
          return { cutoffEpochDays: isoToEpochDays(r.data.cutoff) };
        },
        write: async (ctx) => {
          const cutoff = computeMonthCloseCutoff(ctx.year, ctx.month);
          return { cutoffEpochDays: isoToEpochDays(cutoff) };
        },
        extractDisplayed: (r) => r.cutoffEpochDays,
        extractBooked: (w) => w.cutoffEpochDays,
      })),
    });
  }, 60_000);

  it("Banner.daysUntilCutoff stimmt mit Domain-Funktion überein", async () => {
    const r = await apiGet<{ banner: null | { year: number; month: number; cutoff: string; daysUntilCutoff: number } }>(
      "/api/time-entries/month-close/banner",
    );
    expect(r.status).toBe(200);

    if (!r.data.banner) {
      // Kein Banner für diesen Nutzer — z.B. keine offenen Punkte. Test
      // gilt dann als bestanden (Banner ist optional, Cutoff-Equality ist
      // im obigen Test bereits geprüft).
      return;
    }

    const banner = r.data.banner;
    // Banner berechnet `today` in Berliner Zeitzone (siehe
    // server/services/month-close-scheduler.ts → todayBerlinIso). Der Test
    // MUSS dieselbe Quelle verwenden, sonst gibt es UTC-Off-by-one am Tagrand.
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const expected = daysUntilCutoff(today, banner.year, banner.month);

    expect(
      banner.daysUntilCutoff,
      `Banner.daysUntilCutoff (${banner.daysUntilCutoff}) weicht von ` +
      `daysUntilCutoff(${today}, ${banner.year}, ${banner.month}) (${expected}) ab.`,
    ).toBe(expected);

    // Sanity: Vormonats-Logik des Banners == previousMonth(today)
    const prev = previousMonth(today);
    expect(banner.year).toBe(prev.year);
    expect(banner.month).toBe(prev.month);
  }, 60_000);

  it("Server-Enforcement: POST /api/appointments im geschlossenen Monat → 403 MONTH_CLOSED", async () => {
    // Write-Side-Equality: Wenn der Banner sagt „Monat geschlossen",
    // MUSS auch der Schreibpfad den Termin ablehnen. Kein Drift zwischen
    // Anzeige und Enforcement erlaubt.
    const auth = await getAuthCookie();
    // 1) Frischen Mitarbeiter + Kunden via Budget-Setup anlegen.
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "T427-MC",
      pflegegrad: 2,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: "2024-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: { type: "entlastungsbetrag_45b", amountCents: 50000, validFrom: "2024-01-01" },
    });
    try {
      // 2) Vormonat berechnen und für den Mitarbeiter schließen
      //    (entspricht Auto-Close am Cutoff-Tag).
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const { year, month } = previousMonth(today);
      await closeMonth(scenario.employeeId, year, month, auth.user.id);

      // 3) Als der Mitarbeiter selbst einloggen — nur Superadmins dürfen
      //    nach Schließung noch schreiben.
      // Mitarbeiter aus dem Scenario hat ein generiertes Passwort, das wir
      // hier nicht kennen. Stattdessen hängen wir einen frischen
      // Test-Employee daran und schließen DESSEN Monat.
      const emp = await createTestEmployee({ isAdmin: false, nachnamePrefix: "T427MC" });
      await closeMonth(emp.id, year, month, auth.user.id);
      const empAuth = await loginAs(emp.email, emp.password);

      // 4) Ein Datum innerhalb des geschlossenen Monats wählen.
      const dateInClosedMonth = `${year}-${String(month).padStart(2, "0")}-15`;

      // Service-Katalog laden, um eine gültige serviceId zu erhalten.
      const catalogRes = await apiGet<Array<{ id: number; code: string }>>(
        "/api/services",
      );
      const hwSvc = catalogRes.data.find((s) => s.code === "hauswirtschaft");
      if (!hwSvc) throw new Error("Service 'hauswirtschaft' nicht im Katalog");

      const res = await apiPostAs(
        empAuth,
        "/api/appointments/kundentermin",
        {
          customerId: scenario.customerId,
          assignedEmployeeId: emp.id,
          date: dateInClosedMonth,
          scheduledStart: "10:00",
          scheduledEnd: "11:00",
          notes: "T427 closed-month write check",
          services: [{ serviceId: hwSvc.id, durationMinutes: 60 }],
        },
      );

      expect(res.status, `Expected 403 MONTH_CLOSED, got ${res.status} ${JSON.stringify(res.data)}`)
        .toBe(403);
      const body = res.data as { error?: string };
      expect(body.error).toBe("MONTH_CLOSED");
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});

function isoToEpochDays(iso: string): number {
  const ms = Date.UTC(
    parseInt(iso.slice(0, 4)),
    parseInt(iso.slice(5, 7)) - 1,
    parseInt(iso.slice(8, 10)),
  );
  return Math.round(ms / (24 * 60 * 60 * 1000));
}
