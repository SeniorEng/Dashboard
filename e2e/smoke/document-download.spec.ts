import { test, expect, type APIResponse } from "@playwright/test";
import {
  applyAuthToBrowser,
  apiPost,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import { createCustomer } from "../helpers/test-data";

// Task #1723: Runtime-Smoke für ALLE Dokument-Download-Buttons.
//
// Der statische Guard (Task #1722, `tests/architecture/no-dead-object-download-url.test.ts`)
// kann dynamische `href={doc.objectPath}`-Werte nicht auflösen. Dieser Test rendert
// die echten Buttons, liest deren `href` aus dem DOM und ruft die URL zur Laufzeit
// über die authentifizierte Session ab — es wird also exakt das gemacht, was ein
// Klick auf den Anchor tun würde (GET). Geprüft werden:
//  1. Hochgeladenes Objekt (`/objects/...` via `doc.objectPath`)
//  2. Generiertes Dokument (`/api/customers/generated-documents/:id/download`)
// Erwartung je Download: HTTP 200, nicht-leerer Body, sinnvoller Content-Type +
// Content-Disposition.

const creds = getAdminCreds();
test.skip(!creds, "TEST_USER_EMAIL/TEST_USER_PASSWORD nicht gesetzt — Smoke-Suite übersprungen.");

// Sowohl der Upload-Flow (Presigned-URL + PUT) als auch das generierte PDF liegen
// im Object Storage. Lokal/Replit ist der Sidecar vorhanden
// (`PRIVATE_OBJECT_DIR`/`PUBLIC_OBJECT_SEARCH_PATHS` gesetzt); in der GitHub-Actions-CI
// existiert er NICHT (Vitest skippt PDF-Tests über `tests/helpers/object-storage.ts`,
// Playwright kennt diesen Helper aber nicht). Ohne Bucket lässt sich kein Download
// verifizieren — deshalb hier dasselbe Skip-Kriterium wie in den übrigen PDF-Smokes.
const hasObjectStorage =
  !!process.env.PRIVATE_OBJECT_DIR && !!process.env.PUBLIC_OBJECT_SEARCH_PATHS;
test.skip(
  !hasObjectStorage,
  "Object Storage (PRIVATE_OBJECT_DIR/PUBLIC_OBJECT_SEARCH_PATHS) nicht verfügbar — Download-Smoke übersprungen (kein Sidecar in CI).",
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

// Minimaler, gültiger PDF-Byte-Stream für den Upload-Pfad. Inhalt egal — es geht
// nur darum, dass der `/objects/*`-Stream tatsächlich Bytes zurückliefert.
const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf-8",
);

async function expectOk(res: APIResponse, label: string): Promise<void> {
  if (!res.ok()) {
    throw new Error(`${label} failed: ${res.status()} ${await res.text()}`);
  }
}

async function createCustomerDocumentType(s: ApiSession): Promise<number> {
  const { status, data } = await apiPost<{ id?: number }>(
    s,
    "/api/admin/document-types",
    {
      name: `E2E-Download-Typ ${Date.now()}`,
      targetType: "customer",
      context: "beide",
      inputMethod: "upload",
    },
  );
  if (status !== 201 || typeof data?.id !== "number") {
    throw new Error(`createDocumentType failed: ${status} ${JSON.stringify(data)}`);
  }
  return data.id;
}

// Lädt echte Bytes über den Produktiv-Flow (Presigned-URL → PUT) hoch und liefert
// den normalisierten `/objects/...`-Objektpfad zurück.
async function uploadObjectBytes(
  s: ApiSession,
  fileName: string,
): Promise<string> {
  const { status, data } = await apiPost<{ uploadURL?: string; objectPath?: string }>(
    s,
    "/api/uploads/request-url",
    { name: fileName, size: MINIMAL_PDF.length, contentType: "application/pdf" },
  );
  if (status !== 200 || !data?.uploadURL || !data?.objectPath) {
    throw new Error(`request-url failed: ${status} ${JSON.stringify(data)}`);
  }
  const put = await s.api.fetch(data.uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    data: MINIMAL_PDF,
  });
  await expectOk(put, "PUT presigned upload");
  return data.objectPath;
}

