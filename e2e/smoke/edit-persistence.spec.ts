import { test, expect } from "@playwright/test";
import {
  applyAuthToBrowser,
  apiPatch,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import {
  assignEmployee,
  createAppointment,
  createCustomer,
  createEmployee,
  createProspect,
  deactivateEmployee,
} from "../helpers/test-data";
import {
  clickSaveAndWait,
  expectFieldPersisted,
} from "../helpers/round-trip";

// Edit-Persistence Round-Trip Smoke Suite (#428). Skips ohne TEST_USER_*-Creds.

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

test.describe("@smoke Edit-Persistence Round-Trip", () => {
  // ---------- 1. Customer edit — address ----------
  test("Kunde bearbeiten — Adresse persistiert nach Reload", async ({ page }) => {
    const customer = await createCustomer(session);
    const newStreet = `Round_${Date.now().toString().slice(-6)}`;

    await expectFieldPersisted({
      page,
      openUrl: `/admin/customers/${customer.id}`,
      prepareEdit: async (p) => {
        await p.locator("[data-testid='button-edit-kontakt']").click();
      },
      fieldTestId: "input-strasse",
      newValue: newStreet,
      saveTestId: "button-save-kontakt",
      expectSave: { url: `/api/admin/customers/${customer.id}`, methods: ["PATCH"] },
      expectVisibleAfter: "link-address",
    });
  });

  // ---------- 2. Customer edit — Pflegegrad ----------
  test("Kunde bearbeiten — Pflegegrad persistiert nach Reload", async ({ page }) => {
    const customer = await createCustomer(session, { pflegegrad: 2 });

    await page.goto(`/admin/customers/${customer.id}`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid='button-edit-pflegegrad']").click();

    // Admin-Overview verwendet CareLevelSection mit Select-Testid `select-new-pflegegrad`.
    const trigger = page.locator("[data-testid='select-new-pflegegrad']");
    await expect(trigger).toBeVisible({ timeout: 10000 });
    await trigger.click();
    await page
      .locator("[data-testid='select-new-pflegegrad-option-4']")
      .click();

    // DatePicker (Popover) wird mit `todayISO()` vorbelegt — keine Datum-Auswahl nötig.

    await clickSaveAndWait(page, { url: `/api/admin/customers/${customer.id}/care-level`, methods: ["POST"] }, "button-save-pflegegrad");

    await page.reload({ waitUntil: "domcontentloaded" });
    // Persistenz per API verifizieren — Admin-Overview rendert StatusBadge ohne stabile Testid.
    const refetched = await session.api
      .get(`/api/admin/customers/${customer.id}/details`)
      .then((r) => (r.ok() ? r.json() : null));
    expect(refetched?.pflegegrad, `Pflegegrad nicht persistiert für Kunde ${customer.id}`).toBe(4);
  });

  // ---------- 3. Customer edit — Kontaktperson hinzufügen ----------
  test("Kunde bearbeiten — Kontaktperson hinzufügen persistiert nach Reload", async ({ page }) => {
    const customer = await createCustomer(session);
    const vornameUnique = `Notfall${Date.now().toString().slice(-6)}`;

    await page.goto(`/admin/customers/${customer.id}?tab=contacts`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("[data-testid='button-add-contact']").click();
    await page.locator("[data-testid='input-contact-edit-vorname']").fill(vornameUnique);
    await page.locator("[data-testid='input-contact-edit-nachname']").fill("Tester");
    await clickSaveAndWait(page, { url: `/api/admin/customers/${customer.id}/contacts`, methods: ["POST"] }, "button-contact-save");

    // Re-Navigation = vollständiger Reload (URL-Parameter gehen verloren).
    await page.goto(`/admin/customers/${customer.id}?tab=contacts`, {
      waitUntil: "domcontentloaded",
    });
    // Persistenz über Server-API verifizieren — UI-Listen-Layout kann variieren.
    const refetched = await session.api
      .get(`/api/admin/customers/${customer.id}/contacts`)
      .then((r) => (r.ok() ? r.json() : []));
    const found = (refetched as Array<{ vorname?: string }>).some(
      (c) => c.vorname === vornameUnique,
    );
    expect(found, `Kontaktperson "${vornameUnique}" nicht in /contacts persistiert`).toBe(true);
  });

  // ---------- 4. Employee edit — Stammdaten ----------
  test("Mitarbeiter bearbeiten — Stammdaten persistieren nach Reload", async ({ page }) => {
    const emp = await createEmployee(session);
    const newTelefon = `+491701${Date.now().toString().slice(-7)}`;

    const openEditDialog = async () => {
      const card = page.locator(`[data-testid='card-user-${emp.id}']`);
      // Erst sicherstellen, dass die Karte gemountet ist — sonst läuft der
      // anschliessende Action-Click in einen Re-Render-Race.
      await expect(card).toBeVisible({ timeout: 15000 });
      // Click-fähigkeit von Playwright erzwingt Scroll-into-view automatisch
      // und respektiert pointer-events; das ersetzt den vorher best-effort
      // gehaltenen scrollIntoView-Aufruf und maskiert keine Fehler mehr.
      await page.locator(`[data-testid='button-actions-${emp.id}']`).click();
      await page.locator(`[data-testid='button-edit-user-${emp.id}']`).click();
    };

    try {
      await page.goto("/admin/users", { waitUntil: "domcontentloaded" });
      await openEditDialog();

      const telField = page.locator("[data-testid='input-user-telefon']");
      await expect(telField).toBeVisible({ timeout: 10000 });
      await telField.fill(newTelefon);

      await clickSaveAndWait(page, { url: `/api/admin/users/${emp.id}`, methods: ["PATCH"] }, "button-submit-user");

      // Vollständiger Reload (nicht nur Dialog-Close).
      await page.reload({ waitUntil: "domcontentloaded" });
      await openEditDialog();
      const reopened = page.locator("[data-testid='input-user-telefon']");
      await expect(reopened).toBeVisible({ timeout: 10000 });
      // Tel-Input formatiert ggf. um — daher API-Verifikation für klare Persistenz-Aussage.
      const fetched = await session.api.get(`/api/admin/users/${emp.id}`);
      expect(fetched.ok()).toBeTruthy();
      const body = (await fetched.json()) as {
        telefon?: string;
        user?: { telefon?: string };
      };
      expect(body.telefon ?? body.user?.telefon ?? "").toContain(
        newTelefon.replace(/\s/g, "").slice(-7),
      );
    } finally {
      await deactivateEmployee(session, emp.id);
    }
  });

  // ---------- 5. Employee edit — Verfügbarkeit (Wochenstunden) ----------
  test("Mitarbeiter bearbeiten — Verfügbarkeit (Wochenstunden) persistiert", async ({ page }) => {
    const emp = await createEmployee(session);
    const newHours = "37";

    const openEditDialog = async () => {
      const card = page.locator(`[data-testid='card-user-${emp.id}']`);
      await expect(card).toBeVisible({ timeout: 15000 });
      // Kein expliziter scrollIntoView — Playwrights `.click()` führt das
      // deterministisch selbst aus und schluckt keine Fehler.
      await page.locator(`[data-testid='button-actions-${emp.id}']`).click();
      await page.locator(`[data-testid='button-edit-user-${emp.id}']`).click();
    };

    try {
      await page.goto("/admin/users", { waitUntil: "domcontentloaded" });
      await openEditDialog();
      const hoursField = page.locator("[data-testid='input-monthly-work-hours']");
      await expect(hoursField).toBeVisible({ timeout: 10000 });
      await hoursField.fill(newHours);

      await clickSaveAndWait(page, { url: `/api/admin/users/${emp.id}`, methods: ["PATCH"] }, "button-submit-user");

      await page.reload({ waitUntil: "domcontentloaded" });
      await openEditDialog();
      const reopened = page.locator("[data-testid='input-monthly-work-hours']");
      await expect(reopened).toBeVisible({ timeout: 10000 });
      await expect(reopened).toHaveValue(newHours);
    } finally {
      await deactivateEmployee(session, emp.id);
    }
  });

  // ---------- 6. Termin bearbeiten — Zeit + Mitarbeiterwechsel ----------
  test("Termin bearbeiten — Zeit + Mitarbeiter-Wechsel persistieren nach Reload", async ({ page }) => {
    const customer = await createCustomer(session);
    const empA = await createEmployee(session);
    const empB = await createEmployee(session);
    await assignEmployee(session, customer.id, empA.id);
    await assignEmployee(session, customer.id, empB.id);
    const appt = await createAppointment(session, {
      customerId: customer.id,
      employeeId: empA.id,
    });

    const newTime = "14:30";

    try {
      await page.goto(`/edit-appointment/${appt.id}`, { waitUntil: "domcontentloaded" });

      // Zeit ändern.
      const timeField = page.locator("[data-testid='input-time']");
      await expect(timeField).toBeVisible({ timeout: 10000 });
      await timeField.fill(newTime);

      // Mitarbeiter wechseln (SearchableSelect → Option per generierter testid).
      await page.locator("[data-testid='select-kt-employee']").click();
      await page
        .locator(`[data-testid='select-kt-employee-option-${empB.id}']`)
        .click();

      await clickSaveAndWait(page, { url: `/api/appointments/${appt.id}`, methods: ["PATCH"] }, "button-save");

      // Vollständige Re-Navigation.
      await page.goto(`/edit-appointment/${appt.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-testid='input-time']")).toHaveValue(newTime);

      // Persistenz des Mitarbeiter-Wechsels per API absichern (UI-State des
      // SearchableSelect ist nach Re-Mount ohne Anzeige-Wert schwer zu lesen).
      const fetched = await session.api.get(`/api/appointments/${appt.id}`);
      expect(fetched.ok()).toBeTruthy();
      const body = (await fetched.json()) as {
        assignedEmployeeId?: number | null;
        employeeId?: number | null;
      };
      expect(body.assignedEmployeeId ?? body.employeeId).toBe(empB.id);
    } finally {
      await deactivateEmployee(session, empA.id);
      await deactivateEmployee(session, empB.id);
    }
  });

  // ---------- 7. Termin dokumentieren — Wizard Round-Trip ----------
  test("Termin dokumentieren — Leistungen + Notiz persistieren nach Reload", async ({ page }) => {
    const customer = await createCustomer(session);
    const employee = await createEmployee(session);
    await assignEmployee(session, customer.id, employee.id);
    const appt = await createAppointment(session, {
      customerId: customer.id,
      employeeId: employee.id,
    });

    try {
      const docNote = `DocNote_${Date.now().toString().slice(-6)}`;
      const travelNote = `TravelNote_${Date.now().toString().slice(-6)}`;

      await page.goto(`/document-appointment/${appt.id}`, {
        waitUntil: "domcontentloaded",
      });
      // Wizard-Step-1 wird clientseitig hydratisiert — auf NetworkIdle warten,
      // damit der Hauswirtschafts-Service-Block fertig gerendert ist, bevor
      // wir auf das Detail-Feld zugreifen (Task #453: vorher gelegentlich
      // "locator not visible" bei sehr schnellem Hydration-Pfad).
      await page.waitForLoadState("networkidle", { timeout: 10000 });

      // Schritt 1: Service-Detail-Feld füllen.
      const serviceDetail = page.locator(
        "[data-testid='input-details-hauswirtschaft']",
      );
      await expect(serviceDetail).toBeVisible({ timeout: 15000 });
      await serviceDetail.fill(docNote);
      await page.locator("[data-testid='button-next']").click();

      // Schritt 2: Travel-Notiz + Submit, gezielt auf POST /document warten.
      const notesField = page.locator("[data-testid='textarea-notes']");
      await expect(notesField).toBeVisible({ timeout: 10000 });
      await notesField.fill(travelNote);

      await clickSaveAndWait(page, {
          url: `/api/appointments/${appt.id}/document`,
          methods: ["POST"],
        }, "button-submit");

      // Round-Trip-Verifikation: Statt die Termin-Detailseite zu öffnen (die
      // bei nicht signierten Terminen aktuell keine stabilen Sentinels rendert
      // und in einem unrelated Code-Pfad in die Error-Boundary laufen kann),
      // verifizieren wir die Persistenz über frische API-Requests. Das ist
      // semantisch ein vollständiger Reload des Daten-Layers (fresh GET nach
      // POST /document) und prüft das, worum es im Test geht: dass die im UI
      // eingegebenen Service-Details und Travel-Notes serverseitig
      // persistiert wurden.
      const services = (await session.api
        .get(`/api/appointments/${appt.id}/services`)
        .then((r) => (r.ok() ? r.json() : []))) as Array<{ details?: string }>;
      const allDetails = services.map((s) => s.details ?? "").join("\n");
      expect(allDetails).toContain(docNote);

      const apptAfter = await session.api
        .get(`/api/appointments/${appt.id}`)
        .then((r) => r.json()) as { notes?: string | null };
      expect(apptAfter.notes ?? "").toContain(travelNote);
    } finally {
      await deactivateEmployee(session, employee.id);
    }
  });

  // ---------- 7b. Termin dokumentieren — Anfahrt-km + Kunden-km im selben Schritt ----------
  // Task #467: schützt davor, dass die beiden Kilometer-Felder versehentlich
  // wieder in unterschiedliche Schritte rutschen oder der Ja/Nein-Toggle bricht.
  test("Termin dokumentieren — Anfahrt-km + Kunden-km landen im selben Schritt (Ja)", async ({ page }) => {
    const customer = await createCustomer(session);
    const employee = await createEmployee(session);
    await assignEmployee(session, customer.id, employee.id);
    const appt = await createAppointment(session, {
      customerId: customer.id,
      employeeId: employee.id,
    });

    try {
      await page.goto(`/document-appointment/${appt.id}`, {
        waitUntil: "domcontentloaded",
      });

      // Schritt 1: Pflicht-Servicedetail füllen, damit "Weiter" nicht blockt.
      const serviceDetail = page.locator(
        "[data-testid='input-details-hauswirtschaft']",
      );
      await expect(serviceDetail).toBeVisible({ timeout: 10000 });
      await serviceDetail.fill("Kilometer-Smoketest");
      await page.locator("[data-testid='button-next']").click();

      // Schritt 2: BEIDE Kilometer-Eingaben müssen hier sichtbar sein.
      const travelKm = page.locator("[data-testid='input-kilometers']");
      await expect(travelKm).toBeVisible({ timeout: 10000 });
      await travelKm.fill("12");

      // Toggle aktivieren — Kunden-km-Input erscheint erst danach, aber
      // weiterhin im SELBEN Schritt 2.
      await page.locator("[data-testid='radio-customer-travel-yes']").click();
      const customerKm = page.locator("[data-testid='input-customer-kilometers']");
      await expect(customerKm).toBeVisible({ timeout: 10000 });
      await customerKm.fill("7");

      await clickSaveAndWait(
        page,
        { url: `/api/appointments/${appt.id}/document`, methods: ["POST"] },
        "button-submit",
      );

      // Vollständiger Reload (gemäß Task-Vorgabe), dann API-Verifikation
      // — dokumentierte Termine rendern keinen Wizard mehr, daher prüfen
      // wir die Persistenz beider km-Werte über die Appointment-API.
      await page.reload({ waitUntil: "domcontentloaded" });

      const apptAfter = (await session.api
        .get(`/api/appointments/${appt.id}`)
        .then((r) => r.json())) as {
        travelKilometers?: number | null;
        customerKilometers?: number | null;
      };
      expect(apptAfter.travelKilometers ?? 0).toBeCloseTo(12, 3);
      expect(apptAfter.customerKilometers ?? 0).toBeCloseTo(7, 3);
    } finally {
      await deactivateEmployee(session, employee.id);
    }
  });

  test("Termin dokumentieren — Kunden-km bleibt 0 bei Toggle 'Nein'", async ({ page }) => {
    const customer = await createCustomer(session);
    const employee = await createEmployee(session);
    await assignEmployee(session, customer.id, employee.id);
    const appt = await createAppointment(session, {
      customerId: customer.id,
      employeeId: employee.id,
    });

    try {
      await page.goto(`/document-appointment/${appt.id}`, {
        waitUntil: "domcontentloaded",
      });

      const serviceDetail = page.locator(
        "[data-testid='input-details-hauswirtschaft']",
      );
      await expect(serviceDetail).toBeVisible({ timeout: 10000 });
      await serviceDetail.fill("Kilometer-Smoketest-Nein");
      await page.locator("[data-testid='button-next']").click();

      const travelKm = page.locator("[data-testid='input-kilometers']");
      await expect(travelKm).toBeVisible({ timeout: 10000 });
      await travelKm.fill("5");

      // Toggle bleibt auf "Nein" — Kunden-km-Input darf nicht sichtbar sein
      // (entweder nicht im DOM oder ausgeblendet — beides ist akzeptabel).
      const customerKm = page.locator("[data-testid='input-customer-kilometers']");
      await expect(customerKm).not.toBeVisible();

      await clickSaveAndWait(
        page,
        { url: `/api/appointments/${appt.id}/document`, methods: ["POST"] },
        "button-submit",
      );

      // Vollständiger Reload (gemäß Task-Vorgabe) vor API-Verifikation.
      await page.reload({ waitUntil: "domcontentloaded" });

      const apptAfter = (await session.api
        .get(`/api/appointments/${appt.id}`)
        .then((r) => r.json())) as {
        travelKilometers?: number | null;
        customerKilometers?: number | null;
      };
      expect(apptAfter.travelKilometers ?? 0).toBeCloseTo(5, 3);
      // Kunden-km muss 0 oder null sein.
      expect(apptAfter.customerKilometers ?? 0).toBe(0);
    } finally {
      await deactivateEmployee(session, employee.id);
    }
  });

  // ---------- 8. Lead bearbeiten — Status + Notiz ----------
  test("Lead bearbeiten — Status + Notiz persistieren nach Reload", async ({ page }) => {
    const prospect = await createProspect(session);
    const noteText = `LeadNote_${Date.now().toString().slice(-6)}`;

    // Status deterministisch auf "neu" zurücksetzen, damit der "kontaktiert"-
    // Button sichtbar ist (Sheet rendert ihn nur für Status="neu").
    await apiPatch(session, `/api/admin/prospects/${prospect.id}`, {
      status: "neu",
    });

    await page.goto("/admin/prospects", { waitUntil: "domcontentloaded" });
    await page.locator(`[data-testid='card-prospect-${prospect.id}']`).click();

    await clickSaveAndWait(
      page,
      { url: `/api/admin/prospects/${prospect.id}`, methods: ["PATCH"] },
      "button-status-kontaktiert",
    );

    // Notiz hinzufügen.
    await page.locator("[data-testid='input-note-text']").fill(noteText);
    await clickSaveAndWait(page, { url: `/api/admin/prospects/${prospect.id}/notes`, methods: ["POST"] }, "button-add-note");

    // Vollständiger Reload + Sheet erneut öffnen.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`[data-testid='card-prospect-${prospect.id}']`).click();
    // Notes werden mit data-testid="note-${id}" gerendert. Mind. eine davon
    // muss den neuen Text enthalten.
    const allNotes = page.locator("[data-testid^='note-']");
    await expect(allNotes.first()).toBeVisible({ timeout: 10000 });
    await expect(allNotes.filter({ hasText: noteText })).toHaveCount(1);

    // Status-Persistenz zusätzlich per API.
    const fetchedProspect = (await session.api
      .get(`/api/admin/prospects/${prospect.id}`)
      .then((r) => r.json())) as { status?: string };
    expect(fetchedProspect.status).toBe("kontaktiert");
  });

  // ---------- 9. Budget-Einstellungen Kunde — Cap UND zweiter Pott ----------
  test("Budget-Einstellungen — Cap + zweiter Pott persistieren nach Reload", async ({ page }) => {
    // Pflegegrad 3 ist Voraussetzung für §45a Umwandlungsanspruch.
    const customer = await createCustomer(session, { pflegegrad: 3 });

    await page.goto(`/admin/customers/${customer.id}?tab=budgets`, {
      waitUntil: "domcontentloaded",
    });

    // Inputs sind nur sichtbar, wenn der jeweilige Pott via Switch aktiviert ist.
    const enable = async (potKey: string) => {
      const sw = page.locator(`[data-testid='switch-enabled-${potKey}']`);
      await expect(sw).toBeVisible({ timeout: 15000 });
      const state = await sw.getAttribute("data-state");
      if (state !== "checked") await sw.click();
    };
    await enable("umwandlung_45a");
    await enable("ersatzpflege_39_42a");

    // (a) §45a Cap (Monatslimit).
    const cap45a = page.locator(
      "[data-testid='input-monthly-limit-umwandlung_45a']",
    );
    await expect(cap45a).toBeVisible({ timeout: 15000 });
    const newCap = "42";
    await cap45a.fill(newCap);

    // (b) §39/§42a (zweiter Pott) — Jahresbetrag.
    const pot39 = page.locator(
      "[data-testid='input-yearly-limit-ersatzpflege_39_42a']",
    );
    await expect(pot39).toBeVisible({ timeout: 5000 });
    const newPot = "1500";
    await pot39.fill(newPot);

    await clickSaveAndWait(page, { url: `/api/budget/${customer.id}/type-settings`, methods: ["PUT"] }, "btn-save-budget-type-settings");

    await page.goto(`/admin/customers/${customer.id}?tab=budgets`, {
      waitUntil: "domcontentloaded",
    });
    // Input formatiert die Zahl im DE-Locale ("42" → "42,00").
    const cap45aAfter = page.locator(
      "[data-testid='input-monthly-limit-umwandlung_45a']",
    );
    await expect(cap45aAfter).toBeVisible({ timeout: 15000 });
    await expect(cap45aAfter).toHaveValue(/^42(?:[,.]00?)?$/);

    const pot39After = page.locator(
      "[data-testid='input-yearly-limit-ersatzpflege_39_42a']",
    );
    await expect(pot39After).toBeVisible();
    await expect(pot39After).toHaveValue(/^1[\.\s]?500(?:[,.]00?)?$/);
  });

  // ---------- 10. Firmenstammdaten ----------
  test("Firmenstammdaten — Telefon persistiert nach Reload", async ({ page }) => {
    // Wir greifen Telefon (nicht companyName), weil das eindeutiger und
    // gefahrloser für nachfolgende Tests ist.
    const original = (await session.api
      .get("/api/company-settings")
      .then((r) => (r.ok() ? r.json() : null))) as { telefon?: string | null } | null;
    const previous: string | null = original?.telefon ?? null;
    const newPhone = `+49301${Date.now().toString().slice(-7)}`;

    try {
      await expectFieldPersisted({
        page,
        openUrl: "/admin/settings",
        fieldTestId: "input-company-telefon",
        newValue: newPhone,
        saveTestId: "button-save-company",
        expectSave: { url: "/api/company-settings", methods: ["PATCH"] },
      });

      // Tel-Input formatiert ggf. um — Endziffern müssen jedenfalls erhalten bleiben.
      const reloaded = page.locator("[data-testid='input-company-telefon']");
      const value = (await reloaded.inputValue()).replace(/\s|\(|\)|-/g, "");
      expect(value).toContain(newPhone.replace(/\s/g, "").slice(-7));
    } finally {
      // Originalwert wiederherstellen, damit dieser Test idempotent ist.
      if (previous != null) {
        await apiPatch(session, "/api/company-settings", { telefon: previous }).catch(
          () => {
            /* best-effort */
          },
        );
      }
    }
  });
});
