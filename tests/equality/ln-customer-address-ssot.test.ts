/**
 * Task #1041 — Drift-Detektor: Die Leistungsnachweis-„Leistungsempfänger/in"-
 * Adresse (= Patient-Stammadresse, NICHT die Pflegekassen-Anschrift) wird in
 * ZWEI unabhängigen Render-Pfaden gesetzt, die byte-identisch bleiben MÜSSEN:
 *
 *   1. Persist-/Cache-/Bundle-Pfad:
 *      `invoice-pdf-orchestrator.buildInvoicePdfData`
 *   2. On-Demand-Versand-Pfad:
 *      `invoice-delivery.applyCustomerPdfRecipient`
 *
 * Beide leiten `pdfData.customerAddress` aus der Kunden-Stammadresse ab. Würde
 * einer der beiden ohne den anderen geändert, drifteten gecachtes und frisch
 * gerendertes LN-PDF wieder auseinander — exakt die Bug-Klasse der Tasks
 * #1032/#1034/#1036.
 *
 * Diese Tests stellen die Drift unmöglich, indem sie verifizieren, dass
 *   a) der Versand-Pfad `customerAddress` aus der EINZIGEN Quelle
 *      (`applyLeistungsnachweisCustomerAddress`) ableitet und exakt mit
 *      `formatCustomerMasterAddress` übereinstimmt, und
 *   b) BEIDE Quelldateien die geteilte Funktion aufrufen und KEINEN eigenen
 *      Inline-`customerAddress`-Override mehr enthalten.
 *
 * Dokumentiert außerdem: `customerAddress` fliesst NUR in den
 * Leistungsnachweis, nicht in das Rechnungs-PDF/ZUGFeRD-XML — die byte-genaue
 * GoBD-Integritätsprüfung der Rechnung bleibt unberührt.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  formatCustomerMasterAddress,
  applyLeistungsnachweisCustomerAddress,
} from "../../server/lib/customer-address-format";
import { applyCustomerPdfRecipient } from "../../server/services/invoice-delivery";
import type { InvoicePdfData } from "../../server/lib/pdf-generator";
import type { Customer } from "@shared/schema";

const ORCHESTRATOR = resolve(__dirname, "../../server/services/invoice-pdf-orchestrator.ts");
const DELIVERY = resolve(__dirname, "../../server/services/invoice-delivery.ts");

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    strasse: "Lindenstr.",
    nr: "7",
    plz: "20095",
    stadt: "Hamburg",
    vorname: "Erika",
    nachname: "Mustermann",
    name: "Erika Mustermann",
    geburtsdatum: null,
    ...overrides,
  } as unknown as Customer;
}

function makePdfData(): InvoicePdfData {
  return { customerAddress: "Pflegekasse XY\nKassenstr. 1\n10115 Berlin" } as unknown as InvoicePdfData;
}

describe("LN customerAddress — single source of truth (Task #1041)", () => {
  it("Versand-Pfad setzt customerAddress exakt auf die Stammadresse (= shared helper)", () => {
    const cust = makeCustomer();
    const viaDelivery = makePdfData();
    applyCustomerPdfRecipient(viaDelivery, cust, { isBeihilfe: false, isKostenerstattung: false });

    const viaHelper = makePdfData();
    applyLeistungsnachweisCustomerAddress(viaHelper, cust);

    expect(viaDelivery.customerAddress).toBe(formatCustomerMasterAddress(cust));
    expect(viaDelivery.customerAddress).toBe(viaHelper.customerAddress);
    expect(viaDelivery.customerAddress).toBe("Lindenstr. 7\n20095 Hamburg");
  });

  it("überschreibt die Pflegekassen-Anschrift mit der Patient-Stammadresse", () => {
    const cust = makeCustomer({ strasse: "Patientweg", nr: "3", plz: "80331", stadt: "München" });
    const pdfData = makePdfData();
    applyCustomerPdfRecipient(pdfData, cust, { isBeihilfe: false, isKostenerstattung: false });
    expect(pdfData.customerAddress).toBe("Patientweg 3\n80331 München");
    expect(pdfData.customerAddress).not.toContain("Pflegekasse");
  });

  it("lässt customerAddress unverändert, wenn keine Stammadresse vorhanden ist", () => {
    const cust = makeCustomer({ strasse: null, nr: null, plz: null, stadt: null });
    const pdfData = makePdfData();
    const before = pdfData.customerAddress;
    applyCustomerPdfRecipient(pdfData, cust, { isBeihilfe: false, isKostenerstattung: false });
    expect(pdfData.customerAddress).toBe(before);
  });

  it("BEIDE Render-Pfade leiten customerAddress aus der geteilten Funktion ab (kein Inline-Override)", () => {
    for (const file of [ORCHESTRATOR, DELIVERY]) {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("applyLeistungsnachweisCustomerAddress");
      // Kein eigenständiger customerAddress-Override mehr außerhalb der SSoT.
      expect(src).not.toMatch(/pdfData\.customerAddress\s*=/);
    }
  });
});
