import { test, expect } from "@playwright/test";
import {
  applyAuthToBrowser,
  apiPost,
  apiPut,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import {
  assignEmployee,
  createCustomer,
  createEmployee,
  getServiceIdByCode,
} from "../helpers/test-data";

// Task #1134 — Smoke-Pfad „§45b FIFO-Aufschlüsselungs-Balken".
//
// Task #1129/#1131 sichern die Render-Logik des FIFO-Balkens isoliert ab
// (Komponenten-Test mit gemocktem DTO). Dieser Smoke-Test beweist zusätzlich,
// dass der Balken auf der LIVE-Kundendetailseite tatsächlich erscheint, wenn
// ein echter §45b-Kunde über den vollen Stack geladen wird
// (seed → /budget/:id/fifo-breakdown → Seite). So fallen Verdrahtungs-
// Regressionen auf (Block konditional ausgeblendet, API-Feld umbenannt, Balken
// aus dem Layout gefallen), die der isolierte Komponenten-Test nicht sieht.
//
// Seeding ausschließlich über die JSON-API (kein DB-Zugriff im e2e), analog
// wizard-45b-override.spec.ts. Skip ohne TEST_USER_*-Creds.

const creds = getAdminCreds();
test.skip(!creds, "TEST_USER_EMAIL/TEST_USER_PASSWORD nicht gesetzt — Smoke-Suite übersprungen.");

let session: ApiSession;

test.beforeAll(async () => {
  session = await loginApiSession(creds!);
});

test.afterAll(async () => {
  if (session) await session.api.dispose();
});

test.beforeEach(async ({ context }) => {
  await applyAuthToBrowser(context, session);
});

// Letzter Werktag (Mo-Fr) heute oder davor, als YYYY-MM-DD. Ein dokumentierter
// Termin muss in der Vergangenheit/Gegenwart liegen (kein Zukunfts-Termin) und
// auf einen Werktag fallen. Das Datum liegt im laufenden Jahr → der §45b-Konsum
// passiert den asOfDate-Fensterfilter.
function recentWeekday(): string {
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

test.describe("@smoke §45b FIFO-Aufschlüsselung — Balken auf der Detailseite", () => {
  test("echter §45b-Kunde (Übertrag + laufendes Jahr + dok. Termin) zeigt den FIFO-Balken", async ({ page }) => {
    const curYear = new Date().getFullYear();

    // 1) §45b-fähiger Pflegekassen-Kunde. Pflegegrad-Beginn zwei Jahre zurück →
    //    der §45b-Carryover-/Startwert-Cap im /initial-budget-Endpoint lässt die
    //    moderaten Seed-Beträge unten zu.
    const customer = await createCustomer(session, {
      billingType: "pflegekasse_gesetzlich",
      pflegegrad: 3,
      pflegegradSeit: `${curYear - 2}-01-01`,
      acceptsPrivatePayment: false,
    });

    // 2) §45b-Topf einrichten: Vorjahres-Übertrag (100 €) + laufendes-Jahr-
    //    Startwert (131 €) in EINEM Aufruf → zwei FIFO-Töpfe.
    const initRes = await apiPost(
      session,
      `/api/budget/${customer.id}/initial-budget`,
      {
        budgetType: "entlastungsbetrag_45b",
        currentMonthAmountCents: 13_100,
        carryoverAmountCents: 10_000,
        budgetStartDate: `${curYear}-01-01`,
      },
    );
    expect(
      initRes.status === 200 || initRes.status === 201,
      `initial-budget fehlgeschlagen: ${initRes.status} ${JSON.stringify(initRes.data)}`,
    ).toBeTruthy();

    // 3) §45b-Type-Setting aktivieren (sonst greift die §45b-Eligibility-Gate
    //    und der Topf bleibt unsichtbar).
    const typesRes = await apiPut(
      session,
      `/api/budget/${customer.id}/type-settings`,
      {
        settings: [
          {
            budgetType: "entlastungsbetrag_45b",
            enabled: true,
            priority: 1,
            monthlyLimitCents: null,
            yearlyLimitCents: null,
            validFrom: null,
            validTo: null,
          },
        ],
      },
    );
    expect(
      typesRes.status,
      `type-settings fehlgeschlagen: ${typesRes.status} ${JSON.stringify(typesRes.data)}`,
    ).toBe(200);

    // 4) Mitarbeiter + zugewiesener, dokumentierter §45b-Termin (Hauswirtschaft)
    //    → erzeugt einen „Dokumentiert"-Konsum-Anteil im FIFO-Balken.
    const employee = await createEmployee(session);
    await assignEmployee(session, customer.id, employee.id);
    const serviceId = await getServiceIdByCode(session, "hauswirtschaft");
    const apptDate = recentWeekday();

    const apptRes = await apiPost<{ id: number }>(
      session,
      "/api/appointments/kundentermin",
      {
        customerId: customer.id,
        assignedEmployeeId: employee.id,
        date: apptDate,
        scheduledStart: "09:00:00",
        scheduledEnd: "10:00:00",
        services: [{ serviceId, durationMinutes: 60 }],
        notes: "T1134 §45b FIFO Smoke",
      },
    );
    expect(
      apptRes.status,
      `Termin-Anlage fehlgeschlagen: ${apptRes.status} ${JSON.stringify(apptRes.data)}`,
    ).toBe(201);

    const docRes = await apiPost(
      session,
      `/api/appointments/${apptRes.data.id}/document`,
      {
        actualStart: "09:00:00",
        travelOriginType: "home",
        travelKilometers: 0,
        customerKilometers: 0,
        services: [
          { serviceId, actualDurationMinutes: 60, details: "T1134 §45b FIFO Smoke" },
        ],
      },
    );
    expect(
      docRes.status,
      `Dokumentation fehlgeschlagen: ${docRes.status} ${JSON.stringify(docRes.data)}`,
    ).toBe(200);

    // 5) Detailseite öffnen → FIFO-Balken muss erscheinen. Der FIFO-Block lebt
    //    in der Mitarbeiter-/Detailseite `customer-detail.tsx` (Route
    //    `/customer/:id`), NICHT in der Admin-Detailseite (`/admin/customers/:id`).
    await page.goto(`/customer/${customer.id}`, { waitUntil: "domcontentloaded" });

    const breakdown = page.locator("[data-testid='fifo-breakdown']");
    await expect(breakdown).toBeVisible({ timeout: 15000 });
    await expect(breakdown).toContainText("Aufschlüsselung (FIFO)");

    // Der Topf „Laufendes Jahr" trägt immer eine Allokation (Startwert, kein
    // Verfall) — unabhängig davon, ob der Vorjahres-Übertrag im H2 bereits
    // verfallen ist. Sein „Frei"-Anteil ist daher immer sichtbar mit €-Text.
    const currentYearPot = page.locator("[data-testid='fifo-pot-current_year']");
    await expect(currentYearPot).toBeVisible();

    const freeSeg = page.locator("[data-testid='fifo-seg-current_year-remainingCents']");
    await expect(freeSeg).toBeVisible();
    const freeVal = page.locator("[data-testid='fifo-val-current_year-remainingCents']");
    await expect(freeVal).toBeVisible();
    await expect(freeVal).toContainText("€");

    // Der dokumentierte Termin erzeugt einen Konsum-Anteil im Balken. FIFO bucht
    // ihn in den ersten Topf mit Restguthaben (Übertrag im H1, sonst laufendes
    // Jahr); die genaue Konsum-Klasse (abgerechnet/dokumentiert/sonstiger) hängt
    // am Termin-Zustand (z.B. Unterschrift) — daher prüfen wir Topf- und
    // Klassen-unabhängig auf mindestens einen Konsum-Wert mit €-Text.
    const consumedVal = page
      .locator("[data-testid^='fifo-val-'][data-testid*='-consumed']")
      .first();
    await expect(consumedVal).toBeVisible();
    await expect(consumedVal).toContainText("€");
  });
});
