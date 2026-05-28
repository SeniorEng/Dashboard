import { test, expect } from "@playwright/test";
import {
  applyAuthToBrowser,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import { createCustomer } from "../helpers/test-data";

// Task #738 — Smoke-Pfad „Budget-Setup-Banner".
//
// Verhindert, dass ein zukünftiger Refactor an `GET /api/budget/:id/type-
// settings` (z.B. id-Befüllung der Default-Platzhalter) den Banner
// „Budget-Töpfe noch nicht eingerichtet" unbemerkt dauerhaft ein- oder
// ausblendet. Wir legen einen frischen Pflegekasse-Kunden (PG 4) ohne
// `budgets`-Block an — der Server signalisiert `budgetSetupRequired=true`
// und das UI muss den Banner zeigen. Der CTA „Budgets jetzt einrichten"
// muss in den Budgets-Tab navigieren.

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

test.describe("@smoke Budget-Setup-Banner — Sichtbarkeit & CTA", () => {
  test("Pflegekasse-Kunde ohne Töpfe → Banner sichtbar, CTA wechselt in den Budgets-Tab", async ({ page }) => {
    // 1) Frischer Pflegekassen-Kunde ohne `budgets`-Block. Die `insurance`-
    //    Daten kommen aus dem ersten verfügbaren Insurance-Provider — exakt
    //    derselbe Weg wie in tests/customer-create-budget-setup-marker.test.ts.
    const provRes = await session.api.get("/api/admin/insurance-providers");
    expect(provRes.ok(), `list insurance providers: ${provRes.status()}`).toBeTruthy();
    const providers = (await provRes.json()) as Array<{ id: number }>;
    expect(providers.length, "Keine Insurance-Provider in der Test-DB").toBeGreaterThan(0);

    const versNr = "A" + String(Math.floor(100000000 + Math.random() * 900000000));
    const customer = await createCustomer(session, {
      billingType: "pflegekasse_gesetzlich",
      pflegegrad: 4,
      pflegegradSeit: "2024-01-01",
      acceptsPrivatePayment: false,
      insurance: {
        providerId: providers[0].id,
        versichertennummer: versNr,
        validFrom: "2024-01-01",
      },
    });

    // 2) Detail-Seite öffnen, Banner muss erscheinen.
    await page.goto(`/admin/customers/${customer.id}`, { waitUntil: "domcontentloaded" });

    const banner = page.locator("[data-testid='banner-budget-setup-required']");
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText("Budget-Töpfe noch nicht eingerichtet");

    // 3) CTA klicken → Tab wechselt nach „budgets" (URL + aktiver Tab).
    await page.locator("[data-testid='button-budget-setup-open']").click();

    await expect(page).toHaveURL(/\?tab=budgets(?:$|&)/, { timeout: 5000 });
    const budgetsTab = page.locator("[data-testid='tab-budgets']");
    await expect(budgetsTab).toHaveAttribute("data-state", "active", { timeout: 5000 });
  });
});
