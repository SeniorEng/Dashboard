import type { InvoicePdfData } from "./pdf-generator";
import { log } from "./log";

interface ZugferdInvoice {
  toXML(): Promise<string>;
  embedInPdf(pdf: Buffer | Uint8Array, options?: Record<string, unknown>): Promise<Uint8Array>;
}

interface ZugferdInstance {
  create(data: ZugferdInvoiceData): ZugferdInvoice;
}

interface ZugferdFactory {
  (options: { profile: unknown; strict?: boolean }): ZugferdInstance;
}

let cachedZugferd: ZugferdFactory | null = null;
let cachedBasic: unknown = null;

async function loadZugferd(): Promise<{ zugferd: ZugferdFactory; BASIC: unknown }> {
  if (!cachedZugferd || !cachedBasic) {
    const modPath = "node-zugferd";
    const basicPath = "node-zugferd/profile/basic";
    const mod: Record<string, unknown> = await import(modPath);
    const basicMod: Record<string, unknown> = await import(basicPath);
    cachedZugferd = mod.zugferd as ZugferdFactory;
    cachedBasic = basicMod.BASIC;
  }
  return { zugferd: cachedZugferd, BASIC: cachedBasic };
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

function parseAddress(raw: string | null): { line1?: string; postCode?: string; city?: string } {
  if (!raw) return {};
  const lines = raw.split(/[\n,]/).map(l => l.trim()).filter(Boolean);
  const result: { line1?: string; postCode?: string; city?: string } = {};
  if (lines.length >= 1) result.line1 = lines[0];
  if (lines.length >= 2) {
    const plzMatch = lines[lines.length - 1].match(/^(\d{5})\s+(.+)/);
    if (plzMatch) {
      result.postCode = plzMatch[1];
      result.city = plzMatch[2];
    }
  }
  return result;
}

function computeServicePeriod(data: InvoicePdfData): { start: Date; end: Date } {
  const start = new Date(data.billingYear, data.billingMonth - 1, 1);
  const end = new Date(data.billingYear, data.billingMonth, 0);
  return { start, end };
}

interface ZugferdInvoiceData {
  number: string;
  typeCode: string;
  issueDate: Date;
  transaction: {
    tradeAgreement: {
      seller: {
        name: string;
        postalAddress: { countryCode: string; line1?: string; postCode?: string; city?: string };
        organization?: { registrationIdentifier: { value: string } };
        taxRegistration?: { vatIdentifier?: string; localIdentifier?: string };
      };
      buyer: {
        name: string;
        postalAddress: { countryCode: string; line1?: string; postCode?: string; city?: string };
        organization?: { registrationIdentifier: { value: string } };
      };
      buyerReference?: string;
    };
    tradeDelivery: {
      information: { deliveryDate: Date };
    };
    line: {
      identifier: string;
      note: string;
      tradeProduct: { name: string; description?: string };
      tradeAgreement: { netTradePrice: { chargeAmount: string } };
      tradeDelivery: { billedQuantity: { amount: number; unitMeasureCode: string } };
      tradeSettlement: {
        tradeTax: { typeCode: string; categoryCode: string; rateApplicablePercent: number };
        monetarySummation: { totalAmount: string };
      };
    }[];
    tradeSettlement: {
      currencyCode: string;
      paymentMeans: {
        typeCode: string;
        payeeAccount: { iban: string };
        payeeInstitution?: { bic: string };
      };
      tradeTax: {
        calculatedAmount: string;
        typeCode: string;
        basisAmount: string;
        categoryCode: string;
        rateApplicablePercent: number;
        exemptionReason?: string;
      }[];
      invoicingPeriod: { startDate: Date; endDate: Date };
      monetarySummation: {
        lineTotalAmount: string;
        taxBasisTotalAmount: string;
        taxTotal: { amount: string; currencyCode: string };
        grandTotalAmount: string;
        duePayableAmount: string;
      };
    };
  };
}

function buildZugferdData(data: InvoicePdfData): ZugferdInvoiceData {
  const isStorno = data.invoiceType === "stornorechnung";
  const typeCode = isStorno ? "384" as const : "380" as const;
  const issueDate = parseDateString(data.invoiceDate);

  const sellerAddr = parseAddress(data.companyAddress);
  const buyerAddr = parseAddress(data.recipientAddress);
  const period = computeServicePeriod(data);

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
        ...(item.serviceCode ? { description: item.serviceCode } : {}),
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

  const result: ZugferdInvoiceData = {
    number: data.invoiceNumber,
    typeCode,
    issueDate,
    transaction: {
      tradeAgreement: {
        seller: {
          name: data.companyName,
          postalAddress: {
            countryCode: "DE" as const,
            ...sellerAddr,
          },
          ...(data.ikNummer ? {
            organization: {
              registrationIdentifier: {
                value: data.ikNummer,
              },
            },
          } : {}),
          ...((data.ustId || data.steuernummer) ? {
            taxRegistration: {
              ...(data.ustId ? { vatIdentifier: data.ustId } : {}),
              ...(data.steuernummer ? { localIdentifier: data.steuernummer } : {}),
            },
          } : {}),
        },
        buyer: {
          name: data.recipientName,
          postalAddress: {
            countryCode: "DE" as const,
            ...buyerAddr,
          },
          ...(data.insuranceIkNummer ? {
            organization: {
              registrationIdentifier: {
                value: data.insuranceIkNummer,
              },
            },
          } : {}),
        },
        ...(data.versichertennummer ? { buyerReference: data.versichertennummer } : {}),
      },
      tradeDelivery: {
        information: {
          deliveryDate: period.end,
        },
      },
      line: lineItems,
      tradeSettlement: {
        currencyCode: "EUR" as const,
        paymentMeans: {
          typeCode: "58",
          payeeAccount: {
            iban: data.iban,
          },
          ...(data.bic ? {
            payeeInstitution: {
              bic: data.bic,
            },
          } : {}),
        },
        tradeTax: [{
          calculatedAmount: centsToDecimal(data.vatAmountCents),
          typeCode: "VAT" as const,
          basisAmount: centsToDecimal(data.netAmountCents),
          categoryCode: taxCategoryCode,
          rateApplicablePercent: taxPercent,
          ...(vatExempt ? { exemptionReason: "Umsatzsteuerbefreit gem. § 4 Nr. 16 UStG" } : {}),
        }],
        invoicingPeriod: {
          startDate: period.start,
          endDate: period.end,
        },
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

  return result;
}

function validateXmlStructure(xml: string | null | undefined): string[] {
  const errors: string[] = [];
  if (!xml) {
    errors.push("XML ist leer");
    return errors;
  }
  const requiredElements = [
    "CrossIndustryInvoice",
    "ExchangedDocumentContext",
    "ExchangedDocument",
    "SupplyChainTradeTransaction",
    "SellerTradeParty",
    "BuyerTradeParty",
    "IncludedSupplyChainTradeLineItem",
    "SpecifiedTradeSettlementHeaderMonetarySummation",
  ];
  for (const el of requiredElements) {
    if (!xml.includes(el)) {
      errors.push(`Pflicht-Element fehlt: ${el}`);
    }
  }
  return errors;
}

function validateZugferdData(data: ZugferdInvoiceData, pdfData: InvoicePdfData): string[] {
  const errors: string[] = [];
  if (!data.number) errors.push("Rechnungsnummer fehlt");
  if (!data.issueDate) errors.push("Rechnungsdatum fehlt");
  if (!data.transaction?.tradeAgreement?.seller?.name) errors.push("Verkäufername fehlt");
  if (!data.transaction?.tradeAgreement?.buyer?.name) errors.push("Käufername fehlt");
  if (!data.transaction?.line?.length) errors.push("Keine Rechnungspositionen");
  if (!pdfData.iban) errors.push("IBAN fehlt");

  const lineTotalSum = pdfData.lineItems.reduce((sum, item) => sum + item.totalCents, 0);
  if (Math.abs(lineTotalSum - pdfData.netAmountCents) > 1) {
    errors.push(`Positionssumme (${lineTotalSum}) stimmt nicht mit Nettobetrag (${pdfData.netAmountCents}) überein`);
  }

  return errors;
}

export async function embedZugferdXml(
  pdfBuffer: Buffer,
  data: InvoicePdfData
): Promise<Buffer> {
  try {
    const { zugferd, BASIC } = await loadZugferd();

    const zugferdData = buildZugferdData(data);

    const validationErrors = validateZugferdData(zugferdData, data);
    if (validationErrors.length > 0) {
      console.warn("[ZUGFeRD] Validierungsfehler, verwende Standard-PDF:", validationErrors.join("; "));
      return pdfBuffer;
    }

    let invoice: ZugferdInvoice;
    let usedStrictMode = false;
    try {
      const strictInvoicer = zugferd({ profile: BASIC, strict: true });
      invoice = strictInvoicer.create(zugferdData);
      await invoice.toXML();
      usedStrictMode = true;
      log("XSD-Validierung (strict) erfolgreich", "ZUGFeRD");
    } catch (strictErr) {
      console.warn("[ZUGFeRD] XSD-Validierung nicht verfügbar (Java/xsd-schema-validator fehlt), verwende Strukturvalidierung");
      const invoicer = zugferd({ profile: BASIC, strict: false });
      invoice = invoicer.create(zugferdData);
    }

    const xml = await invoice.toXML();
    const xmlErrors = validateXmlStructure(xml);
    if (xmlErrors.length > 0) {
      console.warn("[ZUGFeRD] XML-Strukturfehler, verwende Standard-PDF:", xmlErrors.join("; "));
      return pdfBuffer;
    }

    const resultPdf = await invoice.embedInPdf(pdfBuffer, {
      metadata: {
        title: `Rechnung ${data.invoiceNumber}`,
        author: data.companyName,
        subject: `Rechnung ${data.invoiceNumber}`,
      },
    });

    const pdfResult = Buffer.from(resultPdf);
    const pdfStr = pdfResult.toString("latin1");
    const hasPdfA = pdfStr.includes("pdfaid") || pdfStr.includes("PDF/A");
    const hasXml = pdfResult.includes(Buffer.from("factur-x.xml"));
    log(`PDF eingebettet für ${data.invoiceNumber} | strict=${usedStrictMode} | PDF/A-Marker=${hasPdfA} | XML=${hasXml}`, "ZUGFeRD");

    if (!hasPdfA || !hasXml) {
      console.warn(`[ZUGFeRD] Konformitätsprüfung fehlgeschlagen (PDF/A=${hasPdfA}, XML=${hasXml}), verwende Standard-PDF`);
      return pdfBuffer;
    }

    return pdfResult;
  } catch (err) {
    console.error("[ZUGFeRD] Fehler beim Einbetten der XML-Daten, verwende Standard-PDF:", err);
    return pdfBuffer;
  }
}

export async function generateZugferdXml(data: InvoicePdfData): Promise<string | null> {
  try {
    const { zugferd, BASIC } = await loadZugferd();

    const zugferdData = buildZugferdData(data);

    const validationErrors = validateZugferdData(zugferdData, data);
    if (validationErrors.length > 0) {
      console.warn("[ZUGFeRD] Validierungsfehler:", validationErrors.join("; "));
      return null;
    }

    const invoicer = zugferd({ profile: BASIC, strict: false });
    const invoice = invoicer.create(zugferdData);

    const xml = await invoice.toXML();
    const xmlErrors = validateXmlStructure(xml);
    if (xmlErrors.length > 0) {
      console.warn("[ZUGFeRD] XML-Strukturfehler:", xmlErrors.join("; "));
      return null;
    }

    return xml;
  } catch (err) {
    console.error("[ZUGFeRD] Fehler beim Generieren der XML-Daten:", err);
    return null;
  }
}
