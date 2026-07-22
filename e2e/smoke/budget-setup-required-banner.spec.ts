import { test, expect } from "@playwright/test";
import {
  apiPut,
  applyAuthToBrowser,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import { createCustomer } from "../helpers/test-data";

// Task #738 / Task #1828 — Smoke-Pfad „Budget-Setup-Banner".
//
// Der Banner „Budget-Töpfe noch nicht eingerichtet" hängt seit Task #1828 an
// der Aktivierungs-SSoT (aktiver Topf vorhanden?), NICHT mehr an „existiert
// eine persistierte DB-Zeile?". §45b ist für jeden Pflegekassen-Kunden
// default-aktiv. Daraus folgen zwei Smoke-Garantien:
//   1) Ein frischer Pflegekassen-Kunde (PG 4) ohne `budgets`-Block hat bereits
//      einen aktiven §45b-Topf ⇒ der Banner darf NICHT erscheinen (Kern-
//      Regression: früher feuerte er fälschlich).
//   2) Deaktiviert man alle Töpfe (kein aktiver Topf mehr), MUSS der Banner
//      erscheinen und der CTA „Budgets jetzt einrichten" in den Budgets-Tab
//      navigieren.

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
  test("Pflegekasse-Kunde: default-aktiver §45b → kein Banner; nach Deaktivieren aller Töpfe → Banner + CTA", async ({ page }) => {
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

    // 2) Kern-Regression (Task #1828): §45b ist default-aktiv ⇒ der Kunde hat
    //    bereits einen nutzbaren Topf ⇒ der Banner darf NICHT erscheinen.
    await page.goto(`/admin/customers/${customer.id}`, { waitUntil: "domcontentloaded" });

    const banner = page.locator("[data-testid='banner-budget-setup-required']");
    // Kurze aktive Wartezeit, damit die type-settings-Query gelaufen ist, bevor
    // wir die Abwesenheit prüfen (nicht nur den Initial-Render erwischen).
    await page.waitForLoadState("networkidle");
    await expect(banner).toHaveCount(0);

    // 3) Alle Töpfe deaktivieren (Deaktivieren ist immer erlaubt) ⇒ kein aktiver
    //    Topf mehr. Der Server-Marker/UI muss den Banner nun zeigen.
    const disableRes = await apiPut(session, `/api/budget/${customer.id}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(disableRes.status, `disable type-settings: ${disableRes.status}`).toBe(200);

    // 4) Detail-Seite neu laden ⇒ Banner muss erscheinen.
    await page.goto(`/admin/customers/${customer.id}`, { waitUntil: "domcontentloaded" });
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText("Budget-Töpfe noch nicht eingerichtet");

    // 5) CTA klicken → Tab wechselt nach „budgets" (URL + aktiver Tab).
    await page.locator("[data-testid='button-budget-setup-open']").click();

    await expect(page).toHaveURL(/\?tab=budgets(?:$|&)/, { timeout: 5000 });
    const budgetsTab = page.locator("[data-testid='tab-budgets']");
    await expect(budgetsTab).toHaveAttribute("data-state", "active", { timeout: 5000 });
  });
});
