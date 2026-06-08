/**
 * Task #1052 — End-to-End-Reproduzierbarkeit des versiegelten PDF-Hashes.
 *
 * Kontext
 * -------
 * Die Unit-Suite `tests/unit/pdf-determinism.test.ts` deckt die
 * Metadaten-Normalisierung (`normalizePdfDeterminism`) isoliert ab. Hier wird
 * der GESAMTE Render-Pfad über ECHTES Chromium + node-zugferd geprüft:
 *
 *   1. Eine Rechnung wird angelegt und über `persistInvoicePdf` versiegelt
 *      (friert `pdfCreationDate` im `render_snapshot` ein und schreibt
 *      `pdf_hash` / `leistungsnachweis_hash`).
 *   2. Aus dem versiegelten Snapshot wird via
 *      `buildInvoicePdfBytes(invoice, companySettings, { snapshot })` neu
 *      gerendert.
 *   3. `computeDataHash` des Re-Renders MUSS byte-genau dem versiegelten
 *      `pdf_hash` (bzw. `leistungsnachweis_hash`) entsprechen.
 *
 * Abgedeckte Artefakte:
 *   - Invoice-PDF (Standalone-ZUGFeRD, gesetzliche Pflegekasse).
 *   - Standalone-Leistungsnachweis (beide Szenarien).
 *   - Beihilfe-Merge (kundenadressierte Rechnung+LN+Rechnung+LN als ein PDF).
 *
 * Damit ist die Byte-Reproduzierbarkeit dauerhaft gegen Regressionen
 * abgesichert (z.B. Chromium-Updates, node-zugferd-Bumps).
 *
 * Hinweis zur Isolation: Das Object-Storage ist NICHT pro Test-DB isoliert
 * (nur die DB ist es). Dieser Test liest jedoch NIE das gespeicherte Objekt
 * zurück — er vergleicht den IN-MEMORY-Re-Render-Hash mit dem in der
 * (isolierten) DB versiegelten Hash. Zusätzlich werden eindeutige
 * Rechnungsnummern verwendet, sodass kein Bucket-Clobbering auftritt.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { invoices as invoicesTable, users, type InvoiceRenderSnapshot } from "@shared/schema";
import { storage } from "../../server/storage";
import {
  buildInvoicePdfBytes,
  persistInvoicePdf,
} from "../../server/services/invoice-pdf-orchestrator";
import { getCachedCompanySettings } from "../../server/services/cache";
import { computeDataHash } from "../../server/services/signature-integrity";
import { createInvoiceTx } from "../../server/storage/billing-storage";
import { apiPost, cleanupCustomer, getAuthCookie, runCleanup, uniqueId } from "../test-utils";

const YEAR = 2026;
const MONTH = 4;
const APPT_DATE = `${YEAR}-0${MONTH}-15`;

// Eindeutige, sanitisierbare Rechnungsnummer (kein Bucket-Clobbering, kein
// Konflikt mit der laufenden RE-YYYY-NNNN-Sequenz; das numerische Format wird
// nicht erzwungen, nur die Unique-Constraint auf `invoice_number`).
function uniqueInvoiceNumber(): string {
  return `RE-${YEAR}-T1052-${uniqueId()}`.replace(/[^a-z0-9_-]/gi, "_");
}

describe("Task #1052 — Re-Render reproduziert den versiegelten PDF-Hash byte-genau", () => {
  let superadminId: number;
  // Szenario A: gesetzliche Pflegekasse (Standalone-Invoice + Standalone-LN).
  let gesetzlichCustomerId: number;
  let gesetzlichInvoiceId: number;
  // Szenario B: Beihilfe-Kundenrechnung (Merge: Rechnung+LN doppelt).
  let beihilfeCustomerId: number;
  let beihilfeInvoiceId: number;
  const createdInvoiceIds: number[] = [];

  async function seedInvoice(
    customerId: number,
    billingType: "pflegekasse_gesetzlich" | "pflegekasse_privat",
  ): Promise<number> {
    const inv = await db.transaction(async (tx) =>
      createInvoiceTx(
        tx,
        {
          invoiceNumber: uniqueInvoiceNumber(),
          customerId,
          billingType,
          invoiceType: "rechnung",
          billingMonth: MONTH,
          billingYear: YEAR,
          recipientName: billingType === "pflegekasse_gesetzlich" ? "Pflegekasse Test" : "Kunde Test",
          recipientAddress: "Empfängerweg 1, 01067 Dresden",
          customerName: "Re-Render Hash",
          pflegegrad: 3,
          netAmountCents: 5000,
          vatAmountCents: 0,
          grossAmountCents: 5000,
          vatRate: 0,
          status: "entwurf",
          budgetType: "entlastungsbetrag_45b",
        },
        [
          {
            appointmentId: null,
            appointmentDate: APPT_DATE,
            serviceDescription: "Alltagsbegleitung",
            serviceCode: "alltagsbegleitung",
            durationMinutes: 30,
            unitPriceCents: 5000,
            totalCents: 5000,
            employeeName: "Erik",
          },
        ],
        superadminId,
      ),
    );
    createdInvoiceIds.push(inv.id);
    return inv.id;
  }

  beforeAll(async () => {
    const auth = await getAuthCookie();
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isSuperAdmin, true))
      .limit(1);
    superadminId = admin?.id ?? auth.user.id;

    // Szenario A — gesetzliche Pflegekasse, keine Beihilfe, nicht an Kunde.
    const custA = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Rerender",
      nachname: `Gesetzlich-${uniqueId()}`,
      geburtsdatum: "1940-05-05",
      email: `rerender-g-${uniqueId()}@test.local`,
      strasse: "Kassenweg",
      nr: "1",
      plz: "01067",
      stadt: "Dresden",
      telefon: "+4917600000010",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      beihilfeBerechtigt: false,
    });
    expect(custA.status, `create customer A: ${JSON.stringify(custA.data)}`).toBe(201);
    gesetzlichCustomerId = custA.data.id;
    gesetzlichInvoiceId = await seedInvoice(gesetzlichCustomerId, "pflegekasse_gesetzlich");

    // Szenario B — Beihilfe-Kundenrechnung (pflegekasse_privat + Beihilfe).
    const custB = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Rerender",
      nachname: `Beihilfe-${uniqueId()}`,
      geburtsdatum: "1940-03-03",
      email: `rerender-b-${uniqueId()}@test.local`,
      strasse: "Beihilfeweg",
      nr: "3",
      plz: "10115",
      stadt: "Berlin",
      telefon: "+4917600000011",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_privat",
      acceptsPrivatePayment: true,
      beihilfeBerechtigt: true,
    });
    expect(custB.status, `create customer B: ${JSON.stringify(custB.data)}`).toBe(201);
    beihilfeCustomerId = custB.data.id;
    beihilfeInvoiceId = await seedInvoice(beihilfeCustomerId, "pflegekasse_privat");

    // Versiegeln: erzeugt + speichert PDFs, friert pdfCreationDate im Snapshot
    // ein und schreibt pdf_hash / leistungsnachweis_hash.
    await persistInvoicePdf(gesetzlichInvoiceId);
    await persistInvoicePdf(beihilfeInvoiceId);
  }, 180_000);

  afterAll(async () => {
    for (const id of createdInvoiceIds) {
      try {
        await db.delete(invoicesTable).where(eq(invoicesTable.id, id));
      } catch {
        /* best-effort */
      }
    }
    await cleanupCustomer(gesetzlichCustomerId);
    await cleanupCustomer(beihilfeCustomerId);
    await runCleanup();
  });

  it("gesetzliche Kasse: Invoice-PDF + Standalone-LN reproduzieren den versiegelten Hash byte-genau", async () => {
    const invoice = await storage.getInvoice(gesetzlichInvoiceId);
    expect(invoice, "Rechnung muss existieren").toBeTruthy();
    expect(invoice!.pdfHash, "pdf_hash muss versiegelt sein").toBeTruthy();
    expect(invoice!.leistungsnachweisHash, "leistungsnachweis_hash muss versiegelt sein").toBeTruthy();
    expect(invoice!.renderSnapshot, "render_snapshot muss versiegelt sein").toBeTruthy();

    const companySettings = await getCachedCompanySettings();
    expect(companySettings, "company_settings muss geseedet sein").toBeTruthy();

    const snapshot = invoice!.renderSnapshot as InvoiceRenderSnapshot;
    expect(snapshot.pdfCreationDate, "pdfCreationDate muss eingefroren sein").toBeTruthy();

    const rerender = await buildInvoicePdfBytes(invoice!, companySettings, { snapshot });

    // (1) Invoice-PDF (Standalone-ZUGFeRD) byte-genau.
    expect(computeDataHash(rerender.pdf as unknown as string)).toBe(invoice!.pdfHash);
    // (2) Standalone-Leistungsnachweis byte-genau.
    expect(rerender.leistungsnachweisPdf, "LN-PDF muss erzeugt werden").toBeTruthy();
    expect(computeDataHash(rerender.leistungsnachweisPdf as unknown as string)).toBe(
      invoice!.leistungsnachweisHash,
    );
  }, 180_000);

  it("Beihilfe-Kundenrechnung: Merge-PDF + Standalone-LN reproduzieren den versiegelten Hash byte-genau", async () => {
    const invoice = await storage.getInvoice(beihilfeInvoiceId);
    expect(invoice, "Rechnung muss existieren").toBeTruthy();
    expect(invoice!.pdfHash, "pdf_hash muss versiegelt sein").toBeTruthy();
    expect(invoice!.leistungsnachweisHash, "leistungsnachweis_hash muss versiegelt sein").toBeTruthy();

    const companySettings = await getCachedCompanySettings();
    expect(companySettings, "company_settings muss geseedet sein").toBeTruthy();

    const snapshot = invoice!.renderSnapshot as InvoiceRenderSnapshot;
    expect(snapshot.pdfCreationDate, "pdfCreationDate muss eingefroren sein").toBeTruthy();
    expect(snapshot.customer.beihilfeBerechtigt, "Beihilfe muss im Snapshot versiegelt sein").toBe(true);

    const rerender = await buildInvoicePdfBytes(invoice!, companySettings, { snapshot });

    // (3) Beihilfe-Merge (Rechnung+LN+Rechnung+LN als ein PDF) byte-genau.
    expect(computeDataHash(rerender.pdf as unknown as string)).toBe(invoice!.pdfHash);
    // Standalone-LN ebenfalls byte-genau.
    expect(rerender.leistungsnachweisPdf, "LN-PDF muss erzeugt werden").toBeTruthy();
    expect(computeDataHash(rerender.leistungsnachweisPdf as unknown as string)).toBe(
      invoice!.leistungsnachweisHash,
    );
  }, 180_000);
});
