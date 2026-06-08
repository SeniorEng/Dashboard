import { generatePdf } from "./server/lib/pdf-generator";
import type { InvoicePdfData } from "./server/lib/pdf-generator";
import { embedZugferdXml } from "./server/lib/zugferd";

const HTML = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"></head><body><h1>Test</h1><p>Deterministic check 12345</p></body></html>`;

function diffRegions(a: Buffer, b: Buffer): Array<{ off: number; aCtx: string; bCtx: string }> {
  const regions: Array<{ off: number; aCtx: string; bCtx: string }> = [];
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len) {
    if (a[i] !== b[i]) {
      const start = Math.max(0, i - 30);
      const end = Math.min(len, i + 40);
      regions.push({
        off: i,
        aCtx: a.subarray(start, end).toString("latin1").replace(/[^\x20-\x7e]/g, "."),
        bCtx: b.subarray(start, end).toString("latin1").replace(/[^\x20-\x7e]/g, "."),
      });
      i = end;
    } else {
      i++;
    }
  }
  return regions;
}

async function main() {
  console.log("=== Plain generatePdf (Chromium) ===");
  const p1 = await generatePdf(HTML);
  const p2 = await generatePdf(HTML);
  console.log(`len1=${p1.buffer.length} len2=${p2.buffer.length} hashEqual=${p1.hash === p2.hash}`);
  const d = diffRegions(p1.buffer, p2.buffer);
  console.log(`diff regions: ${d.length}`);
  for (const r of d.slice(0, 30)) {
    console.log(`@${r.off}\n  A: ${r.aCtx}\n  B: ${r.bCtx}`);
  }

  // Look for date-like tokens
  const s1 = p1.buffer.toString("latin1");
  const creationMatches = s1.match(/CreationDate|ModDate|xmp:CreateDate|xmp:ModifyDate|MetadataDate|xpacket|\/ID\s*\[/g);
  console.log("tokens in chromium pdf:", creationMatches);

  console.log("\n=== embedZugferdXml ===");
  const fakeData = {
    companyName: "Test GmbH", companyAddress: "Teststr 1\n12345 Berlin", companyPhone: "030123", companyEmail: "a@b.de",
    companyWebsite: null, steuernummer: "12/345", ustId: null, iban: "DE89370400440532013000", bic: "COBADEFFXXX",
    bankName: "Bank", bankAccountHolder: null, ikNummer: null, geschaeftsfuehrer: null,
    invoiceNumber: "RE-TEST-0001", invoiceDate: "01.06.2026", invoiceDueDate: "15.06.2026", buyerReference: null,
    invoiceType: "rechnung", billingType: "selbstzahler", billingMonth: 6, billingYear: 2026,
    recipientName: "Max Muster", recipientAddress: "Weg 2\n54321 Hamburg",
    insuranceProviderName: null, insuranceIkNummer: null, versichertennummer: null, pflegegrad: null,
    customerName: "Max Muster", customerAddress: "Weg 2\n54321 Hamburg", customerGeburtsdatum: null,
    assignmentDeclarationDate: null, assignmentDeclarationRef: null,
    lineItems: [{ appointmentId: 1, appointmentDate: "2026-06-01", startTime: "08:00", endTime: "09:00", serviceDescription: "Pflege", serviceCode: "care", durationMinutes: 60, unitPriceCents: 5000, totalCents: 5000, employeeName: "MA", appointmentNotes: null, serviceDetails: null }],
    netAmountCents: 5000, vatAmountCents: 950, grossAmountCents: 5950, vatRate: 1900, notes: null,
  } as unknown as InvoicePdfData;

  const base = await generatePdf(`<!DOCTYPE html><html><body>inv</body></html>`);
  const z1 = await embedZugferdXml(base.buffer, fakeData);
  const z2 = await embedZugferdXml(base.buffer, fakeData);
  console.log(`zlen1=${z1.pdf.length} zlen2=${z2.pdf.length} bytesEqual=${z1.pdf.equals(z2.pdf)}`);
  const zd = diffRegions(z1.pdf, z2.pdf);
  console.log(`zugferd diff regions: ${zd.length}`);
  for (const r of zd.slice(0, 40)) {
    console.log(`@${r.off}\n  A: ${r.aCtx}\n  B: ${r.bCtx}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
