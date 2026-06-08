import { test, expect } from "@playwright/test";
import {
  applyAuthToBrowser,
  apiPatch,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import { createProspect } from "../helpers/test-data";
import { clickSaveAndWait } from "../helpers/round-trip";

// Task #1059: "Wieder aufnehmen" reaktiviert einen "Nicht interessiert"-
// Interessenten zurück nach "Qualifiziert", damit eine Erstberatung geplant
// werden kann. Dieser Round-Trip schützt davor, dass das Control still
// verschwindet (Card nur bei status === "nicht_interessiert") oder der
// Ziel-Status sich ändert. Skips ohne TEST_USER_*-Creds.

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

test.describe("@smoke Prospect-Revive Round-Trip", () => {
  test("'Nicht interessiert' → Wieder aufnehmen → 'Qualifiziert' + Erstberatung planbar + Verlauf", async ({ page }) => {
    const prospect = await createProspect(session);

    // Setup: Interessenten auf "nicht_interessiert" setzen (Ausgangslage).
    const setup = await apiPatch(session, `/api/admin/prospects/${prospect.id}`, {
      status: "nicht_interessiert",
    });
    expect(setup.status, JSON.stringify(setup.data)).toBe(200);

    // Detail-Sheet öffnen: über die Suche auf den frischen Interessenten
    // einschränken, dann die Karte anklicken.
    await page.goto("/admin/prospects", { waitUntil: "domcontentloaded" });
    const search = page.locator("[data-testid='input-search-prospects']");
    await expect(search).toBeVisible({ timeout: 15000 });
    await search.fill(prospect.nachname);

    const card = page.locator(`[data-testid='card-prospect-${prospect.id}']`);
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click();

    // "Wieder aufnehmen" ist nur bei status === "nicht_interessiert" sichtbar.
    const reviveBtn = page.locator("[data-testid='button-status-wieder-aufnehmen']");
    await expect(reviveBtn).toBeVisible({ timeout: 10000 });
    await reviveBtn.click();

    // Bestätigungsdialog → PATCH abwarten.
    await clickSaveAndWait(
      page,
      { url: `/api/admin/prospects/${prospect.id}`, methods: ["PATCH"] },
      "button-confirm-wieder-aufnehmen",
    );

    // Nach der Reaktivierung muss "Erstberatung planen" sichtbar sein
    // (rendert nur für status "qualifiziert"/"erstberatung_vereinbart").
    const planErstberatung = page.locator("[data-testid='button-convert-erstberatung']");
    await expect(planErstberatung).toBeVisible({ timeout: 10000 });

    // Status-Persistenz serverseitig verifizieren (Daten-Layer der Verlauf-UI).
    const afterRes = await session.api.get(`/api/admin/prospects/${prospect.id}`);
    expect(afterRes.ok()).toBeTruthy();
    const after = (await afterRes.json()) as {
      status?: string;
      notes?: Array<{ noteType?: string; noteText?: string }>;
    };
    expect(after.status, `Status nicht 'qualifiziert' für Prospect ${prospect.id}`).toBe(
      "qualifiziert",
    );

    // "statuswechsel"-Eintrag muss im Verlauf protokolliert sein.
    const statusChangeNote = (after.notes ?? []).find(
      (n) => n.noteType === "statuswechsel" && (n.noteText ?? "").includes("qualifiziert"),
    );
    expect(
      statusChangeNote,
      `Kein 'statuswechsel'-Verlaufseintrag für Prospect ${prospect.id} gefunden`,
    ).toBeTruthy();

    // Verlauf-Card wird im UI gerendert (Notiz-Liste vorhanden).
    await expect(page.locator("[data-testid^='note-']").first()).toBeVisible({
      timeout: 10000,
    });
  });
});
