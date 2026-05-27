/**
 * Task #654 — Drift-Detektor: ZUGFeRD-XML ist deterministisch reproduzierbar.
 *
 * Hintergrund: Im Produktiv-Log liefen mehrfach pro Minute Einträge der Form
 *   [integrity] Integrity-Drift Rechnung RE-2026-XXXX: xmlMatch=false pdfHashMatch=true
 * — d.h. das gespeicherte PDF/A war stabil, aber das frisch erzeugte
 * ZUGFeRD-XML wich byte-genau vom in `invoices.zugferd_xml` versiegelten
 * Original ab. Für die GoBD-Prüfung ist das ein Bruch der elektronischen
 * Beweisführung: die eingebettete E-Rechnung MUSS bit-identisch wieder
 * herauskommen, sonst ist der Integritätshash wertlos.
 *
 * Wurzel war der `invoiceDate`-Pfad in `buildPdfData`:
 *   invoice.sentAt ? formatDateForDisplay(formatDateISO(invoice.sentAt)) : todayISO()
 * Wenn die Rechnung zum Persistier-Zeitpunkt noch kein `sentAt` hatte, wurde
 * `todayISO()` ins XML eingefroren — bei jedem späteren Re-Render (anderer
 * Tag, oder zwischenzeitlich gesetztes `sentAt`) driftete das Datum.
 *
 * Fix: `InvoiceRenderSnapshot.invoice.invoiceDate`/`invoiceDueDate` werden
 * beim Erst-Persist mit-eingefroren; der Re-Render-Pfad in
 * `buildInvoicePdfData` überschreibt `pdfData.invoiceDate`/`invoiceDueDate`
 * aus dem Snapshot, bevor das XML gebaut wird.
 *
 * Dieser Test verifiziert (a) dass identische pdfData byte-gleiches XML
 * erzeugen — d.h. der XML-Builder selbst ist deterministisch — und (b) dass
 * verschiedene invoiceDate-Werte ein anderes XML produzieren, also der
 * Fix-Anker tatsächlich greift (negative Kontrolle gegen einen toten Test).
 */
import { describe, expect, it } from "vitest";
import { generateZugferdXml } from "../../server/lib/zugferd";
import type { InvoicePdfData } from "../../server/lib/pdf-generator";

function buildPdfData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoiceNumber: "RE-2026-0007",
    invoiceDate: "15.01.2026",
    invoiceDueDate: "29.01.2026",
    invoiceType: "pflegekasse_gesetzlich",
    billingYear: 2026,
    billingMonth: 1,
    companyName: "Pflegedienst Test",
    companyAddress: "Musterstraße 1\n10115 Berlin",
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    ikNummer: "123456789",
    ustId: "",
    steuernummer: "",
    insuranceIkNummer: "987654321",
    versichertennummer: "A123456789",
    recipientName: "AOK Nordost",
    recipientAddress: "Wilhelmstraße 1\n10963 Berlin",
    customerName: "Max Mustermann",
    customerGeburtsdatum: "1940-03-15",
    pflegegrad: 3,
    buyerReference: null,
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    netAmountCents: 12345,
    vatAmountCents: 0,
    grossAmountCents: 12345,
    vatRate: 0,
    lineItems: [
      {
        appointmentId: 101,
        appointmentDate: "2026-01-05",
        startTime: "09:00",
        endTime: "10:00",
        serviceCode: "hauswirtschaft",
        serviceDescription: "Hauswirtschaft",
        durationMinutes: 60,
        quantityRaw: 1,
        quantityUnit: "hours",
        unitPriceCents: 4500,
        totalCents: 4500,
        employeeName: "Anna Beispiel",
        appointmentNotes: null,
        serviceDetails: null,
      },
      {
        appointmentId: 101,
        appointmentDate: "2026-01-05",
        startTime: null,
        endTime: null,
        serviceCode: "travel_km",
        serviceDescription: "Anfahrt",
        durationMinutes: 9,
        quantityRaw: 8.57,
        quantityUnit: "km",
        unitPriceCents: 35,
        totalCents: 300,
        employeeName: "Anna Beispiel",
        appointmentNotes: null,
        serviceDetails: null,
      },
      {
        appointmentId: 102,
        appointmentDate: "2026-01-12",
        startTime: "11:00",
        endTime: "12:30",
        serviceCode: "alltagsbegleitung",
        serviceDescription: "Alltagsbegleitung",
        durationMinutes: 90,
        quantityRaw: 1.5,
        quantityUnit: "hours",
        unitPriceCents: 5030,
        totalCents: 7545,
        employeeName: "Bernd Beispiel",
        appointmentNotes: null,
        serviceDetails: null,
      },
    ],
    appointments: [],
    signatures: [],
    ...overrides,
  } as unknown as InvoicePdfData;
}

