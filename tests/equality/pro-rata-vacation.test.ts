/**
 * Task #427 — Equality: Pro-Rata-Urlaubsanspruch (Anzeige vs. Buchung).
 *
 * Vergleich:
 *   Anzeige  = `GET /api/time-entries/vacation-summary/:year` → `entitlement`
 *              (was im Mitarbeiterprofil/Urlaubsblock angezeigt wird).
 *   Buchung  = `calculateAnnualEntitlementWithHistory` aus
 *              `shared/domain/vacation` (gleiche Funktion, die der
 *              Urlaubs-Sync für die `employee_vacation_allowance`-Tabelle
 *              und damit die Urlaubsbuchung verwendet).
 *
 * Drift-Kategorie: ein Eintrittsdatum mitten im Jahr, das im Profil als
 * volles Jahr angezeigt, aber nur anteilig gebucht wird (oder umgekehrt).
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  createTestEmployee,
  getAuthCookie,
  loginAs,
  runCleanup,
} from "../test-utils";
import { assertDisplayEqualsBooking } from "../helpers/equality-check";
import { calculateAnnualEntitlementWithHistory } from "@shared/domain/vacation";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

interface EmployeeCtx {
  userId: number;
  email: string;
  password: string;
  eintrittsdatum: string;
  vacationDaysPerYear: number;
  year: number;
}

// Hinweis zum Schreibpfad: Urlaubsanspruch hat im aktuellen Modell keinen
// separaten Buchungs-Endpoint — der Wert wird beim Setzen von
// `users.vacationDaysPerYear` und `eintrittsdatum` aus
// `vacationEntitlementHistory` berechnet (write triggert PATCH unten,
// liest dann via Domain-Funktion zurück). Beide Pfade — der
// Live-API-Endpunkt (`/vacation-summary/:year`) und der Domain-Calculator
// (`calculateAnnualEntitlementWithHistory`) — werden mit identischer
// Eingabe verglichen, damit Drift zwischen UI-Anzeige und der Funktion,
// die den persistierten Anspruch berechnet, sofort auffliegt.

async function fetchVacationSummaryAs(
  email: string,
  password: string,
  year: number,
): Promise<{ totalDays: number; carryOverDays: number }> {
  const auth = await loginAs(email, password);
  const cookie = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const res = await fetch(
    `${BASE_URL}/api/time-entries/vacation-summary/${year}`,
    { headers: { Cookie: cookie } },
  );
  if (!res.ok) {
    throw new Error(`vacation-summary failed: ${res.status}`);
  }
  return await res.json();
}

describe("Equality Pro-Rata-Urlaub — Profil-Anzeige vs Domain-Berechnung", () => {
  it("entitlement (read) == calculateAnnualEntitlementWithHistory (write-Pfad)", async () => {
    const cases: Array<{ name: string; eintritt: string; daysPerYear: number; year: number }> = [
      // Volljahres-Mitarbeiter, eingetreten vor `year`.
      { name: "Volljahr 30 Tage (Eintritt 2020-01-01)", eintritt: "2020-01-01", daysPerYear: 30, year: 2025 },
      // Eintritt im April → 9/12 von 24 = 18 Tage (anteilig).
      { name: "Eintritt April → anteilig", eintritt: "2024-04-15", daysPerYear: 24, year: 2024 },
      // Eintritt im November → nur 2/12.
      { name: "Eintritt November → kleinster Anteil", eintritt: "2024-11-10", daysPerYear: 24, year: 2024 },
    ];

    await assertDisplayEqualsBooking<
      EmployeeCtx,
      { entitlement: number },
      { entitlement: number },
      number
    >({
      domain: "Pro-Rata-Urlaub",
      // Pro Toleranz von 0.01 Tagen (Anzeige rundet auf 2 Nachkommastellen,
      // History-Berechnung ebenso — Drift > 0.01 ist ein echter Bug).
      scenarios: cases.map((c) => ({
        name: c.name,
        tolerance: 0.01,
        setup: async (): Promise<EmployeeCtx> => {
          const emp = await createTestEmployee({ nachnamePrefix: "T427Vac" });
          // Eintrittsdatum + Tage/Jahr per Admin-PATCH setzen, damit der
          // Server die History korrekt initialisiert.
          const auth = await getAuthCookie();
          const cookie = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
          const r = await fetch(`${BASE_URL}/api/admin/users/${emp.id}`, {
            method: "PATCH",
            headers: {
              Cookie: cookie,
              "Content-Type": "application/json",
              "x-csrf-token": auth.csrfToken,
            },
            body: JSON.stringify({
              eintrittsdatum: c.eintritt,
              vacationDaysPerYear: c.daysPerYear,
            }),
          });
          if (!r.ok) {
            throw new Error(`PATCH user failed: ${r.status} ${await r.text()}`);
          }
          return {
            userId: emp.id,
            email: emp.email,
            password: emp.password,
            eintrittsdatum: c.eintritt,
            vacationDaysPerYear: c.daysPerYear,
            year: c.year,
          };
        },
        read: async (ctx) => {
          const summary = await fetchVacationSummaryAs(ctx.email, ctx.password, ctx.year);
          // `totalDays` ist im API-Vertrag der „berechnete, anteilige
          // Jahresanspruch" (siehe `shared/api/time-tracking.ts`).
          return { entitlement: summary.totalDays };
        },
        write: async (ctx) => {
          // History wird vom Backend bei PATCH automatisch geseedet.
          // Hier rekonstruieren wir die History aus den bekannten Werten,
          // weil sie bei dieser Test-Konstellation aus genau einem Eintrag
          // (validFrom = Eintrittsmonat) besteht — das spiegelt den Zustand,
          // den der Sync in `employee_vacation_allowance` schreibt.
          const [y, m] = ctx.eintrittsdatum.split("-").map(Number);
          const history = [
            {
              validFromYear: y,
              validFromMonth: m,
              daysPerYear: ctx.vacationDaysPerYear,
            },
          ];
          const ent = calculateAnnualEntitlementWithHistory(
            history,
            ctx.eintrittsdatum,
            ctx.year,
            ctx.vacationDaysPerYear,
          );
          return { entitlement: ent };
        },
        extractDisplayed: (r) => r.entitlement,
        extractBooked: (w) => w.entitlement,
      })),
    });
  }, 240_000);
});
