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

// Task #520: Smoke-Test für den Drill-Down
// `/service-records` → "Offene Termine anzeigen" → `/service-records/open`
// → Klick auf einen Termin → `/appointment/:id?from=...` → "Zurück" muss
// zurück auf die Offene-Termine-Liste führen (nicht auf den Tagesplan).

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

test.describe("@smoke Offene Termine Drill-Down", () => {
  test("Offene Termine → Termindetail → Zurück bleibt in der Liste", async ({ page }) => {
    const customer = await createCustomer(session);
    const employee = await createEmployee(session);
    await assignEmployee(session, customer.id, employee.id);
    const appt = await createAppointment(session, {
      customerId: customer.id,
      employeeId: employee.id,
    });

    // Jahr/Monat aus dem Termindatum ableiten — `createAppointment` benutzt
    // `nextWeekday(7)`, kann also über eine Monatsgrenze rutschen.
    const [yearStr, monthStr] = appt.date.split("-");
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    try {
      // Admin sieht den Termin nur, wenn er sich in die Mitarbeiter-Sicht
      // versetzt — sonst filtert `/check-period` per employeeFilter(adminId)
      // den frisch zugewiesenen Test-Termin heraus.
      await page.addInitScript((empId: number) => {
        try {
          window.sessionStorage.setItem("viewAsEmployeeId", String(empId));
          window.sessionStorage.setItem("viewAsEmployeeName", "E2E");
        } catch {
          /* ignore */
        }
      }, employee.id);

      // 1) Leistungsnachweis öffnen.
      await page.goto(
        `/service-records?customerId=${customer.id}&year=${year}&month=${month}`,
        { waitUntil: "domcontentloaded" },
      );

      // 2) "Offene Termine anzeigen" klicken.
      const openButton = page.locator("[data-testid='button-to-appointments']");
      await expect(openButton).toBeVisible({ timeout: 15000 });
      await openButton.click();

      // 3) Liste lädt unter /service-records/open.
      await expect(page).toHaveURL(/\/service-records\/open\?/);
      const apptCard = page.locator(`[data-testid='item-appointment-${appt.id}']`);
      await expect(apptCard).toBeVisible({ timeout: 15000 });

      // 4) Termin anklicken → Termindetail mit `from=`-Param.
      await apptCard.locator(`[data-testid='card-appointment-${appt.id}']`).click();
      await expect(page).toHaveURL(
        new RegExp(`/appointment/${appt.id}\\?from=`),
      );

      // 5) "Zurück" muss zurück auf die Offene-Termine-Liste führen
      //    (nicht auf den Tagesplan `/?date=...`).
      const backBtn = page.locator("[data-testid='button-back']");
      await expect(backBtn).toBeVisible({ timeout: 10000 });
      await backBtn.click();

      await expect(page).toHaveURL(/\/service-records\/open\?/);
      // Liste ist wieder gerendert.
      await expect(
        page.locator(`[data-testid='item-appointment-${appt.id}']`),
      ).toBeVisible({ timeout: 15000 });
    } finally {
      await deactivateEmployee(session, employee.id);
    }
  });
});
