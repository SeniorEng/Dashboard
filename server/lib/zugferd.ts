import type { InvoicePdfData } from "./pdf-generator";
import { log } from "./log";
import { parseLocalDate, parseTimestamp } from "@shared/utils/datetime";
import { centsToEuroNumber } from "@shared/utils/money";
import { aggregateInvoiceLineItems } from "@shared/domain/invoice-line-aggregation";

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

/**
 * Task #1073 — Wählbares ZUGFeRD-Profil. `basic` ist das historische
 * Factur-X-BASIC-Profil, `en16931` das vollständige EN-16931-(COMFORT)-Profil.
 *
 * WICHTIG (GoBD-Byte-Determinismus): Das Profil MUSS pro Rechnung im
 * `InvoiceRenderSnapshot` eingefroren werden. Bestände, die VOR der Umstellung
 * auf EN 16931 mit dem BASIC-Profil versiegelt wurden, haben keinen
 * `snapshot.profile` und MÜSSEN beim Re-Render wieder mit `basic` gerendert
 * werden — sonst driftet das frisch erzeugte XML byte-weise gegen das in
 * `invoices.zugferd_xml` versiegelte Original (falsch-positive Integritäts-
 * Drift). Neue Rechnungen werden mit `DEFAULT_ZUGFERD_PROFILE` (= en16931)
 * versiegelt und re-rendern aus dem dann gesetzten `snapshot.profile`.
 */
export type ZugferdProfileId = "basic" | "en16931";

/** Profil für frisch versiegelte Rechnungen (Erst-Persist / Draft-Vorschau). */
export const DEFAULT_ZUGFERD_PROFILE: ZugferdProfileId = "en16931";

let cachedZugferd: ZugferdFactory | null = null;
const cachedProfiles = new Map<ZugferdProfileId, unknown>();

async function loadZugferd(
  profileId: ZugferdProfileId,
): Promise<{ zugferd: ZugferdFactory; profile: unknown }> {
  if (!cachedZugferd) {
    const mod: Record<string, unknown> = await import("node-zugferd");
    cachedZugferd = mod.zugferd as ZugferdFactory;
  }
  let profile = cachedProfiles.get(profileId);
  if (!profile) {
    if (profileId === "en16931") {
      const m: Record<string, unknown> = await import("node-zugferd/profile/en16931");
      profile = m.EN16931;
    } else {
      const m: Record<string, unknown> = await import("node-zugferd/profile/basic");
      profile = m.BASIC;
    }
    cachedProfiles.set(profileId, profile);
  }
  return { zugferd: cachedZugferd, profile };
}

function parseDateString(dateStr: string): Date {
  const parts = dateStr.split(".");
  if (parts.length === 3) {
    return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return parseLocalDate(dateStr);
  }
  // Restfälle (vollständige ISO-8601-Timestamps mit Zeitzone, z. B. von
  // timestamptz-Spalten); parseTimestamp wirft kontrolliert für unsichere
  // Eingaben und vermeidet so off-by-one-Fehler bei abweichender Server-TZ.
  return parseTimestamp(dateStr);
}

