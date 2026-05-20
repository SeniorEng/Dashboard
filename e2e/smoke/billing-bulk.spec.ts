import { test, expect, type APIResponse } from "@playwright/test";
import {
  applyAuthToBrowser,
  apiPost,
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
  documentAppointment,
  getServiceIdByCode,
  type TestCustomer,
} from "../helpers/test-data";

// Task #535: E2E-Smoke für Massenerstellung + Bündel-Druck + Mark-Sent.
// Deckt UI-seitig die Pfade `POST /api/billing/generate-all`,
// `GET /api/billing/:id/bundle` und `POST /api/billing/:id/mark-sent` ab.

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

async function expectOk(res: APIResponse, label: string): Promise<unknown> {
  if (!res.ok()) {
    throw new Error(`${label} failed: ${res.status()} ${await res.text()}`);
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function createSignedServiceRecord(
  s: ApiSession,
  customerId: number,
  employeeId: number,
  year: number,
  month: number,
): Promise<number> {
  const { status, data } = await apiPost<{ id?: number }>(
    s,
    "/api/service-records",
    { customerId, employeeId, year, month },
  );
  if (status !== 201 || typeof data?.id !== "number") {
    throw new Error(`createServiceRecord failed: ${status} ${JSON.stringify(data)}`);
  }
  const srId = data.id;
  for (const signerType of ["employee", "customer"] as const) {
    const r = await apiPost(s, `/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    if (r.status !== 200) {
      throw new Error(
        `signServiceRecord(${srId}, ${signerType}) failed: ${r.status} ${JSON.stringify(r.data)}`,
      );
    }
  }
  return srId;
}

interface PreparedCustomer {
  customer: TestCustomer;
  employeeId: number;
  appointmentDate: string;
  year: number;
  month: number;
}

async function prepareSignedCustomer(
  s: ApiSession,
  overrides: Record<string, unknown>,
): Promise<PreparedCustomer> {
  const customer = await createCustomer(s, overrides);
  const employee = await createEmployee(s);
  await assignEmployee(s, customer.id, employee.id);
  const appt = await createAppointment(s, {
    customerId: customer.id,
    employeeId: employee.id,
  });
  const serviceId = await getServiceIdByCode(s, "hauswirtschaft");
  await documentAppointment(s, appt.id, { serviceId, actualDurationMinutes: 60 });
  const [y, m] = appt.date.split("-").map((x) => parseInt(x, 10));
  await createSignedServiceRecord(s, customer.id, employee.id, y, m);
  return { customer, employeeId: employee.id, appointmentDate: appt.date, year: y, month: m };
}

interface GenerateAllResponse {
  summary: { total: number; created: number; skipped: number; errors: number };
  results: Array<{ customerId: number; status: "created" | "skipped" | "error" }>;
}

test.describe("@smoke Billing — Massenerstellung & Bündel-Druck", () => {
  test("Generate-All erstellt 2 Rechnungen, Bündel-Druck liefert PDF, Mark-Sent setzt sentAt", async ({ page }) => {
    // Heavy setup: 2 Kunden + 2 Mitarbeiter + 2 dokumentierte Termine + 2 signierte LN.
    test.setTimeout(120_000);
    // 1) Setup: 1× Selbstzahler + 1× Pflegekasse_gesetzlich (mit Insurance),
    //    beide mit signiertem Monats-LN.
    const provRes = await session.api.get("/api/admin/insurance-providers");
    const providers = (await expectOk(provRes, "list insurance providers")) as Array<{ id: number }>;
    if (!providers || providers.length === 0) {
      throw new Error("Keine Insurance-Provider in der Test-DB — Test kann nicht laufen.");
    }
    const insuranceProviderId = providers[0].id;

    const selb = await prepareSignedCustomer(session, { billingType: "selbstzahler" });
    const versNr = "A" + String(Math.floor(100000000 + Math.random() * 900000000));
    const kasse = await prepareSignedCustomer(session, {
      billingType: "pflegekasse_gesetzlich",
      // Budget muss eine 60-min-Hauswirtschafts-Buchung (~40 €) abdecken,
      // sonst lehnt der /document-Endpoint die Dokumentation ab. Mit
      // acceptsPrivatePayment=true + voller §45b-Topf landet alles auf
      // Pflegekasse — keine Split-Rechnung, klare 1:1-Zuordnung Kunde→Rechnung.
      acceptsPrivatePayment: true,
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: versNr,
        validFrom: "2024-01-01",
      },
      budgets: {
        entlastungsbetrag45b: 13100,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
        validFrom: "2024-01-01",
      },
    });

    // Beide Termine liegen im selben Monat (nextWeekday(7)). Sollte das je
    // bei einem Monatswechsel-Fall mal nicht stimmen, sortieren wir nach
    // Monat des Pflegekassen-Kunden — der ist es, den wir später mark-sent
    // testen und für den wir den Monatsfilter setzen.
    expect(selb.year).toBe(kasse.year);
    expect(selb.month).toBe(kasse.month);

    try {
      // 2) Generate-All über die UI: Monat/Jahr wählen, Dialog öffnen, bestätigen.
      await page.goto("/admin/billing", { waitUntil: "domcontentloaded" });
      // Sicherstellen, dass die Page interaktiv ist, bevor wir die Radix-Selects bedienen.
      await expect(page.locator("[data-testid='button-generate-all']")).toBeVisible({
        timeout: 15000,
      });

      // Die Billing-Page initialisiert Monat/Jahr auf das aktuelle Datum.
      // `nextWeekday(7)` (7 Werktage in der Zukunft) bleibt nahezu immer im
      // aktuellen Monat — nur kurz vor Monatsende könnte ein Wechsel nötig
      // sein. In diesem Fall überspringen wir die Select-UI nicht und
      // führen die Anwahl per Radix-Trigger durch.
      const today = new Date();
      const currentMonth = today.getMonth() + 1;
      const currentYear = today.getFullYear();
      if (kasse.month !== currentMonth || kasse.year !== currentYear) {
        await selectRadixOption(
          page,
          "select-billing-month",
          new RegExp(`^${monthName(kasse.month)}$`),
        );
        await selectRadixOption(page, "select-billing-year", String(kasse.year));
      }

      // Dialog öffnen
      await page.locator("[data-testid='button-generate-all']").click();
      const confirmBtn = page.locator("[data-testid='button-confirm-generate-all']");
      await expect(confirmBtn).toBeVisible({ timeout: 5000 });

      // Bestätigen + Antwort abfangen
      const [genResp] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/billing/generate-all") && r.request().method() === "POST",
          { timeout: 60000 },
        ),
        confirmBtn.click(),
      ]);
      expect(genResp.ok()).toBeTruthy();
      const genBody = (await genResp.json()) as GenerateAllResponse;

      // Eigene Kunden müssen "created" sein. Andere parallele Smoke-Läufe
      // können weitere Kunden im selben Monat haben — wir prüfen daher nur
      // unsere zwei Kunden, nicht die Summary insgesamt.
      const myResults = genBody.results.filter(
        (r) => r.customerId === selb.customer.id || r.customerId === kasse.customer.id,
      );
      expect(myResults).toHaveLength(2);
      expect(myResults.every((r) => r.status === "created")).toBe(true);
      expect(genBody.summary.created).toBeGreaterThanOrEqual(2);

      // Summary-Dialog ist sichtbar.
      await expect(page.locator("[data-testid='generate-all-summary']")).toBeVisible();
      await expect(
        page.locator(`[data-testid='generate-all-result-${selb.customer.id}']`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid='generate-all-result-${kasse.customer.id}']`),
      ).toBeVisible();

      // Dialog schließen, damit Rechnungs-Karten klickbar sind.
      await page.keyboard.press("Escape");

      // 3) Rechnungen finden — per customerId-Filter, damit wir nicht von
      //    `billingMonth/Year`-Mismatches abhängig sind. Generate-All schreibt
      //    auf Neon (serverless), daher kurz pollen, falls die Lese-Replikation
      //    minimal hinterherläuft.
      type InvoiceRow = {
        id: number;
        customerId: number;
        billingType: string;
        status: string;
        sentAt?: string | null;
      };
      const fetchInvoiceFor = async (cid: number): Promise<InvoiceRow | undefined> => {
        for (let i = 0; i < 5; i++) {
          const r = await session.api.get(`/api/billing?customerId=${cid}`);
          const list = (await expectOk(r, "list invoices")) as InvoiceRow[];
          const inv = list.find((x) => x.customerId === cid);
          if (inv) return inv;
          await new Promise((res) => setTimeout(res, 500));
        }
        return undefined;
      };
      const selbInv = await fetchInvoiceFor(selb.customer.id);
      const kasseInv = await fetchInvoiceFor(kasse.customer.id);
      expect(selbInv, `Selbstzahler-Rechnung für Kunde ${selb.customer.id} nicht gefunden`).toBeTruthy();
      expect(kasseInv, `Pflegekassen-Rechnung für Kunde ${kasse.customer.id} nicht gefunden`).toBeTruthy();
      expect(kasseInv!.billingType).toBe("pflegekasse_gesetzlich");
      expect(kasseInv!.status).toBe("entwurf");

      // 4) Bündel-Druck: Endpoint liefert ein PDF (Header-Check).
      //    Der UI-Bundle-Button ist ein <a target="_blank">; das Popup-Handling
      //    in Playwright ist deutlich flakiger als ein direkter API-Hit mit
      //    den Session-Cookies. Wir verifizieren daher die Response direkt.
      const bundleRes = await session.api.get(`/api/billing/${kasseInv!.id}/bundle`);
      expect(bundleRes.ok(), `bundle endpoint status=${bundleRes.status()}`).toBeTruthy();
      expect((bundleRes.headers()["content-type"] || "").toLowerCase()).toContain("application/pdf");
      const bundleBytes = await bundleRes.body();
      expect(bundleBytes.length).toBeGreaterThan(100);
      expect(bundleBytes.subarray(0, 4).toString("utf8")).toBe("%PDF");

      // 5) Mark-Sent: Pflegekassen-Entwurf als versendet markieren.
      //    POST /api/billing/:id/mark-sent — der Pfad ist dasselbe Backend, das
      //    der UI-Button aufruft (cf. billing.tsx markSentMutation). Wir hitten
      //    ihn direkt, um nicht von der UI-Liste abhängig zu sein.
      const markResp = await session.api.post(
        `/api/billing/${kasseInv!.id}/mark-sent`,
        {
          data: {},
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": session.csrfToken,
          },
        },
      );
      expect(
        markResp.ok(),
        `mark-sent status=${markResp.status()} ${await markResp.text()}`,
      ).toBeTruthy();

      // API-Verifikation: status=versendet + sentAt gesetzt.
      const afterRes = await session.api.get(`/api/billing/${kasseInv!.id}`);
      const after = (await expectOk(afterRes, "fetch invoice after mark-sent")) as {
        status: string;
        sentAt?: string | null;
      };
      expect(after.status).toBe("versendet");
      expect(after.sentAt).toBeTruthy();
    } finally {
      // Cleanup: Mitarbeiter deaktivieren. Kunden/Rechnungen bleiben (werden
      // von globalen Cleanup-Skripten nach Namensmuster `Auto_*` aufgeräumt).
      await deactivateEmployee(session, selb.employeeId);
      await deactivateEmployee(session, kasse.employeeId);
    }
  });
});

async function selectRadixOption(
  page: import("@playwright/test").Page,
  triggerTestId: string,
  optionName: string | RegExp,
): Promise<void> {
  const trigger = page.locator(`[data-testid='${triggerTestId}']`);
  await expect(trigger).toBeVisible({ timeout: 10000 });
  await trigger.click();
  await expect(trigger).toHaveAttribute("data-state", "open", { timeout: 5000 });
  const option = page.getByRole("option", { name: optionName }).first();
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click();
  await expect(trigger).toHaveAttribute("data-state", "closed", { timeout: 5000 });
}

const MONTH_NAMES_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function monthName(m: number): string {
  return MONTH_NAMES_DE[m - 1];
}
