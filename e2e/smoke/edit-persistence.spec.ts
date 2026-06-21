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
  createSingleServiceRecord,
  deactivateEmployee,
  getServiceIdByCode,
  validSignatureDataUrl,
} from "../helpers/test-data";
import {
  clickSaveAndWait,
  expectFieldPersisted,
} from "../helpers/round-trip";
import { apiPost, apiPut } from "../helpers/auth";
import { max45bStartValueCents } from "../../shared/domain/budget/carryover-eligibility";

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
      // /admin/users rendert alle User ohne Virtualisierung. In der Test-DB
      // existieren ggf. zehntausende Stale-Test-User (Cleanup wird oft durch
      // referentielle Verflechtung abgelehnt), wodurch das vollständige Rendern
      // > 15 s dauert. Über die Suche auf den frischen Mitarbeiter
      // einschränken — so muss nur 1 Karte gerendert werden.
      const search = page.locator("[data-testid='input-search-users']");
      await expect(search).toBeVisible({ timeout: 15000 });
      await search.fill(emp.email);
      const card = page.locator(`[data-testid='card-user-${emp.id}']`);
      await expect(card).toBeVisible({ timeout: 15000 });
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
      // Siehe Test #4: /admin/users ohne Virtualisierung + zehntausende
      // Stale-Test-User → vor Klick per Suche auf den frischen Mitarbeiter
      // einschränken.
      const search = page.locator("[data-testid='input-search-users']");
      await expect(search).toBeVisible({ timeout: 15000 });
      await search.fill(emp.email);
      const card = page.locator(`[data-testid='card-user-${emp.id}']`);
      await expect(card).toBeVisible({ timeout: 15000 });
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

      // Zeit ändern (TimePicker: Button-Trigger öffnet Popover mit Uhr-Dial;
      // Stunden-/Minuten-Zahlen tragen weiterhin testids btn-hour-*/btn-minute-*,
      // Bestätigung über "Übernehmen"; kein freitextiges Input-Feld).
      const [newHour, newMinute] = newTime.split(":");
      const timeField = page.locator("[data-testid='input-time']");
      await expect(timeField).toBeVisible({ timeout: 10000 });
      await timeField.click();
      await page.locator(`[data-testid='btn-hour-${newHour}']`).click();
      await page.locator(`[data-testid='btn-minute-${newMinute}']`).click();
      await page.locator("[data-testid='btn-confirm-time']").click();

      // Mitarbeiter wechseln (SearchableSelect → Option per generierter testid).
      await page.locator("[data-testid='select-kt-employee']").click();
      await page
        .locator(`[data-testid='select-kt-employee-option-${empB.id}']`)
        .click();

      await clickSaveAndWait(page, { url: `/api/appointments/${appt.id}`, methods: ["PATCH"] }, "button-save");

      // Vollständige Re-Navigation.
      await page.goto(`/edit-appointment/${appt.id}`, { waitUntil: "domcontentloaded" });
      // TimePicker zeigt den Wert als Button-Text "HH:MM Uhr" an (kein .value).
      await expect(page.locator("[data-testid='input-time']")).toContainText(newTime);

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

  // ---------- 7c. Termin km bearbeiten — Drift-frei in Ledger + Rechnung (#620) ----------
  test("Termin km 7,3 → 12,7 — Termin-Detail, Budget-Ledger und Rechnung zeigen identisch '12,70 km'", async ({ page }) => {
    // Komplexer Multi-Round-Trip (UI-Doku → Reopen → PATCH+Rebook →
    // Re-Document → Rechnung) — der Default-Timeout (30s) ist zu knapp,
    // sobald Puppeteer-PDF-Render und mehrere Reloads zusammenkommen.
    test.setTimeout(90_000);
    const customer = await createCustomer(session);
    const employee = await createEmployee(session);
    await assignEmployee(session, customer.id, employee.id);

    // §45b mit Initial-Balance ausstatten, damit die Anfahrt im Kasse-Topf
    // (nicht in der privaten Fallback-Buchung) landet — sonst rendert die
    // §45b-Ledger-Sektion keinen Eintrag.
    const today = new Date();
    const initialFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    {
      const { status, data } = await apiPut(
        session,
        `/api/budget/${customer.id}/type-settings`,
        {
          settings: [
            {
              budgetType: "entlastungsbetrag_45b",
              enabled: true,
              priority: 1,
              monthlyLimitCents: 13100,
            },
          ],
        },
      );
      if (status >= 300) {
        throw new Error(`type-settings failed: ${status} ${JSON.stringify(data)}`);
      }
    }
    {
      const { status, data } = await apiPost(
        session,
        `/api/budget/${customer.id}/initial-balance/entlastungsbetrag_45b`,
        { amountCents: max45bStartValueCents("2024-01-01", `${initialFrom}-01`), validFrom: initialFrom },
      );
      if (status >= 300) {
        throw new Error(`initial-balance failed: ${status} ${JSON.stringify(data)}`);
      }
    }

    const appt = await createAppointment(session, {
      customerId: customer.id,
      employeeId: employee.id,
    });

    try {
      // --- Schritt 1: Termin mit 7,3 km dokumentieren (UI-Round-Trip) ---
      await page.goto(`/document-appointment/${appt.id}`, {
        waitUntil: "domcontentloaded",
      });

      const serviceDetail = page.locator(
        "[data-testid='input-details-hauswirtschaft']",
      );
      await expect(serviceDetail).toBeVisible({ timeout: 10000 });
      await serviceDetail.fill("km-Drift-Smoketest");
      await page.locator("[data-testid='button-next']").click();

      const travelKm = page.locator("[data-testid='input-kilometers']");
      await expect(travelKm).toBeVisible({ timeout: 10000 });
      // type="number" akzeptiert universell den Punkt; parseGermanDecimal
      // im onChange normalisiert ihn intern wieder.
      await travelKm.fill("7.3");

      await clickSaveAndWait(
        page,
        { url: `/api/appointments/${appt.id}/document`, methods: ["POST"] },
        "button-submit",
      );

      // --- Reload + Persistenz-Check (7,3 km) ---
      await page.reload({ waitUntil: "domcontentloaded" });
      const apptAfterDoc = (await session.api
        .get(`/api/appointments/${appt.id}`)
        .then((r) => r.json())) as { travelKilometers?: number | null };
      expect(apptAfterDoc.travelKilometers ?? 0).toBeCloseTo(7.3, 3);

      // --- Schritt 2: km auf 12,7 ändern (UI: Reopen → Re-Document) ---
      // Echter Browser-Round-Trip über die User-sichtbaren Controls:
      // Termin-Detail-Seite → "Dokumentation korrigieren" → Dialog
      // bestätigen → Redirect auf /document-appointment/:id → km-Feld
      // mit 12,7 überschreiben → "Speichern". Das ist der einzige Pfad,
      // den echte Anwender für eine km-Korrektur nehmen können.
      await page.goto(`/appointment/${appt.id}`, { waitUntil: "domcontentloaded" });
      const reopenBtn = page.locator("[data-testid='button-reopen']");
      await expect(reopenBtn).toBeVisible({ timeout: 10000 });
      await reopenBtn.click();

      // AlertDialog: „Zur Korrektur öffnen" bestätigen. Die reopen-Mutation
      // navigiert anschliessend auf /document-appointment/:id.
      const confirmReopen = page.getByRole("button", {
        name: "Zur Korrektur öffnen",
      });
      await expect(confirmReopen).toBeVisible({ timeout: 5000 });
      await Promise.all([
        page.waitForURL(`**/document-appointment/${appt.id}`, { timeout: 15000 }),
        confirmReopen.click(),
      ]);

      // Schritt 1 des Wizards: Service-Detail ist vom Vor-Lauf
      // vorbefüllt, also direkt weiter.
      const serviceDetailAgain = page.locator(
        "[data-testid='input-details-hauswirtschaft']",
      );
      await expect(serviceDetailAgain).toBeVisible({ timeout: 10000 });
      await page.locator("[data-testid='button-next']").click();

      // Schritt 2: km-Feld mit 12,7 überschreiben. Beim Reopen ist 7,3
      // vorbelegt — `fill` ersetzt den Inhalt komplett.
      const travelKmEdit = page.locator("[data-testid='input-kilometers']");
      await expect(travelKmEdit).toBeVisible({ timeout: 10000 });
      await travelKmEdit.fill("12.7");

      // Speichern: dieser POST triggert serverseitig die §45b-Storno-und-
      // Neuabbuchung mit 12,7 km — exakt der Pfad, der die Anzeige↔
      // Buchung-Drift verhindern soll, die dieser Smoke-Test absichert.
      await clickSaveAndWait(
        page,
        { url: `/api/appointments/${appt.id}/document`, methods: ["POST"] },
        "button-submit",
      );

      // --- Reload + Persistenz-Check (12,7 km) im Termin-Detail ---
      //
      // Root-Cause-Note (Task #764): Direkt nach dem POST /document via
      // `clickSaveAndWait` ist die Transaktion zwar im selben Request
      // committed, aber wir haben hier mehrere parallele Test-Worker, die
      // einen kalten Connection-Pool und einen 2. Browser-Fetch (page.goto)
      // teilen. Vor #764 las der direkte `session.api.get` gelegentlich
      // travelKilometers=0 — vermutlich Connection-Pool-Reordering unter
      // Cold-Start-Last. Statt One-Shot-GET pollen wir bis zum erwarteten
      // Wert (max 5s) — das ist ein deterministischer Read-after-Write,
      // wie ihn auch echte UI-Komponenten via TanStack-Query-Refetch
      // realisieren.
      await page.goto(`/appointment/${appt.id}`, { waitUntil: "domcontentloaded" });
      let apptAfterEdit: { travelKilometers?: number | null } = {};
      for (let i = 0; i < 10; i++) {
        apptAfterEdit = (await session.api
          .get(`/api/appointments/${appt.id}`)
          .then((r) => r.json())) as { travelKilometers?: number | null };
        const km = Number(apptAfterEdit.travelKilometers ?? 0);
        if (Math.abs(km - 12.7) < 0.01) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      expect(apptAfterEdit.travelKilometers ?? 0).toBeCloseTo(12.7, 3);

      // --- Verifikation 1: Termin-Detail-Seite zeigt "12,70 km" ---
      // appointment-travel-card.tsx rendert formatKm(12.7) → "12,70" + " km".
      await expect(page.getByText("12,70 km").first()).toBeVisible({ timeout: 10000 });

      // --- Verifikation 2: Budget-Ledger zeigt aktive Consumption mit 12,7 km ---
      type BudgetTx = {
        id: number;
        transactionType: string;
        budgetType: string;
        travelKilometers?: string | number | null;
        travelCents?: number | null;
        reversedTransactionId?: number | null;
      };
      const txs = (await session.api
        .get(`/api/budget/${customer.id}/transactions?budgetType=entlastungsbetrag_45b`)
        .then((r) => r.json())) as BudgetTx[];
      // Aktive (nicht stornierte, nicht reversal) Consumption-Buchung finden.
      // Reversal-Zeilen tragen `reversedTransactionId` mit der ID der
      // stornierten Original-Buchung — daraus bauen wir das Set aller
      // bereits stornierten Original-IDs.
      const reversedIds = new Set(
        txs
          .filter((t) => t.reversedTransactionId != null)
          .map((t) => t.reversedTransactionId as number),
      );
      const activeConsumption = txs.find(
        (t) =>
          t.transactionType === "consumption" &&
          !reversedIds.has(t.id),
      );
      expect(activeConsumption, "Aktive §45b-Consumption-Buchung muss existieren").toBeTruthy();
      const ledgerKm = Number(activeConsumption!.travelKilometers ?? 0);
      expect(ledgerKm).toBeCloseTo(12.7, 3);
      const ledgerTravelCents = activeConsumption!.travelCents ?? 0;
      expect(ledgerTravelCents).toBeGreaterThan(0);

      // UI-Ledger im Budget-Tab muss „Anfahrt: 12,70 km" rendern.
      await page.goto(`/admin/customers/${customer.id}?tab=budgets`, {
        waitUntil: "domcontentloaded",
      });
      const ledgerRow = page.locator(`[data-testid='row-transaction-${activeConsumption!.id}']`);
      await expect(ledgerRow).toBeVisible({ timeout: 10000 });
      await expect(ledgerRow).toContainText("Anfahrt: 12,70 km");

      // --- Verifikation 3: Rechnungs-Line-Item zeigt 12,7 km mit identischem Cent-Betrag ---
      const sr = await createSingleServiceRecord(session, {
        customerId: customer.id,
        appointmentId: appt.id,
      });
      // Task #1074: §45b ist eine Pflegekassen-Abrechnung — die ist NUR mit
      // Kundenunterschrift (status="completed") abrechenbar; eine reine
      // Mitarbeiter-Unterschrift ("employee_signed") genügt nicht mehr.
      // Daher beide Unterschriften setzen (employee → customer).
      for (const signerType of ["employee", "customer"] as const) {
        const { status, data } = await apiPost(
          session,
          `/api/service-records/${sr.id}/sign`,
          {
            signatureData: validSignatureDataUrl(),
            signerType,
            signingLocation: "Test-Smoke",
          },
        );
        if (status >= 300) {
          throw new Error(`sign service-record failed: ${status} ${JSON.stringify(data)}`);
        }
      }

      const apptDate = new Date(appt.date);
      const { status: genStatus, data: genData } = await apiPost<{
        invoices?: Array<{ id: number }>;
        invoice?: { id: number };
      }>(session, "/api/billing/generate", {
        customerId: customer.id,
        billingMonth: apptDate.getMonth() + 1,
        billingYear: apptDate.getFullYear(),
      });
      if (genStatus >= 300) {
        throw new Error(`billing/generate failed: ${genStatus} ${JSON.stringify(genData)}`);
      }
      const invoiceId =
        genData?.invoices?.[0]?.id ??
        genData?.invoice?.id ??
        (genData as { id?: number })?.id;
      expect(invoiceId, `Rechnungs-ID fehlt: ${JSON.stringify(genData)}`).toBeTruthy();

      type LineItem = {
        serviceCode?: string | null;
        quantityRaw?: string | number | null;
        quantityUnit?: string | null;
        totalCents: number;
      };
      const invoiceDetail = (await session.api
        .get(`/api/billing/${invoiceId}`)
        .then((r) => r.json())) as { lineItems?: LineItem[] };
      const travelLine = (invoiceDetail.lineItems ?? []).find(
        (li) => li.serviceCode === "travel_km",
      );
      expect(travelLine, `travel_km Line-Item fehlt: ${JSON.stringify(invoiceDetail.lineItems)}`).toBeTruthy();
      expect(travelLine!.quantityUnit).toBe("km");
      expect(Number(travelLine!.quantityRaw ?? 0)).toBeCloseTo(12.7, 3);
      // Drift-Anker: travelCents im Ledger MUSS == totalCents im Rechnungs-Line-Item.
      expect(travelLine!.totalCents).toBe(ledgerTravelCents);

      // --- Verifikation 4: Rechnungs-Detail in der Admin-UI zeigt "12,70 km" ---
      // Browser-Round-Trip auf /admin/billing — Rechnung über
      // button-detail-{id} ausklappen, in der Line-Item-Tabelle wird die
      // gerundete km-Menge via `renderLineItemQuantity` als "12,70 km"
      // gerendert (gleicher Helfer wie in der PDF). Das ist die einzige
      // Browser-View der Rechnung; die eigentliche PDF wird per
      // `target="_blank"` als Datei-Download geöffnet, ist also in
      // Playwright nicht direkt im DOM prüfbar.
      await page.goto("/admin/billing", { waitUntil: "domcontentloaded" });
      // Monat/Jahr explizit auf den Rechnungs-Zeitraum stellen — die
      // Billing-Seite filtert per Default auf den heutigen Monat, der
      // Test-Termin liegt aber ggf. im Folgemonat (createAppointment
      // setzt das Datum auf den nächsten Werktag +7).
      const billingMonth = apptDate.getMonth() + 1;
      const billingYear = apptDate.getFullYear();
      await page.locator("[data-testid='select-billing-month']").click();
      await page.getByRole("option", { name: new RegExp(`^${
        ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"][billingMonth - 1]
      }$`) }).click();
      await page.locator("[data-testid='select-billing-year']").click();
      await page.getByRole("option", { name: String(billingYear) }).click();

      const invoiceRow = page.locator(
        `[data-testid='invoice-row-${invoiceId}']`,
      );
      await expect(invoiceRow).toBeVisible({ timeout: 15000 });
      // Task #990: Sekundäraktionen (inkl. Details) liegen jetzt im
      // Überlauf-Menü — erst Menü öffnen, dann Detail-Eintrag klicken.
      await page.locator(`[data-testid='button-actions-menu-${invoiceId}']`).click();
      await page.locator(`[data-testid='button-detail-${invoiceId}']`).click();
      // Detail-Karte rendert direkt nach der Row — wir suchen den
      // km-Text innerhalb der Detail-Tabelle (toleranter Lookup, weil
      // die Karte kein eigenes data-testid hat).
      await expect(
        page.getByText("12,70 km").first(),
      ).toBeVisible({ timeout: 10000 });
    } finally {
      await deactivateEmployee(session, employee.id);
    }
  });

  // ---------- 7d. Termin-Minuten 45 → 72 — Drift-frei in Detail/Ledger/Rechnung (#635) ----------
  // Analog zum km-Drift-Test (#620): sichert die zweite Hälfte der Hotspot-
  // Matrix (Leistungs-Minuten) gegen Anzeige↔Buchung-Drift bei Re-Documentation
  // nach Reopen. PATCH erfolgt über die /document-API, weil 72 Min. nicht in
  // den UI-DURATION_OPTIONS (15er-Schritten) auswählbar ist — der serverseitige
  // Rebook-Pfad (rebook-storage.ts → createCascadeConsumption) ist identisch.
  test("Termin Hauswirtschaft 45 → 72 Min — Termin-Detail, Budget-Ledger und Rechnung zeigen identisch '1 Std. 12 Min.'", async ({ page }) => {
    test.setTimeout(90_000);
    const customer = await createCustomer(session);
    const employee = await createEmployee(session);
    await assignEmployee(session, customer.id, employee.id);

    // §45b mit Initial-Balance, damit die HW-Buchung im Kasse-Topf landet
    // und der Ledger-Row tatsächlich hauswirtschaftMinutes/-Cents trägt.
    const today = new Date();
    const initialFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    {
      const { status, data } = await apiPut(
        session,
        `/api/budget/${customer.id}/type-settings`,
        {
          settings: [
            {
              budgetType: "entlastungsbetrag_45b",
              enabled: true,
              priority: 1,
              monthlyLimitCents: 13100,
            },
          ],
        },
      );
      if (status >= 300) {
        throw new Error(`type-settings failed: ${status} ${JSON.stringify(data)}`);
      }
    }
    {
      const { status, data } = await apiPost(
        session,
        `/api/budget/${customer.id}/initial-balance/entlastungsbetrag_45b`,
        { amountCents: max45bStartValueCents("2024-01-01", `${initialFrom}-01`), validFrom: initialFrom },
      );
      if (status >= 300) {
        throw new Error(`initial-balance failed: ${status} ${JSON.stringify(data)}`);
      }
    }

    const appt = await createAppointment(session, {
      customerId: customer.id,
      employeeId: employee.id,
    });
    const hwServiceId = await getServiceIdByCode(session, "hauswirtschaft");

    try {
      // --- Schritt 1: Termin mit 45 Min. dokumentieren (API) ---
      const docPayload45 = {
        actualStart: "10:00",
        travelOriginType: "home" as const,
        travelKilometers: 0,
        services: [
          {
            serviceId: hwServiceId,
            actualDurationMinutes: 45,
            details: "Minuten-Drift-Smoketest",
          },
        ],
      };
      {
        const { status, data } = await apiPost(
          session,
          `/api/appointments/${appt.id}/document`,
          docPayload45,
        );
        if (status >= 300) {
          throw new Error(`document(45) failed: ${status} ${JSON.stringify(data)}`);
        }
      }

      type BudgetTx = {
        id: number;
        transactionType: string;
        budgetType: string;
        hauswirtschaftMinutes?: number | null;
        hauswirtschaftCents?: number | null;
        reversedTransactionId?: number | null;
      };
      const findActiveConsumption = (txs: BudgetTx[]) => {
        const reversed = new Set(
          txs
            .filter((t) => t.reversedTransactionId != null)
            .map((t) => t.reversedTransactionId as number),
        );
        return txs.find(
          (t) => t.transactionType === "consumption" && !reversed.has(t.id),
        );
      };

      const txsAfterFirst = (await session.api
        .get(`/api/budget/${customer.id}/transactions?budgetType=entlastungsbetrag_45b`)
        .then((r) => r.json())) as BudgetTx[];
      const firstConsumption = findActiveConsumption(txsAfterFirst);
      expect(firstConsumption, "Aktive §45b-Consumption (45 Min.) muss existieren").toBeTruthy();
      expect(firstConsumption!.hauswirtschaftMinutes ?? 0).toBe(45);

      // --- Schritt 2: Reopen via API ---
      {
        const { status, data } = await apiPost(
          session,
          `/api/appointments/${appt.id}/reopen`,
          {},
        );
        if (status >= 300) {
          throw new Error(`reopen failed: ${status} ${JSON.stringify(data)}`);
        }
      }

      // --- Schritt 3: Re-Document mit 72 Min. (PATCH-analog via /document) ---
      const docPayload72 = {
        ...docPayload45,
        services: [
          { ...docPayload45.services[0], actualDurationMinutes: 72 },
        ],
      };
      {
        const { status, data } = await apiPost(
          session,
          `/api/appointments/${appt.id}/document`,
          docPayload72,
        );
        if (status >= 300) {
          throw new Error(`document(72) failed: ${status} ${JSON.stringify(data)}`);
        }
      }

      // --- Verifikation 1: Termin-Detail-Seite (Reload) zeigt "1 Std. 12 Min." ---
      await page.goto(`/appointment/${appt.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("1 Std. 12 Min.").first()).toBeVisible({
        timeout: 10000,
      });

      // --- Verifikation 2: Aktive Ledger-Buchung trägt 72 Min. + Cents > 0 ---
      const txsAfterEdit = (await session.api
        .get(`/api/budget/${customer.id}/transactions?budgetType=entlastungsbetrag_45b`)
        .then((r) => r.json())) as BudgetTx[];
      const activeConsumption = findActiveConsumption(txsAfterEdit);
      expect(activeConsumption, "Aktive §45b-Consumption (72 Min.) muss existieren").toBeTruthy();
      expect(activeConsumption!.id).not.toBe(firstConsumption!.id);
      expect(activeConsumption!.hauswirtschaftMinutes ?? 0).toBe(72);
      const ledgerHwCents = activeConsumption!.hauswirtschaftCents ?? 0;
      expect(ledgerHwCents).toBeGreaterThan(0);

      // UI-Ledger im Budget-Tab muss „HW: 72min" rendern (BudgetLedgerSection).
      await page.goto(`/admin/customers/${customer.id}?tab=budgets`, {
        waitUntil: "domcontentloaded",
      });
      const ledgerRow = page.locator(
        `[data-testid='row-transaction-${activeConsumption!.id}']`,
      );
      await expect(ledgerRow).toBeVisible({ timeout: 10000 });
      await expect(ledgerRow).toContainText("HW: 72min");

      // --- Verifikation 3: Rechnungs-Line-Item zeigt 72 Min. mit identischem Cent-Betrag ---
      const sr = await createSingleServiceRecord(session, {
        customerId: customer.id,
        appointmentId: appt.id,
      });
      // Task #1074: §45b = Pflegekassen-Abrechnung → Kundenunterschrift Pflicht
      // (employee_signed allein genügt nicht). Beide Unterschriften setzen.
      for (const signerType of ["employee", "customer"] as const) {
        const { status, data } = await apiPost(
          session,
          `/api/service-records/${sr.id}/sign`,
          {
            signatureData: validSignatureDataUrl(),
            signerType,
            signingLocation: "Test-Smoke",
          },
        );
        if (status >= 300) {
          throw new Error(`sign service-record failed: ${status} ${JSON.stringify(data)}`);
        }
      }

      const apptDate = new Date(appt.date);
      const { status: genStatus, data: genData } = await apiPost<{
        invoices?: Array<{ id: number }>;
        invoice?: { id: number };
      }>(session, "/api/billing/generate", {
        customerId: customer.id,
        billingMonth: apptDate.getMonth() + 1,
        billingYear: apptDate.getFullYear(),
      });
      if (genStatus >= 300) {
        throw new Error(`billing/generate failed: ${genStatus} ${JSON.stringify(genData)}`);
      }
      const invoiceId =
        genData?.invoices?.[0]?.id ??
        genData?.invoice?.id ??
        (genData as { id?: number })?.id;
      expect(invoiceId, `Rechnungs-ID fehlt: ${JSON.stringify(genData)}`).toBeTruthy();

      type LineItem = {
        serviceCode?: string | null;
        quantityRaw?: string | number | null;
        quantityUnit?: string | null;
        durationMinutes?: number | null;
        totalCents: number;
      };
      const invoiceDetail = (await session.api
        .get(`/api/billing/${invoiceId}`)
        .then((r) => r.json())) as { lineItems?: LineItem[] };
      const hwLine = (invoiceDetail.lineItems ?? []).find(
        (li) => li.serviceCode === "hauswirtschaft",
      );
      expect(
        hwLine,
        `hauswirtschaft Line-Item fehlt: ${JSON.stringify(invoiceDetail.lineItems)}`,
      ).toBeTruthy();
      expect(hwLine!.quantityUnit).toBe("hours");
      // quantityRaw = 72/60 = 1.2 — Drift-Anker zwischen Anzeige (1 Std. 12 Min.)
      // und Berechnung. durationMinutes (Fallback) muss ebenfalls 72 betragen.
      expect(Number(hwLine!.quantityRaw ?? 0)).toBeCloseTo(72 / 60, 5);
      expect(hwLine!.durationMinutes ?? 0).toBe(72);
      // Drift-Anker: hauswirtschaftCents im Ledger MUSS == totalCents der Rechnungs-Line.
      expect(hwLine!.totalCents).toBe(ledgerHwCents);

      // --- Verifikation 4: Rechnungs-Detail in der Admin-UI zeigt "1 Std. 12 Min." ---
      await page.goto("/admin/billing", { waitUntil: "domcontentloaded" });
      const billingMonth = apptDate.getMonth() + 1;
      const billingYear = apptDate.getFullYear();
      await page.locator("[data-testid='select-billing-month']").click();
      await page
        .getByRole("option", {
          name: new RegExp(
            `^${[
              "Januar",
              "Februar",
              "März",
              "April",
              "Mai",
              "Juni",
              "Juli",
              "August",
              "September",
              "Oktober",
              "November",
              "Dezember",
            ][billingMonth - 1]}$`,
          ),
        })
        .click();
      await page.locator("[data-testid='select-billing-year']").click();
      await page.getByRole("option", { name: String(billingYear) }).click();

      const invoiceRow = page.locator(`[data-testid='invoice-row-${invoiceId}']`);
      await expect(invoiceRow).toBeVisible({ timeout: 15000 });
      // Task #990: Detail-Aktion liegt jetzt im Überlauf-Menü.
      await page.locator(`[data-testid='button-actions-menu-${invoiceId}']`).click();
      await page.locator(`[data-testid='button-detail-${invoiceId}']`).click();
      await expect(page.getByText("1 Std. 12 Min.").first()).toBeVisible({
        timeout: 10000,
      });
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

  // ---------- 9b. Service-Katalog: 0,00 € als Kundenpreis (Task #566) ----------
  // Schützt davor, dass eine zukünftige Frontend-Validator-Regression "0,00"
  // als Kundenpreis ablehnt. Backend lässt `priceCents: 0` zu (siehe
  // tests/services.test.ts) — hier prüfen wir den Round-Trip über die UI.
  test("Kundenpreis 0,00 € für Anfahrtskilometer speichern und nach Reload anzeigen", async ({ page }) => {
    // PricingSection rendert nur für Selbstzahler-Kunden (siehe
    // customer-contract-tab.tsx).
    const customer = await createCustomer(session, { billingType: "selbstzahler" });
    const travelKmServiceId = await getServiceIdByCode(session, "travel_km");

    await page.goto(`/admin/customers/${customer.id}?tab=vertrag`, {
      waitUntil: "domcontentloaded",
    });

    const row = page.locator(`[data-testid='pricing-row-${travelKmServiceId}']`);
    await expect(row).toBeVisible({ timeout: 15000 });

    // Edit-Modus öffnen.
    await page.locator(`[data-testid='btn-edit-price-${travelKmServiceId}']`).click();

    const priceInput = page.locator(`[data-testid='input-price-${travelKmServiceId}']`);
    await expect(priceInput).toBeVisible({ timeout: 10000 });
    await priceInput.fill("0,00");

    await clickSaveAndWait(
      page,
      { url: `/api/customers/${customer.id}/service-prices`, methods: ["POST"] },
      `btn-save-price-${travelKmServiceId}`,
    );

    // Kein Toast-Fehler (Frontend-Validator-Regression würde einen
    // "Ungültiger Preis"-Toast werfen, bevor die Mutation feuert).
    await expect(page.getByText("Ungültiger Preis")).toHaveCount(0);

    // Vollständiger Reload — anschließend muss "0,00" mit Einheit "€/km"
    // im Pricing-Row sichtbar sein, und der "Kundenpreis"-Badge erscheinen.
    await page.goto(`/admin/customers/${customer.id}?tab=vertrag`, {
      waitUntil: "domcontentloaded",
    });

    const rowAfter = page.locator(`[data-testid='pricing-row-${travelKmServiceId}']`);
    await expect(rowAfter).toBeVisible({ timeout: 15000 });
    await expect(rowAfter).toContainText("0,00");
    await expect(rowAfter).toContainText("€/km");
    await expect(rowAfter).toContainText("Kundenpreis");

    // API-Persistenz zusätzlich absichern.
    const fetched = (await session.api
      .get(`/api/customers/${customer.id}/service-prices`)
      .then((r) => (r.ok() ? r.json() : []))) as Array<{
      serviceId: number;
      priceCents: number;
    }>;
    const persisted = fetched.find((p) => p.serviceId === travelKmServiceId);
    expect(persisted?.priceCents).toBe(0);
  });

  test("Kundenpreis: negative Eingabe (-0,01) wird im UI abgelehnt", async ({ page }) => {
    // PricingSection rendert nur für Selbstzahler-Kunden (siehe
    // customer-contract-tab.tsx).
    const customer = await createCustomer(session, { billingType: "selbstzahler" });
    const travelKmServiceId = await getServiceIdByCode(session, "travel_km");

    await page.goto(`/admin/customers/${customer.id}?tab=vertrag`, {
      waitUntil: "domcontentloaded",
    });

    const row = page.locator(`[data-testid='pricing-row-${travelKmServiceId}']`);
    await expect(row).toBeVisible({ timeout: 15000 });

    await page.locator(`[data-testid='btn-edit-price-${travelKmServiceId}']`).click();

    const priceInput = page.locator(`[data-testid='input-price-${travelKmServiceId}']`);
    await expect(priceInput).toBeVisible({ timeout: 10000 });
    await priceInput.fill("-0,01");

    // Speichern anklicken — der Frontend-Validator MUSS dies ablehnen,
    // ohne dass eine POST-Mutation rausgeht.
    let postFired = false;
    const onRequest = (req: import("@playwright/test").Request) => {
      if (
        req.method() === "POST"
        && req.url().includes(`/api/customers/${customer.id}/service-prices`)
      ) {
        postFired = true;
      }
    };
    page.on("request", onRequest);

    try {
      await page.locator(`[data-testid='btn-save-price-${travelKmServiceId}']`).click();

      // Fehler-Toast muss sichtbar werden.
      await expect(page.getByText("Ungültiger Preis").first()).toBeVisible({
        timeout: 5000,
      });

      // Kurzer Puffer, damit eine ggf. fälschlich gefeuerte Mutation noch
      // sichtbar würde — falls der Validator umgangen wird, fängt die
      // postFired-Assertion das ab.
      await page.waitForTimeout(300);
      expect(postFired, "Negativer Preis darf keine POST-Mutation auslösen").toBe(false);
    } finally {
      page.off("request", onRequest);
    }
  });

  // ---------- 9b. §45b-Carryover über die UI löschen (Task #610) ----------
  // Sichert den User-Flow ab, der in Production gebrochen war:
  // Admin öffnet Kunden-Budget → sieht „Übertrag"-Badge → klickt Trash →
  // bestätigt → Übertrag verschwindet, BudgetSummary stimmt nach Reload.
  // Backend-Pfad ist durch Vitest abgesichert (tests/budget/task-608-*),
  // der UI-Pfad (Toggle „Startwert festlegen" → Delete-Confirm-Mini-UI →
  // Refetch der Summary) ist hier dran.
  test("§45b-Carryover — Löschen über die UI persistiert nach Reload", async ({ page }) => {
    const customer = await createCustomer(session);

    // §45b aktivieren — sonst rendert die Kachel nicht und der Carryover wird
    // beim nächsten syncCarryoverAndExpiry nicht als „aktiv" geführt.
    {
      const { status, data } = await apiPut(
        session,
        `/api/budget/${customer.id}/type-settings`,
        {
          settings: [
            {
              budgetType: "entlastungsbetrag_45b",
              enabled: true,
              priority: 1,
            },
          ],
        },
      );
      if (status >= 300) {
        throw new Error(`type-settings failed: ${status} ${JSON.stringify(data)}`);
      }
    }

    // Carryover seeden via /initial-budget: legt eine `source='carryover'`
    // Allocation für das laufende Jahr an (validFrom = YYYY-01-01,
    // expiresAt = YYYY-06-30). Der laufende Jahresanteil wird mit 0 übersprungen.
    const carryoverCents = 25000;
    const today = new Date();
    const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    {
      const { status, data } = await apiPost(
        session,
        `/api/budget/${customer.id}/initial-budget`,
        {
          budgetType: "entlastungsbetrag_45b",
          currentMonthAmountCents: 0,
          carryoverAmountCents: carryoverCents,
          budgetStartDate: todayISO,
        },
      );
      if (status >= 300) {
        throw new Error(`initial-budget seed failed: ${status} ${JSON.stringify(data)}`);
      }
    }

    // Pre-Check: Carryover muss serverseitig vorhanden sein (sonst testet der
    // UI-Pfad ein leeres Listenelement und „grünt" fälschlich).
    {
      const before = (await session.api
        .get(`/api/budget/${customer.id}/initial-balances/entlastungsbetrag_45b`)
        .then((r) => (r.ok() ? r.json() : []))) as Array<{ source?: string; amountCents?: number }>;
      const carry = before.find((a) => a.source === "carryover");
      expect(carry, "Seed: Carryover-Allocation nicht angelegt").toBeTruthy();
      expect(carry?.amountCents).toBe(carryoverCents);
    }

    await page.goto(`/admin/customers/${customer.id}?tab=budgets`, {
      waitUntil: "domcontentloaded",
    });

    // Task #670 — Carryover hat jetzt eine eigene Sektion (getrennt vom
    // Startwert). Nach Aufklappen von „Startwert festlegen" muss die
    // Carryover-Sektion sichtbar sein und mind. eine „Übertrag"-Zeile zeigen.
    const toggle = page.locator(
      "[data-testid='btn-toggle-initial-balance-entlastungsbetrag_45b']",
    );
    await expect(toggle).toBeVisible({ timeout: 10000 });
    await toggle.click();

    const carryoverSection = page.locator(
      "[data-testid='carryover-section-entlastungsbetrag_45b']",
    );
    await expect(carryoverSection).toBeVisible({ timeout: 10000 });
    await expect(carryoverSection).toContainText("Übertrag");

    // BudgetSummary zeigt den Carryover-Wert vor dem Löschen.
    await expect(page.locator("[data-testid='text-45b-carryover']")).toBeVisible({
      timeout: 10000,
    });

    // Trash → Mini-Confirm → DELETE abwarten. Die Zeile trägt den Quelljahr-
    // Suffix; wir treffen sie über das gemeinsame Präfix.
    const deleteBtn = carryoverSection.locator(
      "[data-testid^='btn-delete-carryover-entlastungsbetrag_45b']",
    ).first();
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();
    const confirm = carryoverSection.locator(
      "[data-testid^='btn-confirm-delete-carryover-entlastungsbetrag_45b']",
    ).first();
    await expect(confirm).toBeVisible({ timeout: 5000 });
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.ok() &&
          r.request().method() === "DELETE" &&
          r.url().includes(`/api/budget/${customer.id}/initial-balance/`),
        { timeout: 15000 },
      ),
      confirm.click(),
    ]);

    // Vollständiger Reload — `page.reload()` allein würde nur den Cache des
    // SPA neu hydratisieren; Re-Navigation forciert frische Queries.
    await page.goto(`/admin/customers/${customer.id}?tab=budgets`, {
      waitUntil: "domcontentloaded",
    });

    // UI: „Startwert festlegen" wieder aufklappen — die Carryover-Zeile darf
    // jetzt nicht mehr existieren.
    await page
      .locator("[data-testid='btn-toggle-initial-balance-entlastungsbetrag_45b']")
      .click();
    await expect(
      page.locator("[data-testid^='text-carryover-entlastungsbetrag_45b']"),
    ).toHaveCount(0);

    // BudgetSummary-Kachel verschwindet, sobald `carryoverCents === 0`.
    await expect(
      page.locator("[data-testid='text-45b-carryover']"),
    ).toHaveCount(0);

    // API-Verifikation: Carryover ist server-seitig weg, Summary stimmt.
    const after = (await session.api
      .get(`/api/budget/${customer.id}/initial-balances/entlastungsbetrag_45b`)
      .then((r) => (r.ok() ? r.json() : []))) as Array<{ source?: string }>;
    expect(after.some((a) => a.source === "carryover")).toBe(false);

    const summary = (await session.api
      .get(`/api/budget/${customer.id}/summary`)
      .then((r) => (r.ok() ? r.json() : null))) as
      | { carryoverCents?: number }
      | null;
    if (summary && typeof summary.carryoverCents === "number") {
      expect(summary.carryoverCents).toBe(0);
    }
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

  // ---------- 11. Firmenweiter Standardpreis (Task #1360) ----------
  // Round-Trip für die "Standardpreise"-Sektion der Admin-Service-Seite
  // (Task #1357 hat die Editier-Oberfläche eingeführt). Deckt das Anlegen
  // eines firmenweiten Standardpreises MIT Stichtag und den
  // PRICE_CONFLICT-Confirm-Replace-Pfad ab. Die Standardpreis-Zeilen sind
  // firmenweit (kein Kunde) — daher Stichtag weit in der Zukunft wählen
  // (kein Einfluss auf die heute aktive Preisauflösung / Schwester-Tests)
  // und in `finally` per API wieder soft-löschen.
  test("Standardpreis anlegen + ersetzen (PRICE_CONFLICT) persistiert nach Reload", async ({ page }) => {
    const serviceId = await getServiceIdByCode(session, "hauswirtschaft");

    // Eindeutiger Zukunfts-Stichtag pro Lauf — verhindert, dass ein
    // hängengebliebener (nicht aufgeräumter) Eintrag aus einem früheren Lauf
    // einen unerwarteten PRICE_CONFLICT bereits beim ersten Speichern auslöst.
    const stamp = Date.now();
    const farYear = new Date().getFullYear() + 11;
    const month = String((stamp % 12) + 1).padStart(2, "0");
    const day = String((stamp % 28) + 1).padStart(2, "0");
    const validFrom = `${farYear}-${month}-${day}`;

    const createdPriceIds: number[] = [];

    const waitForCreatedPrice = async (clickAction: Promise<void>): Promise<number> => {
      const [resp] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.ok() &&
            r.request().method() === "POST" &&
            r.url().includes("/api/services/standard-prices") &&
            !r.url().includes("/future") &&
            !r.url().includes("/all"),
          { timeout: 15000 },
        ),
        clickAction,
      ]);
      const body = (await resp.json()) as { id?: number };
      expect(body.id, "POST /standard-prices muss die angelegte Preis-Zeile zurückgeben").toBeTruthy();
      return body.id!;
    };

    try {
      // --- Schritt 1: Standardpreis 111,11 € mit Zukunfts-Stichtag anlegen ---
      await page.goto("/admin/services", { waitUntil: "domcontentloaded" });

      const row = page.locator(`[data-testid='pricing-row-${serviceId}']`);
      await expect(row).toBeVisible({ timeout: 15000 });

      await page.locator(`[data-testid='btn-edit-price-${serviceId}']`).click();
      const priceField = page.locator(`[data-testid='input-price-${serviceId}']`);
      await expect(priceField).toBeVisible({ timeout: 10000 });
      await priceField.fill("111,11");
      await page.locator(`[data-testid='input-valid-from-${serviceId}']`).fill(validFrom);

      const firstId = await waitForCreatedPrice(
        page.locator(`[data-testid='btn-save-price-${serviceId}']`).click(),
      );
      createdPriceIds.push(firstId);

      // --- Reload + Persistenz-Check (Zukunfts-Preis sichtbar) ---
      await page.reload({ waitUntil: "domcontentloaded" });
      const futureEntry = page.locator(`[data-testid='future-price-${firstId}']`);
      await expect(futureEntry).toBeVisible({ timeout: 10000 });
      await expect(futureEntry).toContainText("111,11");

      // API-Verifikation: Zeile existiert mit korrektem Stichtag + Preis.
      const futures = (await session.api
        .get("/api/services/standard-prices/future")
        .then((r) => (r.ok() ? r.json() : []))) as Array<{
        id: number;
        priceCents: number;
        validFrom: string;
      }>;
      const persisted = futures.find((f) => f.id === firstId);
      expect(persisted, `Standardpreis ${firstId} nicht in /future persistiert`).toBeTruthy();
      expect(persisted!.priceCents).toBe(11111);

      // --- Schritt 2: Gleicher Stichtag → PRICE_CONFLICT → "Ja, ersetzen" ---
      await page.locator(`[data-testid='btn-edit-price-${serviceId}']`).click();
      const priceField2 = page.locator(`[data-testid='input-price-${serviceId}']`);
      await expect(priceField2).toBeVisible({ timeout: 10000 });
      await priceField2.fill("222,22");
      await page.locator(`[data-testid='input-valid-from-${serviceId}']`).fill(validFrom);

      // Speichern löst zunächst den 409 PRICE_CONFLICT aus → Ersetzen-Dialog.
      await page.locator(`[data-testid='btn-save-price-${serviceId}']`).click();
      const replaceDialog = page.locator("[data-testid='dialog-replace-price']");
      await expect(replaceDialog).toBeVisible({ timeout: 10000 });
      await expect(page.locator("[data-testid='text-new-price']")).toContainText("222,22");

      const replacedId = await waitForCreatedPrice(
        page.locator("[data-testid='btn-confirm-replace']").click(),
      );
      createdPriceIds.push(replacedId);

      // --- Reload + Persistenz-Check (ersetzter Preis sichtbar, alter weg) ---
      await page.reload({ waitUntil: "domcontentloaded" });
      const replacedEntry = page.locator(`[data-testid='future-price-${replacedId}']`);
      await expect(replacedEntry).toBeVisible({ timeout: 10000 });
      await expect(replacedEntry).toContainText("222,22");
      await expect(
        page.locator(`[data-testid='future-price-${firstId}']`),
      ).toHaveCount(0);

      const futuresAfter = (await session.api
        .get("/api/services/standard-prices/future")
        .then((r) => (r.ok() ? r.json() : []))) as Array<{
        id: number;
        priceCents: number;
      }>;
      expect(futuresAfter.find((f) => f.id === replacedId)?.priceCents).toBe(22222);
      expect(futuresAfter.some((f) => f.id === firstId)).toBe(false);
    } finally {
      // Firmenweite Zeilen wieder entfernen (Zukunfts-Stichtag ⇒ Soft-Delete).
      for (const id of createdPriceIds) {
        await session.api
          .delete(`/api/services/standard-prices/${id}`)
          .catch(() => {
            /* best-effort */
          });
      }
    }
  });
});
