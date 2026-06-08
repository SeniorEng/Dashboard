import type { InvoicePdfData } from "./pdf-generator";
import { log } from "./log";
import { parseLocalDate, parseTimestamp } from "@shared/utils/datetime";
import { centsToEuroNumber } from "@shared/utils/money";

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
        monetarySummation: { totalAmount: string };
      };
    }[];
    tradeSettlement: {
      currencyCode: string;
      paymentMeans: {
        typeCode: string;
        payeeAccount: { iban: string; accountName?: string };
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

  const lineItems = data.lineItems.map((item, index) => {
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
        monetarySummation: {
          totalAmount: lineTotal,
        },
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

    const pdfResult = Buffer.from(resultPdf);
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
