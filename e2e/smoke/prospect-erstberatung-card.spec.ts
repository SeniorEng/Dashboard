import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  applyAuthToBrowser,
  apiPost,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import { createProspect, createEmployee, deactivateEmployee } from "../helpers/test-data";

// Task #1093: Browser-Round-Trip zu Task #1089. Der Backend-Test
// (`tests/prospect-list-erstberatung.test.ts`) sichert ab, dass die Admin-
// Interessenten-API den `erstberatung`-Block (Datum, Startzeit, Status,
// verantwortlicher Mitarbeiter) liefert. Dieser Smoke-Test beweist, dass diese
// Daten auch tatsächlich auf der Interessenten-Karte gerendert werden — nicht
// nur, dass die API sie zurückgibt. Skips ohne TEST_USER_*-Creds.
//
// Task #1095: Zusätzlich der Substitutions-Fall (Backend: PL-4). Eine geplante
// Erstberatung wird einem Mitarbeiter zugewiesen, dann aber von einem ANDEREN
// Mitarbeiter durchgeführt/dokumentiert. Die Karte muss danach den DURCH-
// FÜHRENDEN Mitarbeiter plus Status "Abgeschlossen" rendern (Attribution
// completed → performedBy), nicht den ursprünglich zugewiesenen.

const creds = getAdminCreds();
test.skip(!creds, "TEST_USER_EMAIL/TEST_USER_PASSWORD nicht gesetzt — Smoke-Suite übersprungen.");

let session: ApiSession;
let currentUserId: number;
let currentUserName: string;

const ERSTBERATUNG_TIMES = ["07:00", "16:00", "17:00", "06:30", "18:00"];

async function getCurrentUser(
  api: APIRequestContext,
): Promise<{ id: number; displayName: string }> {
  const res = await api.get("/api/auth/me");
  if (!res.ok()) throw new Error(`GET /api/auth/me failed: ${res.status()}`);
  const body = (await res.json()) as {
    user: { id: number; displayName?: string; vorname?: string; nachname?: string };
  };
  const u = body.user;
  const displayName =
    u.displayName ?? `${u.vorname ?? ""} ${u.nachname ?? ""}`.trim();
  return { id: u.id, displayName };
}

/** HH:MM → HH:MM (UI rendert formatTimeHHMM, also ohne Sekunden). */
function toHHMM(time: string): string {
  return time.length >= 5 ? time.slice(0, 5) : time;
}

/**
 * Legt für einen Interessenten einen geplanten Erstberatungstermin auf dem
 * ersten freien Slot im Offset-Fenster an (Wochenenden überspringt der Server).
 * Liefert Datum (DD.MM, wie es die Karte rendert) + Startzeit (HH:MM) zurück.
 */
async function scheduleErstberatung(opts: {
  prospectId: number;
  assignedEmployeeId: number;
  /** Vergangener Slot (für Dokumentation/Abschluss), Default: zukünftig. */
  past?: boolean;
}): Promise<{
  id: number;
  displayDate: string;
  displayTime: string;
  scheduledStart: string;
}> {
  for (let offset = 18; offset <= 45; offset++) {
    const candidate = new Date();
    candidate.setDate(candidate.getDate() + (opts.past ? -offset : offset));
    const dow = candidate.getDay();
    if (dow === 0) candidate.setDate(candidate.getDate() + (opts.past ? -2 : 1));
    else if (dow === 6) candidate.setDate(candidate.getDate() + (opts.past ? -1 : 2));
    const dateStr = candidate.toISOString().split("T")[0];
    for (const time of ERSTBERATUNG_TIMES) {
      const { status, data } = await apiPost<any>(
        session,
        "/api/appointments/prospect-erstberatung",
        {
          prospectId: opts.prospectId,
          date: dateStr,
          scheduledStart: time,
          erstberatungDauer: 60,
          assignedEmployeeId: opts.assignedEmployeeId,
        },
      );
      if (status === 201) {
        const appt = data.appointment || data;
        const [y, m, d] = dateStr.split("-");
        return {
          id: appt.id,
          displayDate: `${d}.${m}`,
          displayTime: toHHMM(time),
          scheduledStart: toHHMM(time),
        };
      }
    }
  }
  throw new Error("Kein freier Erstberatungs-Slot im Offset-Fenster gefunden");
}

/** Löst den Anzeigenamen eines Users über die Admin-API auf. */
async function resolveDisplayName(userId: number): Promise<string> {
  const res = await session.api.get(`/api/admin/users/${userId}`);
  if (!res.ok()) {
    throw new Error(`GET /api/admin/users/${userId} failed: ${res.status()}`);
  }
  const body = (await res.json()) as { displayName?: string };
  if (!body.displayName) {
    throw new Error(`/api/admin/users/${userId} ohne displayName`);
  }
  return body.displayName;
}

/**
 * Dokumentiert eine Erstberatung als von `performedByEmployeeId` durchgeführt
 * (Substitutions-Fall) und setzt den Termin damit auf Status "completed".
 */
async function documentErstberatungAs(opts: {
  appointmentId: number;
  performedByEmployeeId: number;
  actualStart: string;
}): Promise<void> {
  const servicesRes = await session.api.get(
    `/api/appointments/${opts.appointmentId}/services`,
  );
  if (!servicesRes.ok()) {
    throw new Error(
      `GET services failed: ${servicesRes.status()}`,
    );
  }
  const services = (await servicesRes.json()) as Array<{ serviceId: number }>;
  if (services.length === 0) {
    throw new Error("Erstberatung muss einen Service haben");
  }
  const { status, data } = await apiPost<any>(
    session,
    `/api/appointments/${opts.appointmentId}/document`,
    {
      performedByEmployeeId: opts.performedByEmployeeId,
      actualStart: opts.actualStart,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [
        {
          serviceId: services[0].serviceId,
          actualDurationMinutes: 60,
          details: "Erstberatung durchgeführt",
        },
      ],
    },
  );
  if (status !== 200) {
    throw new Error(`Dokumentation failed: ${status} ${JSON.stringify(data)}`);
  }
}

