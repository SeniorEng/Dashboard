/**
 * Task #1084 — Bestandsrechnungen ohne `renderSnapshot.lineAggregation`
 * re-rendern byte-genau in der alten pro-Termin-Form.
 *
 * Kontext
 * -------
 * Mit Task #1083 werden NEUE Rechnungen mit kumulierten Positionen erzeugt
 * und der Modus pro Rechnung über `renderSnapshot.lineAggregation` eingefroren
 * (`"cumulative"`). Bereits versendete/versiegelte Bestandsrechnungen wurden
 * VOR der Kumulierung versiegelt — ihr Snapshot besitzt das Feld
 * `lineAggregation` NICHT. Aus GoBD-Gründen müssen diese Rechnungen byte-genau
 * unverändert bleiben: der Integritäts-Verifier re-rendert sie und vergleicht
 * ZUGFeRD-XML + pdf_hash. Fehlt das Feld, MUSS der Default `"per_appointment"`
 * gelten (eine Zeile je Termin, mit Datum-/Uhrzeit-Spalten).
 *
 * Dieser Test simuliert exakt diesen Altbestand: eine Rechnung mit ZWEI
 * Terminen desselben Service (gleicher Preis) wird versiegelt; aus dem
 * versiegelten Snapshot wird `lineAggregation` ENTFERNT (= Bestand vor #1083).
 * Das Re-Render aus diesem „legacy"-Snapshot wird verglichen mit:
 *
 *   1. einem expliziten `lineAggregation: "per_appointment"`-Re-Render
 *      → MUSS byte-genau identisch sein (XML + PDF-Hash). Damit ist bewiesen,
 *        dass der Default des fehlenden Feldes pro-Termin ist.
 *   2. dem versiegelten kumulierten Artefakt (pdf_hash / zugferd_xml)
 *      → MUSS sich unterscheiden. Damit ist der Test nicht trivial erfüllt:
 *        die beiden Modi erzeugen tatsächlich unterschiedliche Bytes.
 *
 * Zusätzlich wird der extrahierte PDF-Text geprüft: die pro-Termin-Form trägt
 * beide Termin-Daten (15.04.2026 / 16.04.2026) als eigene Zeilen, die
 * kumulierte Form fasst sie zu einer Zeile ohne Datum-Spalte zusammen.
 *
 * Würde der Default in `invoice-pdf-orchestrator.ts` still auf `"cumulative"`
 * kippen, schlüge dieser Test fehl (legacy-Re-Render driftet gegen den
 * versiegelten Bestands-Hash).
 *
 * Hinweis zur Isolation: Wie #1052 liest dieser Test NIE das gespeicherte
 * Objekt zurück — er vergleicht IN-MEMORY-Re-Render-Hashes mit dem in der
 * (isolierten) DB versiegelten Hash und nutzt eindeutige Rechnungsnummern.
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
const APPT_DATE_A = `${YEAR}-0${MONTH}-15`;
const APPT_DATE_B = `${YEAR}-0${MONTH}-16`;
// formatDate() im PDF-Template dreht ISO → de-DE.
const DATE_A_DE = "15.04.2026";
const DATE_B_DE = "16.04.2026";

function uniqueInvoiceNumber(): string {
  return `RE-${YEAR}-T1084-${uniqueId()}`.replace(/[^a-z0-9_-]/gi, "_");
}

// Leichtgewichtiger PDF-Text-Extraktor (devDependency `pdf-parse`, nur Tests).
// Bytes zuerst über pdf-lib auf eine klassische Xref-Tabelle normalisieren,
// damit das alte gebündelte pdf.js die Streams lesen kann.
type PdfParseFn = (data: Buffer) => Promise<{ text: string }>;
async function extractPdfText(buf: Buffer): Promise<string> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(buf);
  const normalized = Buffer.from(await doc.save({ useObjectStreams: false }));
  const ns = (await import("pdf-parse/lib/pdf-parse.js")) as unknown as { default: PdfParseFn };
  const parsed = await ns.default(normalized);
  return parsed.text;
}

describe("Task #1084 — Snapshot ohne lineAggregation re-rendert byte-genau pro-Termin", () => {
  let superadminId: number;
  let customerId: number;
  let invoiceId: number;
  const createdInvoiceIds: number[] = [];

  beforeAll(async () => {
    const auth = await getAuthCookie();
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isSuperAdmin, true))
      .limit(1);
    superadminId = admin?.id ?? auth.user.id;

    const cust = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Legacy",
      nachname: `PerAppt-${uniqueId()}`,
      geburtsdatum: "1940-05-05",
      email: `legacy-perappt-${uniqueId()}@test.local`,
      strasse: "Kassenweg",
      nr: "1",
      plz: "01067",
      stadt: "Dresden",
      telefon: "+4917600000020",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      beihilfeBerechtigt: false,
    });
    expect(cust.status, `create customer: ${JSON.stringify(cust.data)}`).toBe(201);
    customerId = cust.data.id;

    // Zwei Termine DESSELBEN Service (gleicher Preis) → kumuliert kollabieren
    // sie zu EINER Zeile, pro-Termin bleiben es ZWEI Zeilen mit Datum/Uhrzeit.
    const inv = await db.transaction(async (tx) =>
      createInvoiceTx(
        tx,
        {
          invoiceNumber: uniqueInvoiceNumber(),
          customerId,
          billingType: "pflegekasse_gesetzlich",
          invoiceType: "rechnung",
          billingMonth: MONTH,
          billingYear: YEAR,
          recipientName: "Pflegekasse Test",
          recipientAddress: "Empfängerweg 1, 01067 Dresden",
          customerName: "Legacy Per-Appt",
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
            appointmentDate: APPT_DATE_A,
            startTime: "09:00:00",
            endTime: "09:30:00",
            serviceDescription: "Alltagsbegleitung",
            serviceCode: "alltagsbegleitung",
            durationMinutes: 30,
            quantityRaw: 0.5,
            quantityUnit: "hours",
            unitPriceCents: 5000,
            totalCents: 2500,
            employeeName: "Erik",
          },
          {
            appointmentId: null,
            appointmentDate: APPT_DATE_B,
            startTime: "10:00:00",
            endTime: "10:30:00",
            serviceDescription: "Alltagsbegleitung",
            serviceCode: "alltagsbegleitung",
            durationMinutes: 30,
            quantityRaw: 0.5,
            quantityUnit: "hours",
            unitPriceCents: 5000,
            totalCents: 2500,
            employeeName: "Erik",
          },
        ],
        superadminId,
      ),
    );
    createdInvoiceIds.push(inv.id);
    invoiceId = inv.id;

    // Versiegeln: schreibt pdf_hash / zugferd_xml (KUMULIERT, #1083-Default) und
    // friert den Snapshot inkl. `lineAggregation: "cumulative"` + pdfCreationDate ein.
    await persistInvoicePdf(invoiceId);
  }, 180_000);

  afterAll(async () => {
    for (const id of createdInvoiceIds) {
      try {
        await db.delete(invoicesTable).where(eq(invoicesTable.id, id));
      } catch {
        /* best-effort */
      }
    }
    await cleanupCustomer(customerId);
    await runCleanup();
  });

  it("Snapshot ohne lineAggregation == explizit per_appointment (byte-genau) und ≠ kumuliert", async () => {
    const invoice = await storage.getInvoice(invoiceId);
    expect(invoice, "Rechnung muss existieren").toBeTruthy();
    expect(invoice!.pdfHash, "pdf_hash muss versiegelt sein").toBeTruthy();
    expect(invoice!.zugferdXml, "zugferd_xml muss versiegelt sein").toBeTruthy();
    expect(invoice!.renderSnapshot, "render_snapshot muss versiegelt sein").toBeTruthy();

    const companySettings = await getCachedCompanySettings();
    expect(companySettings, "company_settings muss geseedet sein").toBeTruthy();

    const sealed = invoice!.renderSnapshot as InvoiceRenderSnapshot;
    expect(sealed.pdfCreationDate, "pdfCreationDate muss eingefroren sein").toBeTruthy();
    expect(sealed.lineAggregation, "Erst-Persist versiegelt kumuliert (#1083)").toBe("cumulative");

    // (A) Altbestand simulieren: identischer Snapshot OHNE `lineAggregation`.
    const legacySnapshot = { ...sealed } as InvoiceRenderSnapshot;
    delete (legacySnapshot as { lineAggregation?: unknown }).lineAggregation;
    expect(
      (legacySnapshot as { lineAggregation?: unknown }).lineAggregation,
      "legacy-Snapshot darf das Feld nicht mehr tragen",
    ).toBeUndefined();

    // (B) Referenz: derselbe Snapshot, aber explizit per_appointment.
    const explicitPerAppt = { ...sealed, lineAggregation: "per_appointment" } as InvoiceRenderSnapshot;

    const legacy = await buildInvoicePdfBytes(invoice!, companySettings, { snapshot: legacySnapshot });
    const explicit = await buildInvoicePdfBytes(invoice!, companySettings, { snapshot: explicitPerAppt });

    const legacyPdfHash = computeDataHash(legacy.pdf as unknown as string);
    const explicitPdfHash = computeDataHash(explicit.pdf as unknown as string);

    // 1) Fehlendes Feld == explizit per_appointment, byte-genau (XML + PDF).
    expect(legacyPdfHash, "fehlendes lineAggregation muss per_appointment-PDF reproduzieren").toBe(
      explicitPdfHash,
    );
    expect(legacy.xml, "fehlendes lineAggregation muss per_appointment-XML reproduzieren").toBe(
      explicit.xml,
    );

    // 2) Nicht-trivial: pro-Termin ≠ versiegelt-kumuliert (sonst wäre der Test
    //    bedeutungslos, weil beide Modi dasselbe lieferten).
    expect(legacyPdfHash, "pro-Termin darf NICHT dem kumulierten Hash entsprechen").not.toBe(
      invoice!.pdfHash,
    );
    expect(legacy.xml, "pro-Termin-XML darf NICHT der kumulierten XML entsprechen").not.toBe(
      invoice!.zugferdXml,
    );

    // 3) pro-Termin-Form sichtbar: beide Termin-Daten als eigene Zeilen.
    const legacyText = await extractPdfText(Buffer.from(legacy.pdf));
    expect(legacyText, "pro-Termin-PDF trägt das erste Termin-Datum").toContain(DATE_A_DE);
    expect(legacyText, "pro-Termin-PDF trägt das zweite Termin-Datum").toContain(DATE_B_DE);

    // 4) Gegenprobe: die kumulierte (versiegelte) Form kollabiert auf EINE Zeile
    //    OHNE Datum-Spalte → die Termin-Daten fehlen.
    const cumulative = await buildInvoicePdfBytes(invoice!, companySettings, { snapshot: sealed });
    expect(
      computeDataHash(cumulative.pdf as unknown as string),
      "kumuliertes Re-Render reproduziert den versiegelten Hash",
    ).toBe(invoice!.pdfHash);
    const cumulativeText = await extractPdfText(Buffer.from(cumulative.pdf));
    expect(cumulativeText, "kumulierte Form führt das erste Termin-Datum NICHT").not.toContain(
      DATE_A_DE,
    );
    expect(cumulativeText, "kumulierte Form führt das zweite Termin-Datum NICHT").not.toContain(
      DATE_B_DE,
    );
  }, 180_000);
});
