import { test, expect, type APIResponse } from "@playwright/test";
import {
  applyAuthToBrowser,
  apiPost,
  getAdminCreds,
  loginApiSession,
  type ApiSession,
} from "../helpers/auth";
import { createEmployee } from "../helpers/test-data";

// Task #1725: Runtime-Smoke für die MITARBEITER-Dokument-Download-Buttons.
//
// Task #1723 hat denselben Smoke für KUNDEN-Dokumente eingeführt
// (`e2e/smoke/document-download.spec.ts`). Die Mitarbeiter-Seite nutzt exakt
// dasselbe `href={file.objectPath}`- bzw. Generiertes-Dokument-Download-Muster
// und ist genauso anfällig für das Dead-URL-Problem, das der statische Guard
// (Task #1722, `tests/architecture/no-dead-object-download-url.test.ts`) NICHT
// auflösen kann (dynamische `href`-Werte).
//
// Dieser Test rendert die echten Buttons, liest deren `href` aus dem DOM und
// ruft die URL zur Laufzeit über die authentifizierte Session ab — es wird also
// exakt das gemacht, was ein Klick auf den Anchor tun würde (GET). Geprüft wird:
//  1. Hochgeladenes Objekt (`/objects/...` via `file.objectPath`)
//  2. Generiertes Dokument (`/api/admin/generated-documents/:id/download`)
// Erwartung je Download: HTTP 200, nicht-leerer Body, sinnvoller Content-Type +
// Content-Disposition.

const creds = getAdminCreds();
test.skip(!creds, "TEST_USER_EMAIL/TEST_USER_PASSWORD nicht gesetzt — Smoke-Suite übersprungen.");

// Sowohl der Upload-Flow (Presigned-URL + PUT) als auch das generierte PDF liegen
// im Object Storage. Lokal/Replit ist der Sidecar vorhanden
// (`PRIVATE_OBJECT_DIR`/`PUBLIC_OBJECT_SEARCH_PATHS` gesetzt); in der GitHub-Actions-CI
// existiert er NICHT. Ohne Bucket lässt sich kein Download verifizieren — deshalb
// hier dasselbe Skip-Kriterium wie in den übrigen PDF-Smokes.
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

