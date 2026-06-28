import { test, expect, type Page, type APIResponse } from "@playwright/test";
import {
  applyAuthToBrowser,
  apiPost,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import {
  assignEmployee,
  createCustomer,
  createEmployee,
  deactivateEmployee,
  documentAppointment,
  getServiceIdByCode,
  nextWeekday,
  validSignatureDataUrl,
  type TestCustomer,
} from "../helpers/test-data";

// Task #1475: E2E-Smoke für die neu gebaute Abrechnungs-Seite (`/admin/billing`).
// Deckt ab, dass die Seite nicht still kaputtgehen kann:
//   1) KPI-Kacheln (Wirtschaftlicher Überblick), Status-Pipeline und die
//      Termine-Gruppen pro Mitarbeiter:in rendern mit echten Seed-Daten.
//   2) Ein Pipeline-Chip-Klick wechselt in den richtigen Tab UND setzt den
//      geteilten Status-Filter (frühe Stufe → Termine-Tab + Filter, späte
//      Stufe → Rechnungen-Tab mit der erzeugten Rechnung).
//   3) Der reine Sammeldruck-Dialog ist read-only — er ändert KEINEN
//      Rechnungs-Status.
//
// Bewusst KEIN Object-Storage-Gate: Rechnungs-Erzeugung (Entwurf-Datensatz) und
// die Read-Only-Garantie des Sammeldrucks gelten auch ohne Sidecar (in der CI
// liefert `/billing/bulk-print-preview` dann 500, mutiert aber nichts — genau
// das soll der Test absichern).

const creds = getAdminCreds();
test.skip(
  !creds,
  "TEST_USER_EMAIL/TEST_USER_PASSWORD nicht gesetzt — Smoke-Suite übersprungen.",
);

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
): Promise<void> {
  const { status, data } = await apiPost<{ id?: number }>(
    s,
    "/api/service-records",
    { customerId, employeeId, year, month },
  );
  if (status !== 201 || typeof data?.id !== "number") {
    throw new Error(`createServiceRecord failed: ${status} ${JSON.stringify(data)}`);
  }
  for (const signerType of ["employee", "customer"] as const) {
    const r = await apiPost(s, `/api/service-records/${data.id}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    if (r.status !== 200) {
      throw new Error(
        `signServiceRecord(${data.id}, ${signerType}) failed: ${r.status} ${JSON.stringify(r.data)}`,
      );
    }
  }
}

async function selectByTestId(
  page: Page,
  triggerTestId: string,
  optionTestId: string,
): Promise<void> {
  const trigger = page.locator(`[data-testid='${triggerTestId}']`);
  await expect(trigger).toBeVisible({ timeout: 10000 });
  await trigger.click();
  await expect(trigger).toHaveAttribute("data-state", "open", { timeout: 5000 });
  const option = page.locator(`[data-testid='${optionTestId}']`);
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click();
  await expect(trigger).toHaveAttribute("data-state", "closed", { timeout: 5000 });
}

// Inline-Terminanlage mit explizitem `scheduledStart` + geteiltem `date`. Der
// gemeinsame Helper (`createAppointment`) verdrahtet 10:00 + ein eigenes Datum
// fest; zwei Termine derselben Mitarbeiter:in würden so kollidieren
// (409 Terminüberschneidung). Beide Seed-Termine liegen daher am selben Tag,
// aber zu unterschiedlichen Uhrzeiten.
async function createAppointmentAt(
  s: ApiSession,
  opts: {
    customerId: number;
    employeeId: number;
    serviceId: number;
    date: string;
    scheduledStart: string;
  },
): Promise<{ id: number; date: string }> {
  const { status, data } = await apiPost<{ id?: number }>(
    s,
    "/api/appointments/kundentermin",
    {
      customerId: opts.customerId,
      assignedEmployeeId: opts.employeeId,
      date: opts.date,
      scheduledStart: opts.scheduledStart,
      services: [{ serviceId: opts.serviceId, durationMinutes: 60 }],
      notes: "",
    },
  );
  if (status !== 201 || typeof data?.id !== "number") {
    throw new Error(`createAppointmentAt failed: ${status} ${JSON.stringify(data)}`);
  }
  return { id: data.id, date: opts.date };
}

interface InvoiceRow {
  id: number;
  customerId: number;
  status: string;
}

async function fetchInvoiceFor(
  s: ApiSession,
  customerId: number,
): Promise<InvoiceRow | undefined> {
  for (let i = 0; i < 5; i++) {
    const r = await s.api.get(`/api/billing?customerId=${customerId}`);
    const list = (await expectOk(r, "list invoices")) as InvoiceRow[];
    const inv = list.find((x) => x.customerId === customerId);
    if (inv) return inv;
    await new Promise((res) => setTimeout(res, 500));
  }
  return undefined;
}

test.describe("@smoke Abrechnung — Seiten-Überblick", () => {
  test("KPIs/Pipeline/Termine rendern, Pipeline-Chip steuert Tab+Filter, Sammeldruck ist read-only", async ({ page }) => {
    // Schwere Vorbereitung: 2 Kunden + 1 Mitarbeiter:in + 2 dokumentierte
    // Termine, davon einer mit signiertem LN + erzeugter Entwurfs-Rechnung.
    test.setTimeout(120_000);

    const serviceId = await getServiceIdByCode(session, "hauswirtschaft");
    const employee = await createEmployee(session);
    // Gemeinsamer Termintag für beide Seed-Termine (eine Mitarbeiter:in →
    // EINE Termine-Gruppe mit Anzahl „2"); Kollision wird über verschiedene
    // Uhrzeiten vermieden.
    const apptDate = nextWeekday(7);

    // Kunde A: dokumentiert, ohne LN → Pipeline-/Termine-Stufe „dokumentiert".
    const custA = await createCustomer(session, { billingType: "selbstzahler" });
    await assignEmployee(session, custA.id, employee.id);
    const apptA = await createAppointmentAt(session, {
      customerId: custA.id,
      employeeId: employee.id,
      serviceId,
      date: apptDate,
      scheduledStart: "10:00",
    });
    await documentAppointment(session, apptA.id, {
      serviceId,
      actualDurationMinutes: 60,
    });

    // Kunde B: dokumentiert + signierter LN + erzeugte Rechnung → Pipeline-/
    // Termine-Stufe „rechnung_erstellt".
    const custB = await createCustomer(session, { billingType: "selbstzahler" });
    await assignEmployee(session, custB.id, employee.id);
    const apptB = await createAppointmentAt(session, {
      customerId: custB.id,
      employeeId: employee.id,
      serviceId,
      date: apptDate,
      scheduledStart: "12:00",
    });
    await documentAppointment(session, apptB.id, {
      serviceId,
      actualDurationMinutes: 60,
    });

    const [seedYear, seedMonth] = apptDate.split("-").map((x) => parseInt(x, 10));

    await createSignedServiceRecord(session, custB.id, employee.id, seedYear, seedMonth);

    let draftInvoice: InvoiceRow | undefined;

    try {
      // Rechnung für Kunde B erzeugen (Entwurf). Der PDF-Persist ist auf
      // Object-Storage gegated; der Entwurf-Datensatz entsteht trotzdem.
      const gen = await apiPost(session, "/api/billing/generate", {
        customerId: custB.id,
        billingMonth: seedMonth,
        billingYear: seedYear,
      });
      if (gen.status !== 200) {
        throw new Error(`generate invoice failed: ${gen.status} ${JSON.stringify(gen.data)}`);
      }
      draftInvoice = await fetchInvoiceFor(session, custB.id);
      expect(draftInvoice, `Entwurfs-Rechnung für Kunde ${custB.id} nicht gefunden`).toBeTruthy();
      expect(draftInvoice!.status).toBe("entwurf");

      // ---- Seite laden + auf den Seed-Monat stellen -----------------------
      await page.goto("/admin/billing", { waitUntil: "domcontentloaded" });
      const today = new Date();
      if (seedMonth !== today.getMonth() + 1 || seedYear !== today.getFullYear()) {
        await selectByTestId(page, "select-month", `option-month-${seedMonth}`);
        await selectByTestId(page, "select-year", `option-year-${seedYear}`);
      }

      // ---- (1a) KPI-Kacheln des Wirtschaftlichen Überblicks --------------
      await expect(page.locator("[data-testid='card-billing-economics']")).toBeVisible();
      const revenueKpi = page.locator("[data-testid='text-kpi-revenue']");
      await expect(revenueKpi).toBeVisible({ timeout: 15000 });
      await expect(revenueKpi).not.toHaveText("");
      await expect(page.locator("[data-testid='text-kpi-labor']")).toBeVisible();
      await expect(page.locator("[data-testid='text-kpi-margin']")).toBeVisible();
      await expect(page.locator("[data-testid='text-kpi-margin-percent']")).toBeVisible();

      // ---- (1b) Status-Pipeline: beide Seed-Stufen vorhanden -------------
      await expect(page.locator("[data-testid='card-billing-pipeline']")).toBeVisible();
      await expect(page.locator("[data-testid='pipeline-stage-dokumentiert']")).toBeVisible({
        timeout: 15000,
      });
      await expect(page.locator("[data-testid='pipeline-stage-rechnung_erstellt']")).toBeVisible();
      await expect(page.locator("[data-testid='text-pipeline-grand-total']")).toBeVisible();

      // ---- (1c) Termine-Gruppe pro Mitarbeiter:in ------------------------
      // Default-Tab ist „Termine". Unsere Gruppe enthält beide Termine (A+B).
      await expect(page.locator("[data-testid='bar-termine-chips']")).toBeVisible();
      const group = page.locator(`[data-testid='termine-employee-${employee.id}']`);
      await expect(group).toBeVisible({ timeout: 15000 });
      await expect(
        page.locator(`[data-testid='text-termine-count-${employee.id}']`),
      ).toHaveText("2");

      // ---- (2) Tab-Wechsel Termine ↔ Rechnungen verwalten ----------------
      await page.locator("[data-testid='tab-rechnungen']").click();
      await expect(page.locator("[data-testid='button-generate-all']")).toBeVisible();
      await page.locator("[data-testid='tab-termine']").click();
      await expect(page.locator("[data-testid='bar-termine-chips']")).toBeVisible();

      // ---- (3) Pipeline-Chip (frühe Stufe) → Termine-Tab + Status-Filter -
      // „dokumentiert" filtert die Termine-Liste: nur Termin A bleibt sichtbar,
      // Termin B (rechnung_erstellt) verschwindet. Das beweist Tab + geteilter
      // Filter in einem.
      await page.locator("[data-testid='pipeline-stage-dokumentiert']").click();
      await expect(page.locator("[data-testid='bar-termine-chips']")).toBeVisible();
      await expect(
        page.locator(`[data-testid='row-termine-appt-${apptA.id}']`),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.locator(`[data-testid='row-termine-appt-${apptB.id}']`),
      ).toHaveCount(0);

      // ---- (3b) Pipeline-Chip (späte Stufe) → Rechnungen-Tab -------------
      await page.locator("[data-testid='pipeline-stage-rechnung_erstellt']").click();
      await expect(page.locator("[data-testid='button-generate-all']")).toBeVisible();
      await expect(
        page.locator(`[data-testid='invoice-row-${draftInvoice!.id}']`),
      ).toBeVisible({ timeout: 15000 });

      // ---- (4) Sammeldruck ist read-only --------------------------------
      const before = (await expectOk(
        await session.api.get(`/api/billing/${draftInvoice!.id}`),
        "fetch invoice before Sammeldruck",
      )) as { status: string };
      expect(before.status).toBe("entwurf");

      await page.locator("[data-testid='button-sammeldruck']").click();
      await expect(page.locator("[data-testid='dialog-sammeldruck']")).toBeVisible();
      // Antwort abfangen (ok ODER 500 ohne Object Storage) — der Status-Check
      // unten gilt in beiden Fällen.
      const [printResp] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes("/api/billing/bulk-print-preview")
            && r.request().method() === "POST",
          { timeout: 60000 },
        ),
        page.locator("[data-testid='button-sammeldruck-invoices-only']").click(),
      ]);
      // Egal welcher Status — der Sammeldruck darf NICHTS mutieren.
      void printResp;

      const after = (await expectOk(
        await session.api.get(`/api/billing/${draftInvoice!.id}`),
        "fetch invoice after Sammeldruck",
      )) as { status: string };
      expect(after.status).toBe("entwurf");
    } finally {
      await deactivateEmployee(session, employee.id);
    }
  });
});
