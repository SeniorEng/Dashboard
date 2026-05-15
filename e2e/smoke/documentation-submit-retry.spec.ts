import { test, expect } from "@playwright/test";
import {
  applyAuthToBrowser,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import {
  assignEmployee,
  createAppointment,
  createCustomer,
  createEmployee,
  deactivateEmployee,
} from "../helpers/test-data";

// Mobile-Doku Submit-Resilienz (#490). Verifiziert, dass beim POST
// /appointments/:id/document
//   • ein 503-Antwort einen persistenten Fehler-Banner mit "Erneut speichern"
//     erzeugt (Retries des Helpers sind erschöpft),
//   • nach Klick auf den Retry-Button bei wiederhergestellter Verbindung der
//     Erfolgs-Banner kommt,
//   • ein 403 ALREADY_COMPLETED den spezifischen Hinweis zeigt und automatisch
//     zurück zur Tagesübersicht navigiert.

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

async function setupAppointment() {
  const customer = await createCustomer(session);
  const employee = await createEmployee(session);
  await assignEmployee(session, customer.id, employee.id);
  const appointment = await createAppointment(session, {
    customerId: customer.id,
    employeeId: employee.id,
  });
  return { appointment, employee };
}

async function gotoStep2(page: import("@playwright/test").Page, appointmentId: number) {
  await page.goto(`/document-appointment/${appointmentId}`);
  await expect(page.locator("[data-testid='input-actual-start']")).toBeVisible();
  // Termin liefert genau eine Hauswirtschaft-Position (siehe createAppointment-Helper).
  await page
    .locator("[data-testid='input-details-hauswirtschaft']")
    .fill("E2E-Test: Submit-Resilienz");
  await page.locator("[data-testid='button-next']").click();
  await expect(page.locator("[data-testid='button-submit']")).toBeVisible();
}

test.describe("@smoke Doku-Submit Resilienz (#490)", () => {
  test("zeigt Fehler-Banner bei 503, gespeichert nach Retry", async ({ page, context }) => {
    const { appointment, employee } = await setupAppointment();
    const docUrl = `**/api/appointments/${appointment.id}/document`;

    let blockSubmit = true;
    let attemptCount = 0;
    await context.route(docUrl, async (route) => {
      attemptCount += 1;
      if (blockSubmit) {
        // Reale Server-Antwort ist flach (siehe `server/lib/errors.ts`
        // `errorMiddleware`): { code, message } — kein `success`-Envelope.
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "SERVICE_UNAVAILABLE",
            message: "Service Unavailable",
          }),
        });
        return;
      }
      await route.continue();
    });

    try {
      await gotoStep2(page, appointment.id);
      await page.locator("[data-testid='button-submit']").click();

      // Der Helper retried 2x intern → Banner muss am Ende sichtbar sein.
      await expect(page.locator("[data-testid='banner-submit-error']")).toBeVisible({ timeout: 15000 });
      await expect(page.locator("[data-testid='button-retry-submit']")).toBeVisible();
      // Mindestens 3 Versuche (initial + 2 Retries) müssen am Server gelandet sein.
      expect(attemptCount).toBeGreaterThanOrEqual(3);

      // Verbindung wieder freigeben und auf "Erneut speichern" klicken.
      blockSubmit = false;
      attemptCount = 0;
      await page.locator("[data-testid='button-retry-submit']").click();

      await expect(page.locator("[data-testid='banner-submit-success']")).toBeVisible({
        timeout: 15000,
      });
      // Genau ein Server-Hit für den manuellen Retry — keine zusätzlichen
      // Auto-Retries auf 2xx.
      expect(attemptCount).toBe(1);
    } finally {
      await context.unroute(docUrl);
      await deactivateEmployee(session, employee.id);
    }
  });

  test("ALREADY_COMPLETED zeigt spezifische Meldung und sperrt Retry", async ({ page, context }) => {
    const { appointment, employee } = await setupAppointment();
    const docUrl = `**/api/appointments/${appointment.id}/document`;

    let attemptCount = 0;
    await context.route(docUrl, async (route) => {
      attemptCount += 1;
      // Reale Server-Antwort: flacher Body { code, message, error }
      // (siehe `forbidden()` in `server/lib/errors.ts`).
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          code: "FORBIDDEN",
          error: "ALREADY_COMPLETED",
          message: "Dieser Termin wurde bereits dokumentiert",
        }),
      });
    });

    try {
      await gotoStep2(page, appointment.id);
      await page.locator("[data-testid='button-submit']").click();

      const banner = page.locator("[data-testid='banner-submit-error']");
      await expect(banner).toBeVisible({ timeout: 10000 });
      await expect(
        page.locator("[data-testid='text-submit-error-message']"),
      ).toContainText(/bereits abgeschlossen/i);
      // Keine Retry-Button bei finalen 4xx-Fehlern.
      await expect(page.locator("[data-testid='button-retry-submit']")).toHaveCount(0);
      // 4xx ist NIE retry-fähig → genau ein Versuch.
      expect(attemptCount).toBe(1);
    } finally {
      await context.unroute(docUrl);
      await deactivateEmployee(session, employee.id);
    }
  });
});
