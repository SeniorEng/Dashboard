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

// Task #1060: "Disqualifizieren" verschiebt einen "kontaktiert"-Interessenten
// über die dedizierte /qualify-Route nach "disqualifiziert" und protokolliert
// automatisch eine "statuswechsel"-Notiz mit dem gewählten Grund. Dieser
// Round-Trip schützt davor, dass das Control still verschwindet (nur sichtbar
// bei status === "kontaktiert"), der Ziel-Status sich ändert oder der
// Verlaufseintrag nicht mehr geschrieben wird. Skips ohne TEST_USER_*-Creds.

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

test.describe("@smoke Prospect-Disqualify Round-Trip", () => {
  test("'Kontaktiert' → Disqualifizieren (mit Grund) → 'Disqualifiziert' + Verlauf", async ({ page }) => {
    const prospect = await createProspect(session);

    // Setup: Interessenten auf "kontaktiert" setzen — nur dann rendert das
    // Qualifizierungs-Panel mit dem "Disqualifizieren"-Button.
    const setup = await apiPatch(session, `/api/admin/prospects/${prospect.id}`, {
      status: "kontaktiert",
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

    // "Disqualifizieren" ist nur im Qualifizierungs-Panel (status
    // "kontaktiert") sichtbar.
    const disqualifyBtn = page.locator("[data-testid='button-disqualify']");
    await expect(disqualifyBtn).toBeVisible({ timeout: 10000 });
    await disqualifyBtn.click();

    // Grund im Dialog wählen (Radix-Select). Der Grund-Key fließt in die
    // protokollierte "statuswechsel"-Notiz ein.
    const reasonTrigger = page.locator("[data-testid='select-disqualify-reason']");
    await expect(reasonTrigger).toBeVisible({ timeout: 10000 });
    await reasonTrigger.click();
    await page.getByRole("option", { name: "Keine Kapazität" }).click();

    // Bestätigungsdialog → PATCH auf die /qualify-Route abwarten.
    await clickSaveAndWait(
      page,
      { url: `/api/admin/prospects/${prospect.id}/qualify`, methods: ["PATCH"] },
      "button-confirm-disqualify",
    );

    // Status-Persistenz serverseitig verifizieren (Daten-Layer der Verlauf-UI).
    const afterRes = await session.api.get(`/api/admin/prospects/${prospect.id}`);
    expect(afterRes.ok()).toBeTruthy();
    const after = (await afterRes.json()) as {
      status?: string;
      notes?: Array<{ noteType?: string; noteText?: string }>;
    };
    expect(after.status, `Status nicht 'disqualifiziert' für Prospect ${prospect.id}`).toBe(
      "disqualifiziert",
    );

    // "statuswechsel"-Eintrag mit dem gewählten Grund muss im Verlauf stehen.
    const statusChangeNote = (after.notes ?? []).find(
      (n) => n.noteType === "statuswechsel" && (n.noteText ?? "").includes("keine_kapazitaet"),
    );
    expect(
      statusChangeNote,
      `Kein 'statuswechsel'-Verlaufseintrag mit Grund für Prospect ${prospect.id} gefunden`,
    ).toBeTruthy();

    // Verlauf-Card wird im UI gerendert (Notiz-Liste vorhanden).
    await expect(page.locator("[data-testid^='note-']").first()).toBeVisible({
      timeout: 10000,
    });
  });
});
