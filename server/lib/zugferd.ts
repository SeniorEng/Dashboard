import type { InvoicePdfData } from "./pdf-generator";

let zugferdModule: any = null;
let basicProfile: any = null;

async function loadZugferd() {
  if (!zugferdModule) {
    zugferdModule = await import("node-zugferd");
    const basicMod = await import("node-zugferd/profile/basic");
    basicProfile = basicMod.BASIC;
  }
  return { zugferd: zugferdModule.zugferd, BASIC: basicProfile };
}

function parseDateString(dateStr: string): Date {
  const parts = dateStr.split(".");
  if (parts.length === 3) {
    return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
  }
  return new Date(dateStr);
}

function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

function buildZugferdData(data: InvoicePdfData) {
  const isStorno = data.invoiceType === "stornorechnung";
  const typeCode = isStorno ? "384" : "380";
  const issueDate = parseDateString(data.invoiceDate);

  const companyAddressParts = data.companyAddress ? data.companyAddress.split(", ") : [];
  const sellerAddress: any = {
    countryCode: "DE" as const,
    ...(companyAddressParts.length >= 1 ? { line1: companyAddressParts[0] } : {}),
    ...(companyAddressParts.length >= 2 ? { postCode: companyAddressParts[1].split(" ")[0], city: companyAddressParts[1].split(" ").slice(1).join(" ") } : {}),
  };

  const sellerTax: any = {};
  if (data.ustId) {
    sellerTax.vatIdentifier = data.ustId;
  }
  if (data.steuernummer) {
    sellerTax.localIdentifier = data.steuernummer;
  }

  const seller: any = {
    name: data.companyName,
    postalAddress: sellerAddress,
  };
  if (data.ikNummer) {
    seller.organization = {
      registrationIdentifier: {
        value: data.ikNummer,
      },
    };
  }
  if (Object.keys(sellerTax).length > 0) {
    seller.taxRegistration = sellerTax;
  }

  const buyerAddress: any = {
    countryCode: "DE" as const,
  };
  if (data.recipientAddress) {
    const addrLines = data.recipientAddress.split(/[\n,]/).map(l => l.trim()).filter(Boolean);
    if (addrLines.length >= 1) buyerAddress.line1 = addrLines[0];
    if (addrLines.length >= 2) {
      const plzMatch = addrLines[addrLines.length - 1].match(/^(\d{5})\s+(.+)/);
      if (plzMatch) {
        buyerAddress.postCode = plzMatch[1];
        buyerAddress.city = plzMatch[2];
      }
    }
  }

  const buyer: any = {
    name: data.recipientName,
    postalAddress: buyerAddress,
  };
  if (data.insuranceIkNummer) {
    buyer.organization = {
      registrationIdentifier: {
        value: data.insuranceIkNummer,
      },
    };
  }

  const vatExempt = data.vatAmountCents === 0;
  const taxCategoryCode = vatExempt ? "E" : "S";
  const taxPercent = vatExempt ? 0 : data.vatRate / 100;

  const lineItems = data.lineItems.map((item, index) => {
    const isKm = item.serviceCode === "travel_km" || item.serviceCode === "customer_km";
    const unitCode = isKm ? "KMT" : "HUR";
    const quantity = isKm ? item.durationMinutes : (item.durationMinutes / 60);
    const netPrice = centsToDecimal(item.unitPriceCents);
    const lineTotal = centsToDecimal(item.totalCents);

    return {
      identifier: String(index + 1),
      note: item.serviceDescription,
      tradeProduct: {
        name: item.serviceDescription,
      },
      tradeAgreement: {
        netTradePrice: {
          chargeAmount: netPrice,
        },
      },
      tradeDelivery: {
        billedQuantity: {
          amount: quantity,
          unitMeasureCode: unitCode,
        },
      },
      tradeSettlement: {
        tradeTax: {
          typeCode: "VAT" as const,
          categoryCode: taxCategoryCode,
          rateApplicablePercent: taxPercent,
        },
        monetarySummation: {
          totalAmount: lineTotal,
        },
      },
    };
  });

  const paymentMeans: any = {
    typeCode: "58",
    payeeAccount: {
      iban: data.iban,
    },
  };
  if (data.bic) {
    paymentMeans.payeeInstitution = {
      bic: data.bic,
    };
  }

  const taxBreakdown = [{
    calculatedAmount: centsToDecimal(data.vatAmountCents),
    typeCode: "VAT" as const,
    basisAmount: centsToDecimal(data.netAmountCents),
    categoryCode: taxCategoryCode,
    rateApplicablePercent: taxPercent,
    ...(vatExempt ? { exemptionReason: "Umsatzsteuerbefreit gem. § 4 Nr. 16 UStG" } : {}),
  }];

  return {
    number: data.invoiceNumber,
    typeCode,
    issueDate,
    transaction: {
      tradeAgreement: {
        seller,
        buyer,
      },
      line: lineItems,
      tradeSettlement: {
        currencyCode: "EUR" as const,
        paymentMeans,
        tradeTax: taxBreakdown,
        monetarySummation: {
          lineTotalAmount: centsToDecimal(data.netAmountCents),
          taxBasisTotalAmount: centsToDecimal(data.netAmountCents),
          taxTotal: {
            amount: centsToDecimal(data.vatAmountCents),
            currencyCode: "EUR" as const,
          },
          grandTotalAmount: centsToDecimal(data.grossAmountCents),
          duePayableAmount: centsToDecimal(data.grossAmountCents),
        },
      },
    },
  };
}

export async function embedZugferdXml(
  pdfBuffer: Buffer,
  data: InvoicePdfData
): Promise<Buffer> {
  try {
    const { zugferd, BASIC } = await loadZugferd();

    const invoicer = zugferd({ profile: BASIC, strict: false });
    const zugferdData = buildZugferdData(data);
    const invoice = invoicer.create(zugferdData);

    const resultPdf = await invoice.embedInPdf(pdfBuffer, {
      metadata: {
        title: `Rechnung ${data.invoiceNumber}`,
        author: data.companyName,
        subject: `Rechnung ${data.invoiceNumber}`,
      },
    });

    return Buffer.from(resultPdf);
  } catch (err) {
    console.error("[ZUGFeRD] Fehler beim Einbetten der XML-Daten, verwende Standard-PDF:", err);
    return pdfBuffer;
  }
}

export async function generateZugferdXml(data: InvoicePdfData): Promise<string | null> {
  try {
    const { zugferd, BASIC } = await loadZugferd();

    const invoicer = zugferd({ profile: BASIC, strict: false });
    const zugferdData = buildZugferdData(data);
    const invoice = invoicer.create(zugferdData);

    return await invoice.toXML();
  } catch (err) {
    console.error("[ZUGFeRD] Fehler beim Generieren der XML-Daten:", err);
    return null;
  }
}
