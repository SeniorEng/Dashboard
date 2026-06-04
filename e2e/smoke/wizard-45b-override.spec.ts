import { test, expect, type Page } from "@playwright/test";
import {
  applyAuthToBrowser,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";

// §45b "Aktuelles Restguthaben (laufendes Jahr)"-Override im Neuanlage-Wizard
// (Task #962, baut auf Task #960 auf). Drei Fälle:
//  1. Override AN  → genau EINE §45b-`initial_balance`-Allokation im gewählten
//     Stichmonat mit dem erfassten Betrag.
//  2. Override AUS → KEINE §45b-`initial_balance`-Allokation, aber §45b-
//     Type-Settings (enabled) + Vorjahres-Carryover existieren.
//  3. Client-seitiges Maximum (`max45bStartValueCents`) blockt einen Betrag
//     über dem Cap (Inline-Fehler + kein Weiterschalten).
//
// Verifikation ausschließlich über die JSON-API (kein DB-Zugriff im e2e).
// Skip ohne TEST_USER_*-Creds (analog edit-persistence.spec.ts).

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

// ---------------------------------------------------------------------------
// API-Typen (Teilmengen der Server-Responses, nur was wir prüfen)
// ---------------------------------------------------------------------------
interface BudgetAllocationRow {
  budgetType: string;
  source: string;
  year: number;
  month: number | null;
  amountCents: number;
}
interface TypeSettingRow {
  budgetType: string;
  enabled: boolean;
}

async function getAllocations(customerId: number): Promise<BudgetAllocationRow[]> {
  // initial_balance wird im createMutation-onSuccess VOR der Navigation
  // gepostet; ein kleiner Poll fängt trotzdem etwaige Timing-Restanten ab.
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await session.api.get(`/api/budget/${customerId}/allocations`);
    if (res.ok()) {
      const rows = (await res.json()) as BudgetAllocationRow[];
      if (rows.length > 0 || attempt >= 4) return rows;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return [];
}

async function getTypeSettings(customerId: number): Promise<TypeSettingRow[]> {
  const res = await session.api.get(`/api/budget/${customerId}/type-settings`);
  expect(res.ok(), `type-settings GET fehlgeschlagen für Kunde ${customerId}`).toBeTruthy();
  return (await res.json()) as TypeSettingRow[];
}

// ---------------------------------------------------------------------------
// DatePicker-Treiber (Popover, nicht direkt befüllbar)
// ---------------------------------------------------------------------------
async function pickDate(
  page: Page,
  triggerTestId: string,
  year: number,
  monthIndex: number,
  day: number,
): Promise<void> {
  await page.locator(`[data-testid='${triggerTestId}']`).scrollIntoViewIfNeeded();
  await page.locator(`[data-testid='${triggerTestId}']`).click();
  const pop = page.locator("[data-radix-popper-content-wrapper]").last();
  await expect(pop).toBeVisible();
  // Tage-Ansicht → Jahres-Ansicht
  await pop.locator("[data-testid='btn-quick-year-month']").click();
  // bei Bedarf zu früheren Jahres-Seiten blättern (alle Zieljahre ≤ aktuelles Jahr)
  for (let i = 0; i < 60; i++) {
    if ((await pop.locator(`[data-testid='btn-year-${year}']`).count()) > 0) break;
    await pop.locator("[data-testid='btn-year-page-prev']").click();
  }
  await pop.locator(`[data-testid='btn-year-${year}']`).click();
  await pop.locator(`[data-testid='btn-month-${monthIndex}']`).click();
  // Tage-Ansicht: Tag 15 ist nie ein "outside"-Tag → eindeutiger Text
  await pop.getByText(String(day), { exact: true }).click();
  await expect(pop).toBeHidden();
}

async function selectRadixOption(
  page: Page,
  triggerTestId: string,
  optionName: string,
): Promise<void> {
  await page.locator(`[data-testid='${triggerTestId}']`).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

// Schritte bis inkl. Budgets ausfüllen; lässt den Wizard auf dem Budgets-Schritt.
async function fillUntilBudgets(
  page: Page,
  opts: {
    pflegegradSeit: { year: number; monthIndex: number };
    contractStart?: { year: number; monthIndex: number };
    email: string;
  },
): Promise<void> {
  const stamp = `${Date.now().toString().slice(-7)}_${Math.random().toString(36).slice(2, 6)}`;

  await page.goto("/admin/customers/new", { waitUntil: "domcontentloaded" });

  // Schritt 1: Kundentyp (auto-advance ~150ms nach Klick)
  await page.locator("[data-testid='card-billing-type-pflegekasse_gesetzlich']").click();
  await expect(page.locator("[data-testid='input-vorname']")).toBeVisible();

  // Schritt 2: Persönliche Daten
  await page.locator("[data-testid='input-vorname']").fill("E2E");
  await page.locator("[data-testid='input-nachname']").fill(`Override_${stamp}`);
  await pickDate(page, "input-geburtsdatum", 1940, 0, 15);
  await page.locator("[data-testid='input-email']").fill(opts.email);
  await page.locator("[data-testid='input-strasse']").fill("Teststraße");
  await page.locator("[data-testid='input-nr']").fill("1");
  await page.locator("[data-testid='input-plz']").fill("10115");
  await page.locator("[data-testid='input-stadt']").fill("Berlin");
  await page.locator("[data-testid='button-step-next']").click();
  // Duplikatprüfung (GET check-duplicate) läuft; eindeutige Namen → kein Dialog.
  await expect(page.locator("[data-testid='input-vorname']")).toBeHidden();

  // Schritt 3: Pflegekasse (Provider leer lassen → keine Validierung) → weiter
  await page.locator("[data-testid='button-step-next']").click();
  await expect(page.locator("[data-testid='input-contract-date']")).toBeVisible();

  // Schritt 4: Vertrag
  if (opts.contractStart) {
    await pickDate(page, "input-contract-start", opts.contractStart.year, opts.contractStart.monthIndex, 15);
  }
  await page.locator("[data-testid='input-vereinbarte-leistungen']").fill("E2E Testleistung");
  await page.locator("[data-testid='button-step-next']").click();

  // Schritt 5: Budgets
  await expect(page.locator("[data-testid='select-pflegegrad-budget']")).toBeVisible();
  await selectRadixOption(page, "select-pflegegrad-budget", "Pflegegrad 3");
  await pickDate(page, "input-pflegegrad-seit-budget", opts.pflegegradSeit.year, opts.pflegegradSeit.monthIndex, 15);
  // §45b ist standardmäßig aktiviert — nichts weiter nötig.
}

// Vom Budgets-Schritt bis zum Submit klicken und die erzeugte Kunden-ID
// aus der Ziel-URL extrahieren.
async function submitAndGetCustomerId(page: Page): Promise<number> {
  // budgets → contacts
  await page.locator("[data-testid='button-step-next']").click();
  // contacts → signatures → delivery → matching (keine Pflichtfelder)
  for (let i = 0; i < 3; i++) {
    await page.locator("[data-testid='button-step-next']").click();
  }
  await expect(page.locator("[data-testid='button-submit']")).toBeVisible();
  await page.locator("[data-testid='button-submit']").click();
  await page.waitForURL(/\/admin\/customers\/\d+(\?.*)?$/, { timeout: 30000 });
  const match = page.url().match(/\/admin\/customers\/(\d+)/);
  expect(match, `Keine Kunden-ID in Ziel-URL: ${page.url()}`).not.toBeNull();
  return Number(match![1]);
}

test.describe("@smoke §45b Restguthaben-Override (Wizard)", () => {
  // ----------------------------------------------------------------------
  // Fall 1: Override AN → genau eine §45b initial_balance-Zeile
  // ----------------------------------------------------------------------
  test("Override AN erzeugt genau eine §45b initial_balance-Allokation", async ({ page }) => {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1; // 1-basiert

    await fillUntilBudgets(page, {
      // Pflegegrad-Beginn = Januar dieses Jahres → Cap = curMonth × 131 € (≥ 131 €).
      pflegegradSeit: { year: curYear, monthIndex: 0 },
      email: `e2e-45b-on-${Date.now()}@test.local`,
    });

    // Override aktivieren; Stichmonat-Default = aktueller Monat. 50 € liegt
    // immer unter dem Cap (min. 131 € im Januar).
    await page.locator("[data-testid='checkbox-restguthaben-override']").click();
    await expect(page.locator("[data-testid='input-restguthaben-stichmonat']")).toBeVisible();
    await page.locator("[data-testid='input-restguthaben-45b']").fill("50");

    const customerId = await submitAndGetCustomerId(page);

    const allocations = await getAllocations(customerId);
    const initialBalance45b = allocations.filter(
      (a) => a.budgetType === "entlastungsbetrag_45b" && a.source === "initial_balance",
    );
    expect(
      initialBalance45b.length,
      `Erwartet genau eine §45b initial_balance-Zeile, gefunden: ${JSON.stringify(allocations)}`,
    ).toBe(1);
    expect(initialBalance45b[0].amountCents).toBe(5000);
    expect(initialBalance45b[0].year).toBe(curYear);
    expect(initialBalance45b[0].month).toBe(curMonth);
  });

  // ----------------------------------------------------------------------
  // Fall 2: Override AUS → keine initial_balance, aber Settings + Carryover
  // ----------------------------------------------------------------------
  test("Override AUS: keine §45b initial_balance, aber Type-Settings + Carryover", async ({ page }) => {
    const curYear = new Date().getFullYear();

    await fillUntilBudgets(page, {
      // Pflegegrad seit Vorjahr → 12 berechtigte Monate (Carryover-Cap = 1572 €).
      pflegegradSeit: { year: curYear - 1, monthIndex: 0 },
      // Vertragsbeginn Januar dieses Jahres (< 1.7.) → Carryover-Feld sichtbar.
      contractStart: { year: curYear, monthIndex: 0 },
      email: `e2e-45b-off-${Date.now()}@test.local`,
    });

    // Override bleibt AUS (Default). Vorjahres-Übertrag = 100 €.
    await expect(page.locator("[data-testid='input-uebertrag-45b']")).toBeVisible();
    await page.locator("[data-testid='input-uebertrag-45b']").fill("100");

    const customerId = await submitAndGetCustomerId(page);

    const allocations = await getAllocations(customerId);
    const initialBalance45b = allocations.filter(
      (a) => a.budgetType === "entlastungsbetrag_45b" && a.source === "initial_balance",
    );
    expect(
      initialBalance45b.length,
      `Erwartet KEINE §45b initial_balance-Zeile, gefunden: ${JSON.stringify(allocations)}`,
    ).toBe(0);

    const carryover45b = allocations.filter(
      (a) => a.budgetType === "entlastungsbetrag_45b" && a.source === "carryover",
    );
    // §45b-Carryover muss existieren (Task #962). Hinweis: der Wizard schreibt
    // den Carryover aktuell über zwei Pfade (create-Payload `budgets` UND
    // /initial-budget), daher können mehrere identische carryover-Zeilen
    // entstehen — wir prüfen daher Existenz + erfassten Betrag, nicht die
    // exakte Zeilenzahl. (Doppelschreibung ist ein separater Follow-up.)
    expect(
      carryover45b.length,
      `Erwartet mind. eine §45b carryover-Zeile, gefunden: ${JSON.stringify(allocations)}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      carryover45b.some((r) => r.amountCents === 10000),
      `Keine §45b carryover-Zeile mit 100,00 €, gefunden: ${JSON.stringify(carryover45b)}`,
    ).toBe(true);

    const settings = await getTypeSettings(customerId);
    const setting45b = settings.find((s) => s.budgetType === "entlastungsbetrag_45b");
    expect(setting45b, "§45b Type-Setting fehlt").toBeTruthy();
    expect(setting45b!.enabled, "§45b Type-Setting nicht enabled").toBe(true);
  });

  // ----------------------------------------------------------------------
  // Fall 3: Über-Cap-Betrag wird client-seitig geblockt
  // ----------------------------------------------------------------------
  test("Über-Cap-Restguthaben wird client-seitig geblockt", async ({ page }) => {
    const curYear = new Date().getFullYear();

    await fillUntilBudgets(page, {
      pflegegradSeit: { year: curYear, monthIndex: 0 },
      email: `e2e-45b-cap-${Date.now()}@test.local`,
    });

    await page.locator("[data-testid='checkbox-restguthaben-override']").click();
    await expect(page.locator("[data-testid='input-restguthaben-45b']")).toBeVisible();
    // 9999 € liegt immer über dem Cap (max. 12 × 131 € = 1572 €).
    await page.locator("[data-testid='input-restguthaben-45b']").fill("9999");

    // Inline-Fehler erscheint sofort (client-seitiger Cap aus max45bStartValueCents).
    await expect(page.getByText(/Maximal .* € möglich/)).toBeVisible();

    // Weiter-Klick wird geblockt (getStepErrors verhindert den Schrittwechsel):
    // der Wizard bleibt auf dem Budgets-Schritt stehen.
    await page.locator("[data-testid='button-step-next']").click();
    // Kurz warten, damit ein etwaiger (fehlerhafter) Schrittwechsel sichtbar würde.
    await page.waitForTimeout(500);
    await expect(page.locator("[data-testid='input-restguthaben-45b']")).toBeVisible();
    await expect(page.locator("[data-testid='select-pflegegrad-budget']")).toBeVisible();
    // Inline-Fehler steht weiterhin (Betrag immer noch über dem Cap).
    await expect(page.getByText(/Maximal .* € möglich/)).toBeVisible();
  });
});
