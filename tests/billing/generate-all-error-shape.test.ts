/**
 * Task #586 — Massenerstellung HTTP 500 reproduzieren und absichern.
 *
 * Regressionstest: Wenn `generateInvoiceCore` aus `/api/billing/generate-all`
 * unerwartet wirft (hier via Fault-Injection `x-test-inject-fault: audit_log`),
 * MUSS der Endpoint trotzdem mit Content-Type `application/json` antworten
 * und im Body ein `message`-Feld liefern — entweder im äußeren Error-Envelope
 * oder pro Kunde in `results[].message`.
 *
 * Hintergrund: In Prod hat „Alle offenen erstellen" mit dem leeren Toast
 * „HTTP 500:" abgebrochen. Genau das passiert nur, wenn `response.json()`
 * im Client scheitert (HTML-/Empty-Body vom Proxy oder vom Express-Default-
 * Error-Handler). Dieser Test sichert ab, dass die Server-Antwort in jedem
 * Fall parsebar ist und im Frontend eine konkrete Meldung erscheinen kann.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiDelete,
  apiPost,
  getAuthCookie,
  runCleanup,
} from "../test-utils";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

function weekdayInCurrentMonth(): string {
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  for (let offset = 0; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}

let scenario: BudgetScenarioHandle;
const cleanupSrIds: number[] = [];

beforeAll(async () => {
  await getAuthCookie();
  const apptDate = weekdayInCurrentMonth();
  scenario = await setupBudgetScenario({
    customerNamePrefix: "Auto_T586",
    pflegegrad: 3,
    billingType: "selbstzahler",
    acceptsPrivatePayment: false,
    types: [
      { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
    appointments: [
      {
        date: apptDate,
        scheduledStart: "01:00",
        services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
        document: true,
        actualStart: "01:00",
      },
    ],
  });

  // Signierter LN ist Voraussetzung dafür, dass der Kunde in
  // `eligible-customers` (und damit in der `generate-all`-Schleife) landet.
  const today = new Date();
  const srRes = await apiPost<any>("/api/service-records", {
    customerId: scenario.customerId,
    employeeId: scenario.employeeId,
    year: today.getFullYear(),
    month: today.getMonth() + 1,
  });
  expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
  cleanupSrIds.push(srRes.data.id);
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost<any>(`/api/service-records/${srRes.data.id}/sign`, {
      signerType,
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(sig.status).toBe(200);
  }
});

afterAll(async () => {
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  if (scenario) await scenario.cleanup();
  await runCleanup();
});

describe("Task #586 — /generate-all liefert bei Fehler immer JSON", () => {
  it("antwortet mit Content-Type application/json und einem message-Feld, wenn generateInvoiceCore wirft", async () => {
    const auth = await getAuthCookie();
    const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
    const today = new Date();

    const response = await fetch(`${BASE_URL}/api/billing/generate-all`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "x-csrf-token": auth.csrfToken,
        // Erzwingt einen unerwarteten Fehler innerhalb von
        // `generateInvoiceCore` → `withAudit` → `maybeFail("audit_log")`.
        "x-test-inject-fault": "audit_log",
      },
      body: JSON.stringify({
        billingMonth: today.getMonth() + 1,
        billingYear: today.getFullYear(),
      }),
    });

    // 1. Content-Type MUSS JSON sein (kein HTML-Fallback, kein leerer Body).
    const contentType = response.headers.get("content-type") || "";
    expect(contentType, `unerwarteter Content-Type: "${contentType}"`).toMatch(/application\/json/i);

    // 2. Body MUSS sich als JSON parsen lassen.
    const text = await response.text();
    expect(text.length, "Body darf nicht leer sein").toBeGreaterThan(0);
    let parsed: any;
    expect(() => { parsed = JSON.parse(text); }, `Body ist kein JSON: ${text.slice(0, 200)}`).not.toThrow();

    // 3. Irgendwo MUSS ein nicht-leeres `message`-Feld stehen — entweder als
    //    äußerer Error-Envelope (`{code, message}`) oder pro Kunde in
    //    `results[].message`. Status egal — Hauptsache parsebar mit Kontext.
    const outerMsg = typeof parsed?.message === "string" ? parsed.message : "";
    const innerMsgs: string[] = Array.isArray(parsed?.results)
      ? parsed.results.map((r: any) => typeof r?.message === "string" ? r.message : "").filter(Boolean)
      : [];
    const combined = [outerMsg, ...innerMsgs].filter(Boolean);
    expect(
      combined.length,
      `Antwort enthält kein message-Feld. Body=${text.slice(0, 400)}`,
    ).toBeGreaterThan(0);

    // 4. Wenn der Endpoint per Schleife antwortet (200 mit results), MUSS
    //    unser Fault-Kunde als status="error" markiert sein.
    if (Array.isArray(parsed?.results)) {
      const errorEntry = parsed.results.find((r: any) =>
        r?.customerId === scenario.customerId && r?.status === "error",
      );
      expect(
        errorEntry,
        `Erwarte status="error" für Fault-Kunde. results=${JSON.stringify(parsed.results)}`,
      ).toBeTruthy();
      expect(typeof errorEntry.message, "Fault-Eintrag muss message tragen").toBe("string");
      expect(errorEntry.message.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