test.beforeAll(async () => {
  session = await loginApiSession(creds!);
  const me = await getCurrentUser(session.api);
  currentUserId = me.id;
  currentUserName = me.displayName;
});

test.afterAll(async () => {
  if (session) await session.api.dispose();
});

test.beforeEach(async ({ context }) => {
  await applyAuthToBrowser(context, session);
});

test.describe("@smoke Interessenten-Karte zeigt Erstberatungs-Details", () => {
  test("Geplante Erstberatung: Karte rendert Datum, Uhrzeit, Status und Mitarbeiter", async ({ page }) => {
    const prospect = await createProspect(session);
    const eb = await scheduleErstberatung({
      prospectId: prospect.id,
      assignedEmployeeId: currentUserId,
    });

    await page.goto("/admin/prospects", { waitUntil: "domcontentloaded" });
    const search = page.locator("[data-testid='input-search-prospects']");
    await expect(search).toBeVisible({ timeout: 15000 });
    await search.fill(prospect.nachname);

    const card = page.locator(`[data-testid='card-prospect-${prospect.id}']`);
    await expect(card).toBeVisible({ timeout: 15000 });

    // Der Erstberatungs-Block muss auf der Karte sichtbar sein.
    const ebBlock = page.locator(
      `[data-testid='text-prospect-erstberatung-${prospect.id}']`,
    );
    await expect(ebBlock).toBeVisible({ timeout: 10000 });

    // Datum + Uhrzeit (so wie der Server/UI sie formatiert).
    await expect(ebBlock).toContainText(eb.displayDate);
    await expect(ebBlock).toContainText(eb.displayTime);

    // Status: geplante Erstberatung ⇒ "Geplant".
    const statusEl = page.locator(
      `[data-testid='text-prospect-erstberatung-status-${prospect.id}']`,
    );
    await expect(statusEl).toBeVisible();
    await expect(statusEl).toHaveText("Geplant");

    // Verantwortlicher Mitarbeiter (zugewiesen ⇒ aktueller Admin/Erstberater).
    const employeeEl = page.locator(
      `[data-testid='text-prospect-erstberatung-employee-${prospect.id}']`,
    );
    await expect(employeeEl).toBeVisible();
    await expect(employeeEl).toContainText(currentUserName);
  });

  test("Abgeschlossene Erstberatung durch Vertretung: Karte zeigt durchführenden Mitarbeiter + 'Abgeschlossen'", async ({ page }) => {
    // Vertretungs-Mitarbeiter anlegen (≠ zugewiesener Admin).
    const performer = await createEmployee(session);
    let performerName: string;
    try {
      performerName = await resolveDisplayName(performer.id);
      expect(
        performerName,
        "Durchführender darf nicht der zugewiesene Admin sein",
      ).not.toBe(currentUserName);

      const prospect = await createProspect(session);
      // Vergangener Slot, zugewiesen an den aktuellen Admin …
      const eb = await scheduleErstberatung({
        prospectId: prospect.id,
        assignedEmployeeId: currentUserId,
        past: true,
      });
      // … aber von der Vertretung durchgeführt/dokumentiert ⇒ completed.
      await documentErstberatungAs({
        appointmentId: eb.id,
        performedByEmployeeId: performer.id,
        actualStart: eb.scheduledStart,
      });

      await page.goto("/admin/prospects", { waitUntil: "domcontentloaded" });
      const search = page.locator("[data-testid='input-search-prospects']");
      await expect(search).toBeVisible({ timeout: 15000 });
      await search.fill(prospect.nachname);

      const card = page.locator(`[data-testid='card-prospect-${prospect.id}']`);
      await expect(card).toBeVisible({ timeout: 15000 });

      const ebBlock = page.locator(
        `[data-testid='text-prospect-erstberatung-${prospect.id}']`,
      );
      await expect(ebBlock).toBeVisible({ timeout: 10000 });

      // Status: durchgeführt ⇒ "Abgeschlossen".
      const statusEl = page.locator(
        `[data-testid='text-prospect-erstberatung-status-${prospect.id}']`,
      );
      await expect(statusEl).toBeVisible();
      await expect(statusEl).toHaveText("Abgeschlossen");

      // Mitarbeiter: der DURCHFÜHRENDE (Vertretung), nicht der zugewiesene Admin.
      const employeeEl = page.locator(
        `[data-testid='text-prospect-erstberatung-employee-${prospect.id}']`,
      );
      await expect(employeeEl).toBeVisible();
      await expect(employeeEl).toContainText(performerName);
      await expect(employeeEl).not.toContainText(currentUserName);
    } finally {
      await deactivateEmployee(session, performer.id);
    }
  });

  test("Ohne Termin: Karte zeigt keinen Erstberatungs-Block", async ({ page }) => {
    const prospect = await createProspect(session);

    await page.goto("/admin/prospects", { waitUntil: "domcontentloaded" });
    const search = page.locator("[data-testid='input-search-prospects']");
    await expect(search).toBeVisible({ timeout: 15000 });
    await search.fill(prospect.nachname);

    const card = page.locator(`[data-testid='card-prospect-${prospect.id}']`);
    await expect(card).toBeVisible({ timeout: 15000 });

    // Kein verknüpfter Termin ⇒ Erstberatungs-Block darf gar nicht existieren.
    await expect(
      page.locator(`[data-testid='text-prospect-erstberatung-${prospect.id}']`),
    ).toHaveCount(0);
  });
});