function centsToDecimal(cents: number): string {
  // ZUGFeRD/XRechnung verlangt englisches Dezimalformat ("125.50"), daher
  // direkt `centsToEuroNumber`+`toFixed(2)` statt `formatEuroDE` (de-DE).
  return centsToEuroNumber(cents).toFixed(2);
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

interface ZugferdIncludedNote {
  content: string;
  subjectCode?: string;
}

interface ZugferdInvoiceData {
  number: string;
  typeCode: string;
  issueDate: Date;
  // Task #562 — IncludedNote/BG-1: strukturierte Hinweise (Versichertendaten,
  // Abtretungserklärung, AUA-Az). SubjectCodes:
  //   "AAK" = Quality notes (genutzt für Versichertendaten-Block)
  //   "REG" = Regulatory information (genutzt für Abtretungserklärung +
  //            AUA-Anerkennung, beides §§-relevant)
  includedNote?: ZugferdIncludedNote[];
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
        // Task #1098 — Pro-Zeilen-Betrag (BT-131). Der korrekte node-zugferd-
        // Schlüssel ist `lineTotalAmount`; der frühere `totalAmount` wurde von
        // node-zugferd still verworfen (kein BT-131 im XML). Für versiegelte
        // Bestände ohne BT-131 (Snapshot-gated) wird weiterhin der alte
        // `totalAmount`-Schlüssel emittiert, damit das XML byte-stabil bleibt.
        monetarySummation: { totalAmount?: string; lineTotalAmount?: string };
      };
    }[];
    tradeSettlement: {
      currencyCode: string;
      // Task #1105 — Bestands-/Legacy-Schlüssel (`paymentMeans`/`tradeTax`).
      // node-zugferd kennt diese Schlüssel im Header NICHT (es sind die
      // Zeilen-Schlüssel) und verwirft sie still; sie bleiben ausschließlich
      // erhalten, damit das Re-Render versiegelter Rechnungen das damals
      // emittierte (unvollständige) XML byte-genau reproduziert (GoBD). Neue
      // Rechnungen verwenden stattdessen die korrekten Schlüssel
      // `paymentInstruction` (BG-16) und `vatBreakdown` (BG-23).
      paymentMeans?: {
        typeCode: string;
        payeeAccount: { iban: string; accountName?: string };
        payeeInstitution?: { bic: string };
      };
      paymentInstruction?: {
        typeCode: string;
        transfers: { paymentAccountIdentifier: string }[];
      };
      tradeTax?: {
        calculatedAmount: string;
        typeCode: string;
        basisAmount: string;
        categoryCode: string;
        rateApplicablePercent: number;
        exemptionReason?: string;
      }[];
      vatBreakdown?: {
        calculatedAmount: string;
        typeCode: string;
        basisAmount: string;
        categoryCode: string;
        rateApplicablePercent: number;
        exemptionReasonText?: string;
      }[];
      invoicingPeriod: { startDate: Date; endDate: Date };
      // Task #562 — BT-9 Fälligkeitsdatum. paymentTerms.dueDate ist im
      // node-zugferd basic-Profil optional, wird aber für die Dunkel-
      // verarbeitung durch Pflegekassen/Rechnungseingangs-Systeme erwartet.
      paymentTerms?: { description?: string; dueDate?: Date };
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

  // Task #1083: Das eingebettete EN-16931-/ZUGFeRD-XML spiegelt exakt die im
  // PDF sichtbaren Positionen. Für neue Rechnungen kumuliert (eine Zeile je
  // Leistungs-/Fahrtkosten-Typ), für Bestand pro Termin (über den Render-
  // Snapshot byte-stabil eingefroren). Σ(LineTotal) bleibt bit-genau erhalten,
  // sodass die Reconciliation (LineTotalSum == Nettobetrag) weiterhin hält.
  const sourceLineItems =
    data.lineAggregation === "cumulative"
      ? aggregateInvoiceLineItems(data.lineItems, data.fahrtkostenLabel)
      : data.lineItems;

  const lineItems = sourceLineItems.map((item, index) => {
    const isKm = item.serviceCode === "travel_km" || item.serviceCode === "customer_km";
    const unitCode = isKm ? "KMT" : "HUR";
    // Task #561: bevorzugt `quantityRaw` (Dezimal-km bzw. Dezimalstunden);
    // Fallback auf `durationMinutes` für historische Zeilen.
    const quantity = item.quantityRaw != null
      ? item.quantityRaw
      : (isKm ? item.durationMinutes : (item.durationMinutes / 60));
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
        // Task #1098 — BT-131 (`lineTotalAmount`) für neue Rechnungen. Bestände
        // ohne BT-131 (Snapshot ohne `includeLineTotalAmount`) re-rendern weiter
        // mit dem alten `totalAmount`-Schlüssel, den node-zugferd ignoriert,
        // damit das versiegelte XML byte-identisch bleibt (GoBD-Hash-Stabilität).
        monetarySummation: data.includeLineTotalAmount
          ? { lineTotalAmount: lineTotal }
          : { totalAmount: lineTotal },
      },
    };
  });

  // Task #562 — Strukturierte IncludedNotes (BG-1) für Versichertendaten
  // und Abtretungserklärung / AUA-Anerkennung. Pflegekassen-Eingangs-
  // systeme können diese SubjectCodes maschinell auswerten, ohne den PDF-
  // Footer zu parsen.
  const notes: ZugferdIncludedNote[] = [];
  if (data.customerName && (data.versichertennummer || data.pflegegrad || data.customerGeburtsdatum)) {
    const parts: string[] = [`Versicherte/r: ${data.customerName}`];
    if (data.customerGeburtsdatum) parts.push(`Geb.: ${data.customerGeburtsdatum}`);
    if (data.versichertennummer) parts.push(`Vers.-Nr.: ${data.versichertennummer}`);
    if (data.pflegegrad) parts.push(`Pflegegrad: ${data.pflegegrad}`);
    notes.push({ content: parts.join(" | "), subjectCode: "AAK" });
  }
  if (data.assignmentDeclarationDate || data.assignmentDeclarationRef) {
    const aakParts: string[] = ["Abtretungserklärung (§ 398 BGB)"];
    if (data.assignmentDeclarationDate) aakParts.push(`vom ${data.assignmentDeclarationDate}`);
    if (data.assignmentDeclarationRef) aakParts.push(`Az. ${data.assignmentDeclarationRef}`);
    notes.push({ content: aakParts.join(" "), subjectCode: "REG" });
  }
  // Task #759 — Variant C: §-Paragraf der Pot-Rechnung als BT-22-Note
  // (subjectCode "REG" = regulatory). Pflegekassen-Eingangsverarbeitung
  // sieht damit topf-spezifisch, welcher Anspruch abgerechnet wird.
  switch (data.budgetType) {
    case "entlastungsbetrag_45b":
      notes.push({ content: "§ 45b SGB XI — Entlastungsbetrag", subjectCode: "REG" });
      break;
    case "umwandlung_45a":
      notes.push({ content: "§ 45a SGB XI — Umwandlungsanspruch", subjectCode: "REG" });
      break;
    case "ersatzpflege_39_42a":
      notes.push({ content: "§§ 39 / 42a SGB XI — Verhinderungspflege", subjectCode: "REG" });
      break;
  }

  const result: ZugferdInvoiceData = {
    number: data.invoiceNumber,
    typeCode,
    issueDate,
    ...(notes.length > 0 ? { includedNote: notes } : {}),
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
        // Task #562 — BT-10 Käuferreferenz. Bevorzugt die explizite
        // `buyerReference` aus der Rechnung; bei Pflegekassen-Rechnungen
        // ohne expliziten Wert fällt sie auf die Versicherten-Nr. zurück,
        // damit der Vorgang im Eingangs-System auffindbar bleibt.
        ...((data.buyerReference ?? data.versichertennummer)
          ? { buyerReference: (data.buyerReference ?? data.versichertennummer) as string }
          : {}),
      },
      tradeDelivery: {
        information: {
          deliveryDate: period.end,
        },
      },
      line: lineItems,
      tradeSettlement: {
        currencyCode: "EUR" as const,
        // Task #1105 — Header-Zahlungsweg (BG-16) und USt-Aufschlüsselung (BG-23).
        // Neue Rechnungen (`strictSettlement`) verwenden die KORREKTEN
        // node-zugferd-Schlüssel `paymentInstruction`/`vatBreakdown`. Erst damit
        // emittiert node-zugferd die EN-16931-Pflicht-USt-Aufschlüsselung
        // (`ApplicableTradeTax` im Settlement-Header) und das XML besteht die
        // XSD-Strict-Validierung. node-zugferd erwartet `transfers`/`vatBreakdown`
        // als ARRAYS (BG-16/BG-23) — als Einzelobjekt würde der Inhalt (z.B. die
        // IBAN) still verworfen (Mustang BR-CO-27). Bestände OHNE das Flag behalten
        // die FRÜHEREN Schlüssel `paymentMeans`/`tradeTax`, die node-zugferd STILL
        // verwarf — so reproduziert das Re-Render das in `invoices.zugferd_xml`
        // versiegelte (unvollständige) XML byte-genau (GoBD-Integritäts-Verifier).
        ...(data.strictSettlement
          ? {
              paymentInstruction: {
                typeCode: "58",
                transfers: [{ paymentAccountIdentifier: data.iban }],
              },
              vatBreakdown: [{
                calculatedAmount: centsToDecimal(data.vatAmountCents),
                typeCode: "VAT" as const,
                basisAmount: centsToDecimal(data.netAmountCents),
                categoryCode: taxCategoryCode,
                rateApplicablePercent: taxPercent,
                // BT-120 — Befreiungsgrund-Text (Pflicht bei Kategorie E, BR-E-10).
                ...(vatExempt ? { exemptionReasonText: "Umsatzsteuerbefreit gem. § 4 Nr. 16 UStG" } : {}),
              }],
            }
          : {
              paymentMeans: {
                typeCode: "58",
                payeeAccount: {
                  iban: data.iban,
                  // Task #757: Optionaler abweichender Kontoinhaber (BT-85,
                  // PayeeFinancialAccount.AccountName). Wenn nicht gesetzt, bleibt
                  // der Firmenname implizit über die SellerTradeParty-Identifikation
                  // bestehen (bisheriges Verhalten).
                  ...((data.bankAccountHolder ?? "").trim()
                    ? { accountName: (data.bankAccountHolder as string).trim() }
                    : {}),
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
            }),
        invoicingPeriod: {
          startDate: period.start,
          endDate: period.end,
        },
        // Task #562 — BT-9 Fälligkeitsdatum als paymentTerms.dueDate.
        ...(data.invoiceDueDate
          ? {
              paymentTerms: {
                description: `Zahlbar bis ${data.invoiceDueDate}`,
                dueDate: parseDateString(data.invoiceDueDate),
              },
            }
          : {}),
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

export type ValidateZugferdResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Konsolidierte XML-Validierung für ZUGFeRD/Factur-X. Ersetzt die früher
 * an drei Stellen verstreuten Strict-Checks und die Substring-Heuristik in
 * der PDF-Konformitätsprüfung.
 */
export function validateZugferd(xml: string | null | undefined): ValidateZugferdResult {
  const errors: string[] = [];
  if (!xml) {
    errors.push("XML ist leer");
    return { ok: false, errors };
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
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Task #1105 — Lädt das XSD-Schema-Set eines node-zugferd-Profils (Haupt-XSD +
 * alle per `xsd:import schemaLocation` referenzierten Sub-Schemas) als
 * In-Memory-Dateien für `xmllint-wasm`. Der Pfad wird über die von node-zugferd
 * exponierte `profile.xsdPath()`-Funktion aufgelöst (kein hartcodierter Pfad),
 * die referenzierten Sub-Schemas werden aus demselben Verzeichnis nachgeladen.
 */
async function loadXsdSchemaSet(
  profile: unknown,
): Promise<{ mainFileName: string; files: { fileName: string; contents: string }[] } | null> {
  const xsdPathFn = (profile as { xsdPath?: () => string } | null)?.xsdPath;
  if (typeof xsdPathFn !== "function") return null;
  const mainPath = xsdPathFn();
  const { readFileSync } = await import("node:fs");
  const { dirname, basename, join } = await import("node:path");
  const dir = dirname(mainPath);
  const files = new Map<string, string>();
  const queue: string[] = [mainPath];
  while (queue.length > 0) {
    const filePath = queue.shift() as string;
    const fileName = basename(filePath);
    if (files.has(fileName)) continue;
    const contents = readFileSync(filePath, "utf8");
    files.set(fileName, contents);
    const importRe = /schemaLocation="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(contents)) !== null) {
      const childName = basename(match[1]);
      if (!files.has(childName)) queue.push(join(dir, match[1]));
    }
  }
  return {
    mainFileName: basename(mainPath),
    files: [...files.entries()].map(([fileName, contents]) => ({ fileName, contents })),
  };
}

/**
 * Task #1105 — XSD-Strict-Validierung des eingebetteten ZUGFeRD-/Factur-X-XML
 * OHNE Java-Runtime. node-zugferd's eingebaute Strict-Validierung benötigt
 * `xsd-schema-validator` + Java (in Dev/Prod nicht verfügbar); diese Funktion
 * validiert stattdessen mit `xmllint-wasm` (reines WebAssembly) gegen die von
 * node-zugferd gebündelten Profil-XSDs. Wird beim Erst-Seal neuer Rechnungen
 * genutzt, um die Versiegelung als strict zu markieren (kein
 * `invoice_zugferd_nonstrict_seal`-Audit).
 */
export async function validateZugferdXsd(
  xml: string,
  profile: unknown,
): Promise<ValidateZugferdResult> {
  try {
    const schemaSet = await loadXsdSchemaSet(profile);
    if (!schemaSet) return { ok: false, errors: ["XSD-Schema nicht auffindbar (profile.xsdPath fehlt)"] };
    const mainFile = schemaSet.files.find((f) => f.fileName === schemaSet.mainFileName);
    if (!mainFile) return { ok: false, errors: ["Haupt-XSD nicht gefunden"] };
    const { validateXML } = await import("xmllint-wasm");
    const result = await validateXML({
      xml: [{ fileName: "factur-x.xml", contents: xml }],
      schema: [mainFile],
      preload: schemaSet.files,
    });
    if (result.valid) return { ok: true };
    const errors = (result.errors ?? []).map((e) =>
      typeof e === "string" ? e : (e as { message?: string }).message ?? JSON.stringify(e),
    );
    return { ok: false, errors: errors.length > 0 ? errors : ["XSD-Validierung fehlgeschlagen"] };
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/**
 * PDF/A-Konformitätsprüfung über echten XMP-Metadata-Block (statt
 * Substring-Suche im rohen PDF-Bytestream). Liest den Metadata-Stream
 * aus dem PDF-Katalog und prüft, ob ein `pdfaid`-XMP-Block vorhanden ist.
 */
async function readPdfAXmp(pdfBytes: Buffer): Promise<{ hasPdfA: boolean; xmp: string | null }> {
  try {
    const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    const metadataRef = pdfDoc.catalog.get(PDFName.of("Metadata"));
    if (!metadataRef) return { hasPdfA: false, xmp: null };
    const stream = pdfDoc.context.lookup(metadataRef);
    if (!(stream instanceof PDFRawStream)) return { hasPdfA: false, xmp: null };
    const decoded = decodePDFRawStream(stream).decode();
    const xmp = Buffer.from(decoded).toString("utf8");
    const hasPdfA = /pdfaid\s*:\s*part/.test(xmp);
    return { hasPdfA, xmp };
  } catch (err) {
    log(`PDF/A-XMP-Parse fehlgeschlagen: ${err}`, "ZUGFeRD");
    return { hasPdfA: false, xmp: null };
  }
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

async function buildZugferdInvoice(
  data: InvoicePdfData,
  profileId: ZugferdProfileId,
): Promise<
  | { ok: true; xml: string; invoice: ZugferdInvoice; usedStrictMode: boolean; strictModeReason: string | null; profile: ZugferdProfileId }
  | { ok: false; errors: string[] }
> {
  const { zugferd, profile } = await loadZugferd(profileId);
  const zugferdData = buildZugferdData(data);

  const dataErrors = validateZugferdData(zugferdData, data);
  if (dataErrors.length > 0) return { ok: false, errors: dataErrors };

  let invoice: ZugferdInvoice;
  let xml: string;
  let usedStrictMode = false;
  // Task #1073 — Grund für die Nutzung des Non-Strict-Pfades. node-zugferd
  // ruft im Strict-Modus `profile.validate()` auf, das `xsd-schema-validator`
  // (+ Java-Runtime) voraussetzt. Fehlt diese Abhängigkeit, wirft der Aufruf
  // und wir fallen auf den Non-Strict-Pfad zurück. FRÜHER passierte das
  // STILL; jetzt wird der Grund nach oben gereicht, damit die Versiegelung am
  // Seal-Punkt (`persistInvoicePdfInner`) per Audit-Log dokumentiert wird —
  // welche Rechnung lief ohne XSD-Strict-Validierung und warum. Die echte
  // Konformitätsprüfung (EN-16931-Schematron, PDF/A-3) übernimmt das externe
  // Validierungs-Gate (`scripts/validate-erechnung.ts` / CI), unabhängig von
  // dieser Beta-Library.
  let strictModeReason: string | null = null;
  try {
    const strictInvoicer = zugferd({ profile, strict: true });
    invoice = strictInvoicer.create(zugferdData);
    xml = await invoice.toXML();
    usedStrictMode = true;
  } catch (err) {
    strictModeReason = err instanceof Error ? err.message : String(err);
    const invoicer = zugferd({ profile, strict: false });
    invoice = invoicer.create(zugferdData);
    xml = await invoice.toXML();
  }

  // Task #1105 — Strict-Versiegelung OHNE Java-Runtime. Der node-zugferd-
  // Strict-Pfad oben wirft mangels `xsd-schema-validator`/Java in Dev/Prod
  // immer → ohne diese Brücke bliebe `usedStrictMode` false und jede neue
  // Rechnung würde am Seal-Punkt einen `invoice_zugferd_nonstrict_seal`-Audit
  // auslösen. Für neue Rechnungen (mit korrekter Settlement-Aufschlüsselung,
  // `strictSettlement`) validieren wir das emittierte XML stattdessen mit
  // `xmllint-wasm` gegen die gebündelten Profil-XSDs. Besteht es, gilt die
  // Versiegelung als strict. Bestände (ohne `strictSettlement`) durchlaufen
  // diese Brücke NICHT (ihr XML ist absichtlich unverändert/unvollständig).
  if (!usedStrictMode && data.strictSettlement === true) {
    const xsdResult = await validateZugferdXsd(xml, profile);
    if (xsdResult.ok) {
      usedStrictMode = true;
      strictModeReason = null;
    } else {
      strictModeReason = `WASM-XSD-Validierung fehlgeschlagen: ${xsdResult.errors.join("; ")}`;
    }
  }

  const result = validateZugferd(xml);
  if (!result.ok) return { ok: false, errors: result.errors };

  return { ok: true, xml, invoice, usedStrictMode, strictModeReason, profile: profileId };
}

export interface EmbedZugferdResult {
  /** Das PDF mit eingebetteter ZUGFeRD-XML (PDF/A-3) bzw. Standard-PDF als Fallback. */
  pdf: Buffer;
  /** Das tatsächlich eingebettete XML, oder null wenn nur das Standard-PDF zurückgegeben wurde. */
  xml: string | null;
  /** Task #1073 — tatsächlich verwendetes Profil (für die Snapshot-Versiegelung). */
  profile: ZugferdProfileId;
  /**
   * Task #1073 — true, wenn node-zugferd die XSD-Strict-Validierung tatsächlich
   * ausgeführt hat. false = Non-Strict-Fallback (Grund in `strictModeReason`).
   */
  usedStrictMode: boolean;
  /** Grund, warum der Non-Strict-Pfad genutzt wurde (null wenn strict lief). */
  strictModeReason: string | null;
}

/**
 * Task #553: Typisierter Fehler für ZUGFeRD-Einbettungs-Failures im Send-Pfad.
 * Wird ausschließlich von `embedZugferdXml(..., { strict: true })` geworfen
 * — der Default-Pfad (Preview/PDF-Anzeige) fällt weiterhin still auf das
 * Standard-PDF zurück, damit Vorschauen nicht hart brechen.
 *
 * Send-Endpoints (Rechnung an Pflegekasse/Kunde) MÜSSEN strict=true verwenden,
 * damit eine nicht-konforme Rechnung nicht verschickt wird (GoBD/ZUGFeRD-Compliance).
 */
export class ZugferdEmbedError extends Error {
  constructor(public readonly reason: string, public readonly cause?: unknown) {
    super(`ZUGFeRD-Einbettung fehlgeschlagen: ${reason}`);
    this.name = "ZugferdEmbedError";
  }
}

/**
 * Task #1106 — repariert das von node-zugferd fehlerhaft emittierte XMP-Metadaten-
 * Paket. node-zugferd schreibt `<rdf:Description ... xmlns:about="">` statt
 * `<rdf:Description ... rdf:about="">`: Ein Präfix (`about`) auf den LEEREN
 * Namespace zu binden ist nach XML-Namespaces 1.0 illegal und bricht den
 * XMP-Parse → veraPDF meldet PDF/A-3b als NICHT konform.
 *
 * Die Reparatur ist LÄNGENERHALTEND (`xmlns:about=""` und `rdf:about=""  ` sind
 * beide 14 Bytes): so verschieben sich KEINE PDF-XRef-Offsets und der
 * nachgelagerte `normalizePdfDeterminism`-Pfad bleibt unberührt. PDF/A schreibt
 * das XMP-Paket als unkomprimierten Stream vor, daher greift der Byte-Replace.
 */
function repairZugferdXmpNamespace(pdf: Buffer): Buffer {
  const needle = Buffer.from('xmlns:about=""', "latin1");
  const replacement = Buffer.from('rdf:about=""  ', "latin1"); // identische Länge (14)
  let idx = pdf.indexOf(needle);
  if (idx === -1) return pdf;
  const out = Buffer.from(pdf);
  while (idx !== -1) {
    replacement.copy(out, idx);
    idx = out.indexOf(needle, idx + replacement.length);
  }
  return out;
}

export async function embedZugferdXml(
  pdfBuffer: Buffer,
  data: InvoicePdfData,
  options?: { strict?: boolean; testFaults?: Set<string>; creationDate?: string | Date; profile?: ZugferdProfileId }
): Promise<EmbedZugferdResult> {
  const strict = options?.strict === true;
  const profileId = options?.profile ?? DEFAULT_ZUGFERD_PROFILE;
  // Task #559: Test-Fault-Injection — erlaubt es Integrationstests, einen
  // ZUGFeRD-Embedding-Fehler im Send-Pfad zu erzwingen, ohne echte Library-
  // Internals zu mocken. Nur in NODE_ENV=test aktiv (und nur wenn strict=true,
  // da der Preview-/Non-Strict-Pfad einen Fehler gar nicht propagieren würde).
  if (
    process.env.NODE_ENV === "test" &&
    strict &&
    options?.testFaults?.has("zugferd_embed")
  ) {
    throw new ZugferdEmbedError("Test fault injected: zugferd_embed");
  }
  try {
    const built = await buildZugferdInvoice(data, profileId);
    if (!built.ok) {
      const reason = `Validierungsfehler: ${built.errors.join("; ")}`;
      if (strict) {
        throw new ZugferdEmbedError(reason);
      }
      log(`${reason} — verwende Standard-PDF`, "ZUGFeRD");
      return { pdf: pdfBuffer, xml: null, profile: profileId, usedStrictMode: false, strictModeReason: reason };
    }

    let resultPdf: Uint8Array;
    try {
      // Task #1047 — eingefrorenes Erzeugungsdatum: node-zugferd schreibt die
      // Info-Dict-Zeitstempel (`/CreationDate`/`/ModDate`) komprimiert in einen
      // Object-Stream, der NICHT byte-nachträglich gepatcht werden kann. Daher
      // wird der eingefrorene Zeitpunkt hier an der Quelle übergeben; die NICHT
      // überschreibbaren XMP-Zeitstempel und die XRef-Stream-`/ID` werden
      // anschließend per `normalizePdfDeterminism` längenerhaltend normalisiert.
      const frozenDate =
        options?.creationDate != null
          ? (typeof options.creationDate === "string"
              ? new Date(options.creationDate)
              : options.creationDate)
          : undefined;
      resultPdf = await built.invoice.embedInPdf(pdfBuffer, {
        metadata: {
          title: `Rechnung ${data.invoiceNumber}`,
          author: data.companyName,
          subject: `Rechnung ${data.invoiceNumber}`,
          ...(frozenDate && !Number.isNaN(frozenDate.getTime())
            ? { createDate: frozenDate, modifyDate: frozenDate }
            : {}),
        },
      });
    } catch (embedErr) {
      if (strict) {
        throw new ZugferdEmbedError(
          `embedInPdf-Aufruf fehlgeschlagen: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
          embedErr,
        );
      }
      throw embedErr;
    }

    // Task #1106 — fehlerhaftes XMP-Namespace-Attribut längenerhaltend reparieren
    // (gated über `includeConformantSettlement`, damit versiegelte Bestände
    // byte-identisch re-rendern). Ohne Reparatur bricht der XMP-Parse → veraPDF
    // meldet PDF/A-3b als nicht konform.
    const pdfResult = data.includeConformantSettlement
      ? repairZugferdXmpNamespace(Buffer.from(resultPdf))
      : Buffer.from(resultPdf);
    const { hasPdfA } = await readPdfAXmp(pdfResult);
    const hasXml = pdfResult.includes(Buffer.from("factur-x.xml"));
    log(`PDF eingebettet für ${data.invoiceNumber} | strict=${built.usedStrictMode} | PDF/A=${hasPdfA} | XML=${hasXml}`, "ZUGFeRD");

    if (!hasPdfA || !hasXml) {
      const reason = `Konformitätsprüfung fehlgeschlagen (PDF/A=${hasPdfA}, XML=${hasXml})`;
      if (strict) {
        throw new ZugferdEmbedError(reason);
      }
      log(`${reason}, verwende Standard-PDF`, "ZUGFeRD");
      return { pdf: pdfBuffer, xml: null, profile: profileId, usedStrictMode: false, strictModeReason: reason };
    }

    return { pdf: pdfResult, xml: built.xml, profile: built.profile, usedStrictMode: built.usedStrictMode, strictModeReason: built.strictModeReason };
  } catch (err) {
    if (err instanceof ZugferdEmbedError) {
      throw err;
    }
    if (strict) {
      throw new ZugferdEmbedError(
        err instanceof Error ? err.message : String(err),
        err,
      );
    }
    log(`Fehler beim Einbetten der XML-Daten, verwende Standard-PDF: ${err}`, "ZUGFeRD");
    return { pdf: pdfBuffer, xml: null, profile: profileId, usedStrictMode: false, strictModeReason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Task #1109 — Java-freie Strict-Konformitäts-Prüfung einer kompletten
 * Rechnung über den WASM-XSD-Pfad (`validateZugferdXsd`). Baut die ZUGFeRD-XML
 * exakt über denselben Produktivpfad (`buildZugferdInvoice`), den auch der
 * Seal-Punkt nutzt, und validiert das emittierte XML gegen die gebündelten
 * Profil-XSDs. Anders als `buildZugferdInvoice` (das den WASM-Check nur bei
 * `data.strictSettlement === true` ausführt) erzwingt diese Funktion die
 * XSD-Validierung IMMER und reicht die konkreten XSD-Fehler nach oben — damit
 * das CI-Gate (`scripts/validate-erechnung-strict.ts`) jede Nicht-Konformität
 * einer realen Pot-/USt-Szenario-Rechnung hart failt, unabhängig davon, ob
 * Java/Mustang/veraPDF auf dem Runner installiert sind.
 */
export async function validateInvoiceXsd(
  data: InvoicePdfData,
  profileId: ZugferdProfileId = DEFAULT_ZUGFERD_PROFILE,
): Promise<{ ok: boolean; xml: string | null; errors: string[]; usedStrictMode: boolean }> {
  const built = await buildZugferdInvoice(data, profileId);
  if (!built.ok) {
    return { ok: false, xml: null, errors: built.errors, usedStrictMode: false };
  }
  const { profile } = await loadZugferd(profileId);
  const xsd = await validateZugferdXsd(built.xml, profile);
  return {
    ok: xsd.ok,
    xml: built.xml,
    errors: xsd.ok ? [] : xsd.errors,
    usedStrictMode: built.usedStrictMode,
  };
}

export async function generateZugferdXml(
  data: InvoicePdfData,
  profile: ZugferdProfileId = DEFAULT_ZUGFERD_PROFILE,
): Promise<string | null> {
  try {
    const built = await buildZugferdInvoice(data, profile);
    if (!built.ok) {
      log(`Validierungsfehler: ${built.errors.join("; ")}`, "ZUGFeRD");
      return null;
    }
    return built.xml;
  } catch (err) {
    log(`Fehler beim Generieren der XML-Daten: ${err}`, "ZUGFeRD");
    return null;
  }
}
