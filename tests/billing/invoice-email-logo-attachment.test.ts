/**
 * Task #1104 — Firmenlogo in Abrechnungs-E-Mails als Inline-`cid:`-Anhang.
 *
 * Regression-Schutz: Das Firmenlogo MUSS als echter Inline-Anhang
 * (`contentDisposition: "inline"`, `cid: "company-logo"`) mitgeschickt werden
 * und der HTML-Body MUSS es über `src="cid:company-logo"` referenzieren — NIE
 * als eingebettete `data:`-URI (die GMX/Outlook/Gmail teils blocken bzw. die
 * den Mail-Body massiv aufblähen).
 *
 * Abgedeckte Versand-Pfade (alle über die ECHTEN HTTP-Routen):
 *   - Einzel-Versand  POST /api/billing/:id/send
 *   - Stapel-Versand  POST /api/billing/send-batch
 *   - Kunden-Kopie    (receivesMonthlyInvoice=true) in BEIDEN Pfaden
 *   - Fallback        kein Logo konfiguriert → KEIN Anhang, KEIN kaputtes Bild
 *
 * Ein gesetzlich versicherter Kunde mit `rechnungAnKunde=false` +
 * `receivesMonthlyInvoice=true` + `documentDeliveryMethod="email"` erzeugt pro
 * Versand BEIDE Mails: die Rechnung an die Pflegekasse UND die Monats-Kopie an
 * den Kunden. So decken Einzel- und Stapel-Versand jeweils Kassen- und
 * Kunden-Kopie in einem Flow ab.
 *
 * Das Logo wird als echte (Mini-)PNG ins Object Storage geschrieben und über
 * `company_settings.logoUrl` referenziert; der Versand-Pfad lädt es via
 * `loadLogoBytes` und hängt es über `buildLogoInlineAttachment` an.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { objectStorageClient } from "../../server/replit_integrations/object_storage/objectStorage";
import { getPrivateDir, parseObjectPath } from "../../server/lib/object-storage-helpers";
import { validSignatureDataUrl } from "../helpers/valid-signature";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  getTestOutbox,
  clearTestOutbox,
  runCleanup,
  uniqueId,
  type TestOutboxMessage,
} from "../test-utils";

// Der `cid`-Wert ist Vertragsbestandteil (Task #1104): HTML referenziert
// `src="cid:company-logo"`, der Anhang trägt exakt diese Content-ID.
const LOGO_CID = "company-logo";

// Kleinste gültige PNG (1×1, transparent). Reicht als echtes, ladbares Logo.
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function resolveObject(storedPath: string): { bucketName: string; objectName: string } {
  let key = storedPath;
  if (key.startsWith("/objects/")) key = key.slice("/objects/".length);
  let dir = getPrivateDir();
  if (!dir.endsWith("/")) dir = `${dir}/`;
  return parseObjectPath(`${dir}${key}`);
}

async function writeLogoObject(storedPath: string): Promise<void> {
  const { bucketName, objectName } = resolveObject(storedPath);
  await objectStorageClient.bucket(bucketName).file(objectName).save(LOGO_PNG, {
    contentType: "image/png",
  });
}

function logoAttachmentOf(msg: TestOutboxMessage) {
  return msg.attachments.find((a) => a.cid === LOGO_CID);
}

// Positiv-Prüfung: Mail trägt das Logo als Inline-cid-Anhang, HTML referenziert
// es über cid: — und NICHT als data:-URI.
function expectInlineLogo(msg: TestOutboxMessage, label: string): void {
  const att = logoAttachmentOf(msg);
  expect(att, `${label}: Inline-Logo-Anhang (cid=${LOGO_CID}) muss vorhanden sein`).toBeTruthy();
  expect(att!.contentDisposition, `${label}: Logo-Anhang muss "inline" sein`).toBe("inline");
  expect(att!.contentType, `${label}: Logo-Anhang ist ein Bild`).toContain("image/");
  expect(att!.contentBase64.length, `${label}: Logo-Anhang trägt Bytes`).toBeGreaterThan(0);
  expect(msg.html, `${label}: HTML referenziert das Logo über cid:`).toContain(`src="cid:${LOGO_CID}"`);
  expect(msg.html, `${label}: HTML enthält KEINE data:-URI (Regression)`).not.toContain("data:image");
}

describe("Task #1104 — Firmenlogo als Inline-cid-Anhang in Abrechnungs-E-Mails", () => {
  const YEAR = 2026;
  const SINGLE_MONTH = 3; // Einzel-Versand (POST /:id/send)
  const BATCH_MONTH = 2; // Stapel-Versand (POST /send-batch)
  const NOLOGO_MONTH = 1; // Fallback ohne Logo

  let customerId: number;
  let employeeId: number;
  let hwServiceId: number;
  let insuranceProviderId: number;
  let kasseEmail: string;
  let customerEmail: string;
  let logoUrl: string;

  const cleanupApptIds: number[] = [];
  const cleanupSrIds: number[] = [];
  const cleanupInvoiceIds: number[] = [];

  beforeAll(async () => {
    await getAuthCookie();
    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    // Dedizierte gesetzliche Pflegekasse mit E-Mail-Versand (eigene Kasse →
    // keine geseedete Kasse mutieren, eindeutig pro Lauf).
    kasseEmail = `kasse-logo-${uniqueId()}@test.local`;
    const ik = String(Math.floor(100000000 + Math.random() * 900000000));
    const provRes = await apiPost<{ id: number }>("/api/admin/insurance-providers", {
      name: `Logo-Kasse ${uniqueId()}`,
      isPrivate: false,
      ikNummer: ik,
      strasse: "Kassenweg",
      hausnummer: "1",
      plz: "10115",
      stadt: "Berlin",
      email: kasseEmail,
      emailInvoiceEnabled: true,
    });
    expect(provRes.status, `create provider: ${JSON.stringify(provRes.data)}`).toBe(201);
    insuranceProviderId = provRes.data.id;

    // Gesetzlicher Kunde, rechnungAnKunde=false (Rechnung an Kasse),
    // receivesMonthlyInvoice=true + email → zusätzlich Monats-Kopie an Kunden.
    customerEmail = `kunde-logo-${uniqueId()}@test.local`;
    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Logo",
      nachname: `Empfaenger-${uniqueId()}`,
      geburtsdatum: "1942-05-05",
      email: customerEmail,
      strasse: "Musterstraße",
      nr: "7",
      plz: "10117",
      stadt: "Berlin",
      telefon: "+4917600000005",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      receivesMonthlyInvoice: true,
      documentDeliveryMethod: "email",
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "L" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    const emp = await createTestEmployee({ nachnamePrefix: "LogoMail_Integ" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

    // §45b reichlich ab dem frühesten Monat → alle drei Termine voll gedeckt,
    // Rechnung bleibt pflegekasse_gesetzlich.
    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${NOLOGO_MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    // SMTP-Dummy-Konfig: Der Versand-Pfad ruft `ensureSmtpConfigured` VOR der
    // Stub-Weiche auf. Logo-URL zeigt auf eine echte, eindeutige PNG im Bucket.
    logoUrl = `/objects/test-logos/logo-${uniqueId()}.png`;
    await writeLogoObject(logoUrl);
    const settingsRes = await apiPatch(`/api/company-settings`, {
      smtpHost: "smtp.test.local",
      smtpPort: "587",
      smtpUser: "outbox@test.local",
      smtpPass: "stub-secret",
      smtpFromEmail: "absender@test.local",
      smtpFromName: "CareConnect Test",
      logoUrl,
    });
    expect(settingsRes.status, `company-settings: ${JSON.stringify(settingsRes.data)}`).toBe(200);
  });

  afterAll(async () => {
    for (const id of cleanupSrIds) {
      try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
    }
    for (const id of cleanupApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await runCleanup();
  });

  // Erzeugt für einen Monat einen signierten, gesetzlich gedeckten Entwurf.
  async function generateSignedInvoice(month: number): Promise<{ invoiceId: number; invoiceNumber: string }> {
    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: `${YEAR}-0${month}-05`,
      scheduledStart: "10:00",
      scheduledEnd: "11:00",
      notes: `LogoMail-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    });
    expect(apptRes.status, `appt ${month}: ${JSON.stringify(apptRes.data)}`).toBe(201);
    cleanupApptIds.push(apptRes.data.id);
    const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Repro" }],
    });
    expect(docRes.status, `document ${month}: ${JSON.stringify(docRes.data)}`).toBe(200);

    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month,
    });
    expect(srRes.status, `SR create ${month}: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}) ${month}: ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId, billingMonth: month, billingYear: YEAR,
    });
    expect(genRes.status, `generate ${month}: ${JSON.stringify(genRes.data)}`).toBe(200);
    const invData = Array.isArray(genRes.data) ? genRes.data[0]
      : genRes.data?.invoices ? genRes.data.invoices[0]
      : genRes.data;
    const invoiceId: number = invData.id;
    expect(invoiceId, `Rechnung ${month} muss eine id haben`).toBeTruthy();
    cleanupInvoiceIds.push(invoiceId);
    return { invoiceId, invoiceNumber: invData.invoiceNumber };
  }

  it("Einzel-Versand: Logo als Inline-cid-Anhang an Kasse UND Kunden-Kopie", async () => {
    const { invoiceId } = await generateSignedInvoice(SINGLE_MONTH);

    await clearTestOutbox();
    const sendRes = await apiPost<any>(`/api/billing/${invoiceId}/send`, {});
    expect(sendRes.status, `send: ${JSON.stringify(sendRes.data)}`).toBe(200);

    const outbox = await getTestOutbox();
    const kasseMail = outbox.find((m) => m.to === kasseEmail);
    const kundenMail = outbox.find((m) => m.to === customerEmail);
    expect(kasseMail, "Kassen-Mail muss im Postausgang liegen").toBeTruthy();
    expect(kundenMail, "Kunden-Kopie muss im Postausgang liegen").toBeTruthy();

    expectInlineLogo(kasseMail!, "Einzel-Versand Kassen-Mail");
    expectInlineLogo(kundenMail!, "Einzel-Versand Kunden-Kopie");
  }, 240_000);

  it("Stapel-Versand (send-batch): Logo als Inline-cid-Anhang an Kasse UND Kunden-Kopie", async () => {
    const { invoiceId } = await generateSignedInvoice(BATCH_MONTH);

    await clearTestOutbox();
    const sendRes = await apiPost<any>(`/api/billing/send-batch`, { invoiceIds: [invoiceId] });
    expect(sendRes.status, `send-batch: ${JSON.stringify(sendRes.data)}`).toBe(200);

    const outbox = await getTestOutbox();
    const kasseMail = outbox.find((m) => m.to === kasseEmail);
    const kundenMail = outbox.find((m) => m.to === customerEmail);
    expect(kasseMail, "Kassen-Mail muss im Postausgang liegen").toBeTruthy();
    expect(kundenMail, "Kunden-Kopie muss im Postausgang liegen").toBeTruthy();

    expectInlineLogo(kasseMail!, "Stapel-Versand Kassen-Mail");
    expectInlineLogo(kundenMail!, "Stapel-Versand Kunden-Kopie");
  }, 240_000);

  it("Fallback ohne Logo: kein Anhang, kein kaputtes Bild", async () => {
    // Logo entfernen → buildLogoInlineAttachment liefert null, buildEmailLayout
    // rendert kein <img>. Cache wird durch das PATCH invalidiert.
    const clearLogo = await apiPatch(`/api/company-settings`, { logoUrl: null });
    expect(clearLogo.status, `clear logo: ${JSON.stringify(clearLogo.data)}`).toBe(200);

    const { invoiceId } = await generateSignedInvoice(NOLOGO_MONTH);

    await clearTestOutbox();
    const sendRes = await apiPost<any>(`/api/billing/${invoiceId}/send`, {});
    expect(sendRes.status, `send: ${JSON.stringify(sendRes.data)}`).toBe(200);

    const outbox = await getTestOutbox();
    const kasseMail = outbox.find((m) => m.to === kasseEmail);
    const kundenMail = outbox.find((m) => m.to === customerEmail);
    expect(kasseMail, "Kassen-Mail muss im Postausgang liegen").toBeTruthy();
    expect(kundenMail, "Kunden-Kopie muss im Postausgang liegen").toBeTruthy();

    for (const [msg, label] of [
      [kasseMail!, "Fallback Kassen-Mail"],
      [kundenMail!, "Fallback Kunden-Kopie"],
    ] as const) {
      expect(logoAttachmentOf(msg), `${label}: KEIN Logo-Anhang ohne konfiguriertes Logo`).toBeUndefined();
      expect(msg.html, `${label}: HTML referenziert KEIN cid:-Logo`).not.toContain(`cid:${LOGO_CID}`);
      expect(msg.html, `${label}: HTML enthält KEINE data:-URI`).not.toContain("data:image");
    }
  }, 240_000);
});