test.describe("@smoke Dokument-Download-Buttons liefern zur Laufzeit eine Datei", () => {
  test("Hochgeladenes Kundendokument: `href={doc.objectPath}` streamt eine Datei", async ({ page }) => {
    const customer = await createCustomer(session);
    const docTypeId = await createCustomerDocumentType(session);
    const objectPath = await uploadObjectBytes(session, "upload-smoke.pdf");

    const { status, data } = await apiPost<{ id?: number }>(
      session,
      `/api/customers/${customer.id}/documents`,
      {
        documentTypeId: docTypeId,
        fileName: "upload-smoke.pdf",
        objectPath,
      },
    );
    if (status !== 201 || typeof data?.id !== "number") {
      throw new Error(`save customer document failed: ${status} ${JSON.stringify(data)}`);
    }
    const docId = data.id;

    // UI rendern und den echten Download-Anchor aufklappen.
    await page.goto(`/customer/${customer.id}`);
    await page.getByTestId(`doc-group-toggle-${docTypeId}`).click();

    const downloadLink = page.getByTestId(`button-download-doc-${docId}`);
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute("href");
    expect(href).toBe(objectPath);

    // Das Anklicken des Anchors entspricht einem GET auf die href-URL.
    const res = await session.api.get(href!);
    await expectOk(res, "GET uploaded object");
    const body = await res.body();
    expect(body.length).toBeGreaterThan(0);
    expect(res.headers()["content-type"]).toBeTruthy();
    expect(res.headers()["content-disposition"]).toContain("upload-smoke.pdf");
  });

  test("Generiertes Kundendokument: `/api/customers/generated-documents/:id/download` streamt eine Datei", async ({ page }) => {
    const customer = await createCustomer(session);
    const docTypeId = await createCustomerDocumentType(session);

    // Vorlage anlegen (ohne Unterschrifts-Pflicht → sofort `complete`).
    const tpl = await apiPost<{ id?: number }>(
      session,
      "/api/admin/document-templates",
      {
        slug: `e2e-download-${Date.now()}`,
        name: "E2E Download Vorlage",
        htmlContent: "<p>Testdokument für den Download-Smoke.</p>",
        documentTypeId: docTypeId,
        targetType: "customer",
        context: "beide",
        requiresCustomerSignature: false,
        requiresEmployeeSignature: false,
      },
    );
    if (tpl.status !== 201 || typeof tpl.data?.id !== "number") {
      throw new Error(`create template failed: ${tpl.status} ${JSON.stringify(tpl.data)}`);
    }

    // PDF serverseitig generieren + persistieren.
    const gen = await apiPost<{ id?: number }>(
      session,
      `/api/customers/${customer.id}/documents/generate-pdf`,
      { templateId: tpl.data.id },
    );
    if (gen.status !== 201 || typeof gen.data?.id !== "number") {
      throw new Error(`generate-pdf failed: ${gen.status} ${JSON.stringify(gen.data)}`);
    }
    const generatedId = gen.data.id;

    // UI rendern und den echten Download-Anchor des generierten Dokuments aufklappen.
    await page.goto(`/customer/${customer.id}`);
    await page.getByTestId(`doc-group-toggle-${docTypeId}`).click();

    const downloadLink = page.getByTestId(`button-download-generated-${generatedId}`);
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute("href");
    expect(href).toBe(`/api/customers/generated-documents/${generatedId}/download`);

    const res = await session.api.get(href!);
    await expectOk(res, "GET generated document");
    const body = await res.body();
    expect(body.length).toBeGreaterThan(0);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    expect(res.headers()["content-disposition"]).toBeTruthy();
  });
});
