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

// Findet den `nth`. Werktag (Mo–Fr) eines Monats als YYYY-MM-DD.
// Termine dürfen nicht auf Sa/So fallen; wir wählen bewusst feste Werktage,
// um Ziel- und Nachbarmonat exakt zu steuern.
function weekdayInMonth(year: number, month: number, nth = 1): string {
  const d = new Date(year, month - 1, 1);
  let count = 0;
  for (;;) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      count++;
      if (count >= nth) break;
    }
    d.setDate(d.getDate() + 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

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

  // Task #1750: Beweist end-to-end mit echtem Backend, dass
  // `/service-records/open` (bzw. `/appointments/undocumented/by-customer`)
  // die `customerId`/`year`/`month`-Parameter serverseitig wirklich filtert.
  // Der jsdom/RTL-Test (tests/unit/open-appointments-scope.test.tsx) mockt den
  // API-Client und würde eine Backend-Regression (ignorierter Param) NICHT
  // erkennen. Hier werden zwei Kunden und zwei Monate mit echten Daten
  // geseedet, und es wird geprüft, dass nur die Termine des Zielkunden im
  // Zielmonat sichtbar sind — Fremdkunde und Nachbarmonat bleiben aus.
  test("Offene Termine sind auf customerId + year + month gescoped", async ({ page }) => {
    const targetCustomer = await createCustomer(session);
    const foreignCustomer = await createCustomer(session);
    const employee = await createEmployee(session);
    await assignEmployee(session, targetCustomer.id, employee.id);
    await assignEmployee(session, foreignCustomer.id, employee.id);

    // Zielmonat = nächster Monat, Nachbarmonat = übernächster Monat.
    // Beide liegen in der Zukunft, sodass die Termine gültig anlegbar sind.
    const now = new Date();
    const targetBase = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const targetYear = targetBase.getFullYear();
    const targetMonth = targetBase.getMonth() + 1;
    const neighbourBase = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const neighbourYear = neighbourBase.getFullYear();
    const neighbourMonth = neighbourBase.getMonth() + 1;

    // Verschiedene Werktage/Zeiten, damit derselbe Mitarbeiter nicht
    // doppelt gebucht wird.
    const targetAppt = await createAppointment(session, {
      customerId: targetCustomer.id,
      employeeId: employee.id,
      date: weekdayInMonth(targetYear, targetMonth, 2),
      scheduledStart: "09:00",
    });
    // Zielkunde, aber im Nachbarmonat → darf NICHT erscheinen.
    const neighbourMonthAppt = await createAppointment(session, {
      customerId: targetCustomer.id,
      employeeId: employee.id,
      date: weekdayInMonth(neighbourYear, neighbourMonth, 2),
      scheduledStart: "11:00",
    });
    // Fremdkunde im Zielmonat → darf NICHT erscheinen.
    const foreignAppt = await createAppointment(session, {
      customerId: foreignCustomer.id,
      employeeId: employee.id,
      date: weekdayInMonth(targetYear, targetMonth, 3),
      scheduledStart: "13:00",
    });

    try {
      // In die Mitarbeiter-Sicht versetzen (wie im Drill-Down-Test), sonst
      // filtert der Admin-Scope den frisch zugewiesenen Termin heraus.
      await page.addInitScript((empId: number) => {
        try {
          window.sessionStorage.setItem("viewAsEmployeeId", String(empId));
          window.sessionStorage.setItem("viewAsEmployeeName", "E2E");
        } catch {
          /* ignore */
        }
      }, employee.id);

      await page.goto(
        `/service-records/open?customerId=${targetCustomer.id}&year=${targetYear}&month=${targetMonth}`,
        { waitUntil: "domcontentloaded" },
      );

      // Der Ziel-Termin ist sichtbar.
      await expect(
        page.locator(`[data-testid='item-appointment-${targetAppt.id}']`),
      ).toBeVisible({ timeout: 15000 });

      // Genau EIN Termin in der Liste — Fremdkunde und Nachbarmonat sind
      // serverseitig herausgefiltert.
      await expect(page.locator("[data-testid='text-count']")).toContainText(
        "1 Termin",
      );
      await expect(
        page.locator(`[data-testid='item-appointment-${neighbourMonthAppt.id}']`),
      ).toHaveCount(0);
      await expect(
        page.locator(`[data-testid='item-appointment-${foreignAppt.id}']`),
      ).toHaveCount(0);
    } finally {
      await deactivateEmployee(session, employee.id);
    }
  });
});
