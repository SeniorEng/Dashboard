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
  createSingleServiceRecord,
  deactivateEmployee,
  documentAppointment,
  getServiceIdByCode,
} from "../helpers/test-data";

// Mobile-Layout-Smoke-Test für die Termin-Detail-Seite (#464).
// Schützt vor Regression des Layout-Bugs, bei dem auf schmalen Viewports
// (375 px) die Geplant/Ist-Werte in der "Gesamt"-Zeile umbrachen und der
// "Leistungsnachweis unterschreiben"-Button am rechten Rand abgeschnitten war.

const creds = getAdminCreds();
test.skip(!creds, "TEST_USER_EMAIL/TEST_USER_PASSWORD nicht gesetzt — Smoke-Suite übersprungen.");

const MOBILE_VIEWPORT = { width: 375, height: 812 };

let session: ApiSession;

test.beforeAll(async () => {
  session = await loginApiSession(creds!);
});

test.afterAll(async () => {
  if (session) await session.api.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.setViewportSize?.(MOBILE_VIEWPORT);
  await applyAuthToBrowser(context, session);
});

test.describe("@smoke Termin-Detail Mobile-Layout", () => {
  test("abgeschlossener Termin mit Leistungsnachweis: CTA & Gesamt-Zeile bleiben im 375-px-Viewport intakt", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);

    // 1) Test-Daten: Kunde + Mitarbeiter + zugewiesener Termin
    const customer = await createCustomer(session);
    const employee = await createEmployee(session);
    await assignEmployee(session, customer.id, employee.id);
    const appointment = await createAppointment(session, {
      customerId: customer.id,
      employeeId: employee.id,
    });

    // 2) Termin dokumentieren → status = "completed" mit actualDurationMinutes
    const serviceId = await getServiceIdByCode(session, "hauswirtschaft");
    await documentAppointment(session, appointment.id, {
      serviceId,
      actualDurationMinutes: 60,
      actualStart: "10:00",
    });

    // 3) Single-Leistungsnachweis erstellen → render zeigt link-service-record
    await createSingleServiceRecord(session, {
      customerId: customer.id,
      appointmentId: appointment.id,
    });

    try {
      // 4) Termin-Detail-Seite öffnen
      await page.goto(`/appointment/${appointment.id}`, {
        waitUntil: "domcontentloaded",
      });

      const totalPlanned = page.locator("[data-testid='text-total-planned']");
      const totalActual = page.locator("[data-testid='text-total-actual']");
      await expect(totalPlanned).toBeVisible({ timeout: 10000 });
      await expect(totalActual).toBeVisible({ timeout: 10000 });

      // 5) Assertion A: Geplant + Ist in der Gesamt-Zeile stehen auf derselben
      // Höhe (kein Umbruch). Toleranz 4 px für Sub-Pixel-Rendering.
      const plannedBox = await totalPlanned.boundingBox();
      const actualBox = await totalActual.boundingBox();
      expect(plannedBox, "text-total-planned hat keine boundingBox").not.toBeNull();
      expect(actualBox, "text-total-actual hat keine boundingBox").not.toBeNull();
      const yDelta = Math.abs((plannedBox!.y) - (actualBox!.y));
      expect(
        yDelta,
        `Geplant- und Ist-Werte brechen um (Δy=${yDelta}px). ` +
          `Erwartet: gleiche Zeile (Δy ≤ 4px).`,
      ).toBeLessThanOrEqual(4);

      // Beide Werte dürfen außerdem nicht selbst über mehrere Zeilen brechen
      // (ein zweizeiliger Text wäre höher als ~28 px bei text-sm/font-semibold).
      expect(plannedBox!.height).toBeLessThanOrEqual(32);
      expect(actualBox!.height).toBeLessThanOrEqual(32);

      // 6) Assertion B: link-service-record vollständig im sichtbaren Bereich.
      const cta = page.locator("[data-testid='link-service-record']");
      await expect(cta).toBeVisible();
      const ctaBox = await cta.boundingBox();
      expect(ctaBox, "link-service-record hat keine boundingBox").not.toBeNull();
      expect(ctaBox!.x, "CTA beginnt links außerhalb des Viewports")
        .toBeGreaterThanOrEqual(0);
      expect(
        ctaBox!.x + ctaBox!.width,
        `CTA wird rechts abgeschnitten (right=${ctaBox!.x + ctaBox!.width}, viewport=${MOBILE_VIEWPORT.width}).`,
      ).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    } finally {
      await deactivateEmployee(session, employee.id);
    }
  });
});
