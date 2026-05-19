/**
 * Task #521 — LN-PDF-Caching analog zum Rechnungs-PDF-Cache.
 *
 * Erwartet nach POST /api/billing/generate für eine pflegekasse_privat-Rechnung:
 *   - invoices.pdf_path                != NULL
 *   - invoices.leistungsnachweis_path  != NULL
 *   - invoices.leistungsnachweis_hash  hat 64 sha256-hex Zeichen
 *
 * Außerdem deckt diese Suite ab:
 *   - LNC.2 Cache-Hit: Wiederholter LN-Abruf liefert byte-genau identische
 *     Bytes (kein erneutes Puppeteer-Rendering).
 *   - LNC.3 GoBD-Immutabilität: persistInvoicePdf() überschreibt einen
 *     bereits gespeicherten Rechnungs-PDF-Hash NIE — selbst dann nicht, wenn
 *     nur der LN-Cache fehlt.
 *   - LNC.4 Backfill-Smoke: backfillInvoicePdfs() füllt für eine Rechnung
 *     mit NULL `pdf_path` beide Caches auf.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { invoices as invoicesTable } from "../../shared/schema";
import {
  apiPost,
  apiDelete,
  getAuthCookie,
} from "../test-utils";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

function weekdayInCurrentMonth(): string {
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  for (let offset = 1; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  for (let offset = 1; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}

let scenario: BudgetScenarioHandle;
let authCookie: string;
let invoiceId: number;
const cleanupSrIds: number[] = [];
const cleanupInvoiceIds: number[] = [];

beforeAll(async () => {
  const auth = await getAuthCookie();
  authCookie = auth.cookie;
  const apptDate = weekdayInCurrentMonth();
  scenario = await setupBudgetScenario({
    customerNamePrefix: "LNC",
    pflegegrad: 3,
    billingType: "pflegekasse_privat",
    acceptsPrivatePayment: true,
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

  // LN signieren und Rechnung generieren — einmalig, sodass alle weiteren
  // Tests auf der gleichen Rechnung arbeiten können.
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const sr = await apiPost<any>("/api/service-records", {
    customerId: scenario.customerId,
    employeeId: scenario.employeeId,
    year,
    month,
  });
  if (sr.status !== 201) throw new Error(`SR create failed: ${JSON.stringify(sr.data)}`);
  cleanupSrIds.push(sr.data.id);
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost<any>(`/api/service-records/${sr.data.id}/sign`, {
      signerType,
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    if (sig.status !== 200) throw new Error(`sign(${signerType}) failed: ${JSON.stringify(sig.data)}`);
  }
  const gen = await apiPost<any>("/api/billing/generate", {
    customerId: scenario.customerId,
    billingMonth: month,
    billingYear: year,
  });
  if (gen.status !== 200) throw new Error(`generate failed: ${JSON.stringify(gen.data)}`);
  const invs: any[] = gen.data?.splitInvoices ? gen.data.invoices
    : Array.isArray(gen.data) ? gen.data
    : [gen.data];
  const kasse = invs.find((i: any) => i.billingType === "pflegekasse_privat") || invs[0];
  if (!kasse?.id) throw new Error(`Pflegekassen-Rechnung fehlt: ${JSON.stringify(invs)}`);
  invoiceId = kasse.id;
  cleanupInvoiceIds.push(...invs.map((i: any) => i.id));
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    try { await apiDelete(`/api/billing/${id}`); } catch {}
  }
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  await scenario.cleanup();
});

describe("LN-PDF-Caching — invoices.leistungsnachweis_path/hash werden bei Generierung befüllt", () => {
  it("LNC.1 — pflegekasse_privat: pdfPath + leistungsnachweisPath gesetzt", async () => {
    const [row] = await db
      .select({
        pdfPath: invoicesTable.pdfPath,
        pdfHash: invoicesTable.pdfHash,
        leistungsnachweisPath: invoicesTable.leistungsnachweisPath,
        leistungsnachweisHash: invoicesTable.leistungsnachweisHash,
        billingType: invoicesTable.billingType,
      })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);

    expect(row?.billingType).toBe("pflegekasse_privat");
    expect(row?.pdfPath, "invoices.pdf_path muss nach /generate gesetzt sein").not.toBeNull();
    expect(row?.leistungsnachweisPath, "invoices.leistungsnachweis_path muss nach /generate gesetzt sein").not.toBeNull();
    expect(row?.leistungsnachweisHash).not.toBeNull();
    expect((row?.leistungsnachweisHash || "").length).toBe(64);
  });

  it("LNC.2 — Cache-Hit: wiederholter LN-Abruf liefert byte-genau identische Bytes (kein Re-Render)", async () => {
    const lnRes1 = await fetch(`${BASE_URL}/api/billing/${invoiceId}/leistungsnachweis`, {
      headers: { Cookie: authCookie },
    });
    expect(lnRes1.status).toBe(200);
    const buf1 = Buffer.from(await lnRes1.arrayBuffer());
    expect(buf1.byteLength).toBeGreaterThan(1024);

    const lnRes2 = await fetch(`${BASE_URL}/api/billing/${invoiceId}/leistungsnachweis`, {
      headers: { Cookie: authCookie },
    });
    expect(lnRes2.status).toBe(200);
    const buf2 = Buffer.from(await lnRes2.arrayBuffer());

    expect(
      buf1.equals(buf2),
      "Wiederholter LN-Abruf muss byte-identisch sein (Cache-Hit, kein Puppeteer-Re-Render)",
    ).toBe(true);
  });

  it("LNC.3 — GoBD-Immutabilität: persistInvoicePdf überschreibt vorhandenen pdf_hash NIE", async () => {
    const [before] = await db
      .select({
        pdfPath: invoicesTable.pdfPath,
        pdfHash: invoicesTable.pdfHash,
        leistungsnachweisHash: invoicesTable.leistungsnachweisHash,
      })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);
    expect(before?.pdfHash).not.toBeNull();

    // LN-Cache künstlich leeren — der Rechnungs-PDF-Hash bleibt bestehen.
    await db.update(invoicesTable)
      .set({ leistungsnachweisPath: null, leistungsnachweisHash: null })
      .where(eq(invoicesTable.id, invoiceId));

    const { persistInvoicePdf } = await import("../../server/routes/billing");
    await persistInvoicePdf(invoiceId);

    const [after] = await db
      .select({
        pdfPath: invoicesTable.pdfPath,
        pdfHash: invoicesTable.pdfHash,
        leistungsnachweisPath: invoicesTable.leistungsnachweisPath,
        leistungsnachweisHash: invoicesTable.leistungsnachweisHash,
      })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);

    expect(after?.pdfPath).toBe(before?.pdfPath);
    expect(
      after?.pdfHash,
      "GoBD-Bug: persistInvoicePdf hat den vorhandenen Rechnungs-PDF-Hash überschrieben",
    ).toBe(before?.pdfHash);
    expect(after?.leistungsnachweisPath).not.toBeNull();
    expect(after?.leistungsnachweisHash).not.toBeNull();
    expect((after?.leistungsnachweisHash || "").length).toBe(64);
  });

  it("LNC.4 — Backfill-Smoke: persistInvoicePdf füllt vollständig fehlenden pdfPath + LN auf (Legacy-Pfad)", async () => {
    // Rechnung künstlich auf "Legacy" zurücksetzen (pdfPath + LN NULL), um den
    // Backfill-Codepfad zu testen. `backfillInvoicePdfs()` selbst ruft pro
    // Rechnung `persistInvoicePdf(id)` auf — wir testen hier dieselbe
    // Single-Row-Logik gezielt für unsere Test-Rechnung, ohne die globale
    // Queue der Test-DB anzustoßen (die andere Legacy-Rechnungen mit
    // Browser-Hängern triggern könnte).
    await db.update(invoicesTable)
      .set({ pdfPath: null, pdfHash: null, leistungsnachweisPath: null, leistungsnachweisHash: null })
      .where(eq(invoicesTable.id, invoiceId));

    const { persistInvoicePdf } = await import("../../server/routes/billing");
    await persistInvoicePdf(invoiceId);

    const [after] = await db
      .select({
        pdfPath: invoicesTable.pdfPath,
        pdfHash: invoicesTable.pdfHash,
        leistungsnachweisPath: invoicesTable.leistungsnachweisPath,
        leistungsnachweisHash: invoicesTable.leistungsnachweisHash,
      })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);

    expect(after?.pdfPath, "Backfill hat pdfPath nicht gefüllt").not.toBeNull();
    expect(after?.pdfHash, "Backfill hat pdfHash nicht gefüllt").not.toBeNull();
    expect((after?.pdfHash || "").length).toBe(64);
    expect(after?.leistungsnachweisPath, "Backfill hat leistungsnachweisPath nicht gefüllt").not.toBeNull();
    expect(after?.leistungsnachweisHash, "Backfill hat leistungsnachweisHash nicht gefüllt").not.toBeNull();
    expect((after?.leistungsnachweisHash || "").length).toBe(64);
  }, 60_000);
});
