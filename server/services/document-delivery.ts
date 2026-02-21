import { sendEmail } from "./email-service";
import { sendEpostLetter } from "./epost-service";
import { getDocumentPdfBuffer } from "./document-pdf";
import { renderEmailSubject, renderEmailHtml, renderCoverLetterPdf } from "./cover-letter";
import { deliveryStorage } from "../storage/deliveries";
import { storage } from "../storage";
import type { CompanySettings } from "@shared/schema";

interface DeliveryOptions {
  customerId: number;
  generatedDocumentIds: number[];
  deliveryMethod: "email" | "post";
  userId: number;
}

interface DeliveryResult {
  deliveryId: number;
  status: "sent" | "error";
  error?: string;
}

async function getCompanySettings(): Promise<CompanySettings> {
  const settings = await storage.getCompanySettings();
  if (!settings) {
    throw new Error("Firmendaten nicht konfiguriert");
  }
  return settings;
}

export async function deliverDocuments(options: DeliveryOptions): Promise<DeliveryResult> {
  const { customerId, generatedDocumentIds, deliveryMethod, userId } = options;

  const customer = await storage.getCustomer(customerId);
  if (!customer) {
    throw new Error("Kunde nicht gefunden");
  }

  const settings = await getCompanySettings();
  const companyName = settings.companyName || "SeniorenEngel";

  const { documentStorage } = await import("../storage/documents");
  const documents = await Promise.all(
    generatedDocumentIds.map((id) => documentStorage.getGeneratedDocument(id))
  );
  const validDocs = documents.filter(Boolean);

  if (validDocs.length === 0) {
    throw new Error("Keine gültigen Dokumente zum Versenden gefunden");
  }

  const docFileNames = validDocs.map((d) => d!.fileName).join(", ");
  const customerFullName = [customer.vorname, customer.nachname].filter(Boolean).join(" ");

  const delivery = await deliveryStorage.createDelivery({
    customerId,
    generatedDocumentId: validDocs[0]!.id,
    deliveryMethod,
    status: "pending",
    recipientEmail: customer.email || null,
    recipientName: customerFullName,
    recipientAddress: [customer.strasse, customer.nr, customer.plz, customer.stadt].filter(Boolean).join(", "),
    documentFileNames: docFileNames,
    createdByUserId: userId,
  });

  const placeholderData = {
    kundenname: customerFullName,
    vorname: customer.vorname || "",
    nachname: customer.nachname || "",
    firmenname: companyName,
    documentNames: validDocs.map((d) => d!.fileName.replace(/_/g, " ").replace(/\.pdf$/i, "")),
  };

  try {
    if (deliveryMethod === "email") {
      await deliverByEmail(settings, customer, validDocs, placeholderData);
    } else {
      const letterId = await deliverByPost(settings, customer, validDocs, placeholderData);
      await deliveryStorage.updateDeliveryStatus(delivery.id, {
        status: "sent",
        sentAt: new Date(),
        epostLetterId: letterId,
      });
      return { deliveryId: delivery.id, status: "sent" };
    }

    await deliveryStorage.updateDeliveryStatus(delivery.id, {
      status: "sent",
      sentAt: new Date(),
    });

    return { deliveryId: delivery.id, status: "sent" };
  } catch (error: any) {
    await deliveryStorage.updateDeliveryStatus(delivery.id, {
      status: "error",
      errorMessage: error.message || "Unbekannter Fehler",
    });

    return { deliveryId: delivery.id, status: "error", error: error.message };
  }
}

async function deliverByEmail(
  settings: CompanySettings,
  customer: any,
  documents: any[],
  placeholderData: { kundenname: string; vorname: string; nachname: string; firmenname: string; documentNames: string[] }
): Promise<void> {
  if (!customer.email) {
    throw new Error("Keine E-Mail-Adresse beim Kunden hinterlegt");
  }

  const attachments = await Promise.all(
    documents.map(async (doc) => {
      const buffer = await getDocumentPdfBuffer(doc.objectPath);
      return {
        filename: doc.fileName,
        content: buffer,
        contentType: "application/pdf" as const,
      };
    })
  );

  const subject = renderEmailSubject(settings, placeholderData);
  const html = renderEmailHtml(settings, placeholderData);

  await sendEmail(settings, {
    to: customer.email,
    subject,
    html,
    attachments,
  });
}

async function deliverByPost(
  settings: CompanySettings,
  customer: any,
  documents: any[],
  placeholderData: { kundenname: string; vorname: string; nachname: string; firmenname: string; documentNames: string[] }
): Promise<string> {
  if (!customer.strasse || !customer.plz || !customer.stadt) {
    throw new Error("Unvollständige Adresse beim Kunden für Postversand");
  }

  const coverLetterPdf = await renderCoverLetterPdf(settings, placeholderData);

  const documentPdfs = await Promise.all(
    documents.map((doc) => getDocumentPdfBuffer(doc.objectPath))
  );

  const combinedBuffer = await combinePdfBuffers([coverLetterPdf, ...documentPdfs]);

  const senderLine = [settings.companyName, settings.strasse, settings.hausnummer, settings.plz, settings.stadt]
    .filter(Boolean)
    .join(", ");

  const result = await sendEpostLetter(settings, {
    pdfBuffer: combinedBuffer,
    recipientFirstName: customer.vorname || "",
    recipientLastName: customer.nachname || "",
    recipientStreet: customer.strasse,
    recipientHouseNumber: customer.nr || "",
    recipientPostalCode: customer.plz,
    recipientCity: customer.stadt,
    senderLine,
  });

  return result.letterId;
}

async function combinePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
  if (buffers.length === 1) return buffers[0];

  try {
    const { PDFDocument } = await import("pdf-lib");
    const merged = await PDFDocument.create();

    for (const buf of buffers) {
      const doc = await PDFDocument.load(buf);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach((page) => merged.addPage(page));
    }

    const mergedBytes = await merged.save();
    return Buffer.from(mergedBytes);
  } catch (error: any) {
    console.error("PDF-Zusammenführung fehlgeschlagen, sende nur erstes Dokument:", error.message);
    return buffers[0];
  }
}