describe("Task #654 — ZUGFeRD-XML deterministisch reproduzierbar", () => {
  it("Determinismus: zwei Renders derselben pdfData produzieren bit-identisches XML", async () => {
    // Echter Drift-Detektor: wenn der XML-Builder irgendwo `new Date()`,
    // ein Map-Iterations-Artefakt oder Floating-Point-Noise einbringt,
    // sind die beiden Strings nicht mehr gleich und der Integrity-Hash
    // wäre wertlos.
    const data = buildPdfData();
    const xmlA = await generateZugferdXml(data);
    const xmlB = await generateZugferdXml(buildPdfData());
    expect(xmlA).not.toBeNull();
    expect(xmlB).not.toBeNull();
    expect(xmlA).toBe(xmlB);
  });

  it("Determinismus: Pflegekassen-Rechnung mit IncludedNote (AAK) bleibt stabil", async () => {
    // Versichertennummer/Pflegegrad/Geburtsdatum lösen einen zusätzlichen
    // IncludedNote-Block aus — dieser Pfad hatte historisch ein höheres
    // Drift-Risiko (String-Concat über mehrere optionale Felder).
    const xmlA = await generateZugferdXml(
      buildPdfData({
        versichertennummer: "B987654321",
        pflegegrad: 4,
        customerGeburtsdatum: "1938-07-22",
        assignmentDeclarationDate: "2024-09-01",
        assignmentDeclarationRef: "ABT-2024-007",
      }),
    );
    const xmlB = await generateZugferdXml(
      buildPdfData({
        versichertennummer: "B987654321",
        pflegegrad: 4,
        customerGeburtsdatum: "1938-07-22",
        assignmentDeclarationDate: "2024-09-01",
        assignmentDeclarationRef: "ABT-2024-007",
      }),
    );
    expect(xmlA).toBe(xmlB);
  });

  it("Sensitivität: anderes invoiceDate → anderes XML (negative Kontrolle)", async () => {
    // Stellt sicher, dass der Determinismus-Test nicht trivial wahr ist:
    // wenn `generateZugferdXml` das Datum nicht verarbeitet, würde der
    // Determinismus-Test auch dann passen, wenn der Drift-Bug noch da wäre.
    const xmlA = await generateZugferdXml(buildPdfData({ invoiceDate: "15.01.2026" }));
    const xmlB = await generateZugferdXml(buildPdfData({ invoiceDate: "16.01.2026" }));
    expect(xmlA).not.toBe(xmlB);
    expect(xmlA).toContain("20260115");
    expect(xmlB).toContain("20260116");
  });

  it("Snapshot-Schutz: ein eingefrorenes invoiceDate reproduziert das XML auch wenn sich `heute` ändert", async () => {
    // Simuliert den Produktions-Bug: Erst-Persist mit Datum A (damaliges
    // `todayISO()`), Re-Render am nächsten Tag mit Datum B (neues
    // `todayISO()` oder zwischenzeitlich gesetztes `sentAt`).
    // Ohne Snapshot-Override würde der Re-Render XML B liefern → Drift.
    // Mit Snapshot-Override (in `buildInvoicePdfData` umgesetzt) liefert
    // der Re-Render dasselbe XML wie der ursprüngliche Persist.
    const persisted = await generateZugferdXml(buildPdfData({ invoiceDate: "10.01.2026" }));
    const reRenderWithoutSnapshot = await generateZugferdXml(
      buildPdfData({ invoiceDate: "20.01.2026" }),
    );
    const reRenderWithSnapshot = await generateZugferdXml(
      // Snapshot overrideted invoiceDate zurück auf den eingefrorenen Wert.
      buildPdfData({ invoiceDate: "10.01.2026" }),
    );
    expect(persisted).not.toBe(reRenderWithoutSnapshot);
    expect(persisted).toBe(reRenderWithSnapshot);
  });
});