async function createEmployeeDocumentType(s: ApiSession): Promise<number> {
  const { status, data } = await apiPost<{ id?: number }>(
    s,
    "/api/admin/document-types",
    {
      name: `E2E-MA-Download-Typ ${Date.now()}`,
      targetType: "employee",
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

// Öffnet den Bearbeiten-Dialog eines Mitarbeiters, in dem die Dokumente-Sektion
// (und damit die Download-Buttons) gerendert werden.
async function openEmployeeEditDialog(
  page: import("@playwright/test").Page,
  employeeId: number,
): Promise<void> {
  await page.goto("/admin/users");
  await page.getByTestId(`button-actions-${employeeId}`).click();
  await page.getByTestId(`button-edit-user-${employeeId}`).click();
}

test.describe("@smoke Mitarbeiter-Dokument-Download-Buttons liefern zur Laufzeit eine Datei", () => {
  test("Hochgeladenes Mitarbeiterdokument: `href={file.objectPath}` streamt eine Datei", async ({ page }) => {
    const employee = await createEmployee(session);
    const docTypeId = await createEmployeeDocumentType(session);
    const objectPath = await uploadObjectBytes(session, "ma-upload-smoke.pdf");

    const { status, data } = await apiPost<{ id?: number }>(
      session,
      `/api/admin/employees/${employee.id}/documents`,
      {
        documentTypeId: docTypeId,
        fileName: "ma-upload-smoke.pdf",
        objectPath,
      },
    );
    if (status !== 201 || typeof data?.id !== "number") {
      throw new Error(`save employee document failed: ${status} ${JSON.stringify(data)}`);
    }
    const docId = data.id;

    // UI rendern und den echten Download-Anchor aufklappen.
    await openEmployeeEditDialog(page, employee.id);
    await page.getByTestId(`button-toggle-doctype-${docTypeId}`).click();

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
    expect(res.headers()["content-disposition"]).toContain("ma-upload-smoke.pdf");
  });

  test("Generiertes Mitarbeiterdokument: `/api/admin/generated-documents/:id/download` streamt eine Datei", async ({ page }) => {
    const employee = await createEmployee(session);
    const docTypeId = await createEmployeeDocumentType(session);

    // Vorlage anlegen (ohne Unterschrifts-Pflicht → sofort `complete`).
    const tpl = await apiPost<{ id?: number }>(
      session,
      "/api/admin/document-templates",
      {
        slug: `e2e-ma-download-${Date.now()}`,
        name: "E2E MA Download Vorlage",
        htmlContent: "<p>Testdokument für den Mitarbeiter-Download-Smoke.</p>",
        documentTypeId: docTypeId,
        targetType: "employee",
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
      "/api/admin/documents/generate-pdf",
      { templateId: tpl.data.id, employeeId: employee.id },
    );
    if (gen.status !== 201 || typeof gen.data?.id !== "number") {
      throw new Error(`generate-pdf failed: ${gen.status} ${JSON.stringify(gen.data)}`);
    }
    const generatedId = gen.data.id;

    // UI rendern — generierte Dokumente werden ohne Aufklappen direkt gelistet.
    await openEmployeeEditDialog(page, employee.id);

    const downloadLink = page.getByTestId(`button-download-generated-doc-${generatedId}`);
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute("href");
    expect(href).toBe(`/api/admin/generated-documents/${generatedId}/download`);

    const res = await session.api.get(href!);
    await expectOk(res, "GET generated document");
    const body = await res.body();
    expect(body.length).toBeGreaterThan(0);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    expect(res.headers()["content-disposition"]).toBeTruthy();
  });

  // Task #1727: Auch die ARCHIVIERTEN (historischen) Uploads im "X ältere Uploads"-
  // Expander rendern Download-Anchors mit demselben dynamischen
  // `href={file.objectPath}`-Muster, das der statische Guard (Task #1722) NICHT
  // auflösen kann. Sie hatten bisher weder eine stabile test-id noch Laufzeit-
  // Coverage — eine Dead-URL-Regression in der Archiv-Ansicht bliebe unbemerkt.
  //
  // Ablauf: eine erste Version hochladen, dann eine ZWEITE Version desselben
  // Dokumenttyps hochladen (ohne skipDeactivation → die erste wird archiviert).
  // Danach den Archiv-Expander aufklappen, den `href` des archivierten Anchors
  // lesen und die URL über die authentifizierte Session abrufen.
  test("Archiviertes Mitarbeiterdokument: `href={file.objectPath}` im 'ältere Uploads'-Expander streamt eine Datei", async ({ page }) => {
    const employee = await createEmployee(session);
    const docTypeId = await createEmployeeDocumentType(session);

    // Erste Version hochladen (wird später zur archivierten Version).
    const archivedObjectPath = await uploadObjectBytes(session, "ma-archiv-v1.pdf");
    const v1 = await apiPost<{ id?: number }>(
      session,
      `/api/admin/employees/${employee.id}/documents`,
      { documentTypeId: docTypeId, fileName: "ma-archiv-v1.pdf", objectPath: archivedObjectPath },
    );
    if (v1.status !== 201 || typeof v1.data?.id !== "number") {
      throw new Error(`save employee document v1 failed: ${v1.status} ${JSON.stringify(v1.data)}`);
    }
    const archivedDocId = v1.data.id;

    // Zweite Version desselben Typs hochladen → erste Version wird archiviert.
    const currentObjectPath = await uploadObjectBytes(session, "ma-archiv-v2.pdf");
    const v2 = await apiPost<{ id?: number }>(
      session,
      `/api/admin/employees/${employee.id}/documents`,
      { documentTypeId: docTypeId, fileName: "ma-archiv-v2.pdf", objectPath: currentObjectPath },
    );
    if (v2.status !== 201 || typeof v2.data?.id !== "number") {
      throw new Error(`save employee document v2 failed: ${v2.status} ${JSON.stringify(v2.data)}`);
    }

    // UI rendern und den Archiv-Expander ("X ältere Uploads") aufklappen.
    await openEmployeeEditDialog(page, employee.id);
    await page.getByTestId(`button-toggle-doctype-${docTypeId}`).click();
    await page.getByTestId(`button-archive-${docTypeId}`).click();

    const downloadLink = page.getByTestId(`button-download-archived-doc-${archivedDocId}`);
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute("href");
    expect(href).toBe(archivedObjectPath);

    // Das Anklicken des archivierten Anchors entspricht einem GET auf die href-URL.
    const res = await session.api.get(href!);
    await expectOk(res, "GET archived employee object");
    const body = await res.body();
    expect(body.length).toBeGreaterThan(0);
    expect(res.headers()["content-type"]).toBeTruthy();
    expect(res.headers()["content-disposition"]).toContain("ma-archiv-v1.pdf");
  });
});
