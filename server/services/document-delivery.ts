import { sendEmail, buildContractEmailHtml } from "./email-service";
import { sendEpostLetter } from "./epost-service";
import { getDocumentPdfBuffer } from "./document-pdf";
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

  try {
    if (deliveryMethod === "email") {
      await deliverByEmail(settings, customer, validDocs, companyName, customerFullName);
    } else {
      const letterId = await deliverByPost(settings, customer, validDocs, companyName);
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
  companyName: string,
  customerFullName: string
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

  const html = buildContractEmailHtml({
    customerName: customerFullName,
    companyName,
    documentNames: documents.map((d) => d.fileName.replace(/_/g, " ").replace(/\.pdf$/i, "")),
    logoUrl: settings.logoUrl,
  });

  await sendEmail(settings, {
    to: customer.email,
    subject: `Ihre Vertragsunterlagen — ${companyName}`,
    html,
    attachments,
  });
}

async function deliverByPost(
  settings: CompanySettings,
  customer: any,
  documents: any[],
  companyName: string
): Promise<string> {
  if (!customer.strasse || !customer.plz || !customer.stadt) {
    throw new Error("Unvollständige Adresse beim Kunden für Postversand");
  }

  const pdfBuffers = await Promise.all(
    documents.map((doc) => getDocumentPdfBuffer(doc.objectPath))
  );

  const combinedBuffer = pdfBuffers.length === 1 ? pdfBuffers[0] : pdfBuffers[0];

  const senderLine = [companyName, settings.strasse, settings.hausnummer, settings.plz, settings.stadt]
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
