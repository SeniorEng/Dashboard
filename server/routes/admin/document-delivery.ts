import { Router, Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { deliverDocuments } from "../../services/document-delivery";
import { testSmtpConnection } from "../../services/email-service";
import { testEpostConnection, requestSmsCode, setEpostPassword, checkEpostHealthCheck } from "../../services/epost-service";
import { deliveryStorage } from "../../storage/deliveries";
import { storage } from "../../storage";

const router = Router();

const deliverSchema = z.object({
  customerId: z.number(),
  generatedDocumentIds: z.array(z.number()).min(1),
  deliveryMethod: z.enum(["email", "post"]),
});

router.post("/document-delivery/send", asyncHandler("Versand fehlgeschlagen", async (req: Request, res: Response) => {
  const parsed = deliverSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: parsed.error.issues });
    return;
  }

  const result = await deliverDocuments({
    ...parsed.data,
    userId: req.user!.id,
  });

  if (result.status === "error") {
    res.status(500).json({
      error: "DELIVERY_ERROR",
      message: result.error || "Versand fehlgeschlagen",
      deliveryId: result.deliveryId,
    });
    return;
  }

  res.json({
    message: "Dokumente erfolgreich versendet",
    deliveryId: result.deliveryId,
    status: result.status,
  });
}));

router.get("/document-delivery/customer/:customerId", asyncHandler("Versandprotokoll konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.customerId);
  if (isNaN(customerId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }

  const deliveries = await deliveryStorage.getDeliveriesByCustomer(customerId);
  res.json(deliveries);
}));

router.get("/document-delivery/recent", asyncHandler("Versandprotokoll konnte nicht geladen werden", async (_req: Request, res: Response) => {
  const deliveries = await deliveryStorage.getRecentDeliveries(100);
  res.json(deliveries);
}));

router.post("/document-delivery/send-for-customer/:customerId", asyncHandler("Versand fehlgeschlagen", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.customerId);
  if (isNaN(customerId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }

  const customer = await storage.getCustomer(customerId);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  const deliveryMethod = customer.documentDeliveryMethod as "email" | "post" | null;
  if (!deliveryMethod) {
    res.json({ skipped: true, message: "Keine Versandmethode beim Kunden hinterlegt" });
    return;
  }

  const { documentStorage } = await import("../../storage/documents");
  const generatedDocs = await documentStorage.getGeneratedDocuments(customerId);
  const pdfDocs = generatedDocs.filter((d: any) => d.objectPath && d.objectPath.endsWith(".pdf"));

  if (pdfDocs.length === 0) {
    res.json({ skipped: true, message: "Keine PDF-Dokumente zum Versenden vorhanden" });
    return;
  }

  const result = await deliverDocuments({
    customerId,
    generatedDocumentIds: pdfDocs.map((d: any) => d.id),
    deliveryMethod,
    userId: req.user!.id,
  });

  if (result.status === "error") {
    res.status(500).json({
      error: "DELIVERY_ERROR",
      message: result.error || "Versand fehlgeschlagen",
      deliveryId: result.deliveryId,
    });
    return;
  }

  res.json({
    message: "Dokumente erfolgreich versendet",
    deliveryId: result.deliveryId,
    status: result.status,
    method: deliveryMethod,
  });
}));

router.post("/document-delivery/test-smtp", asyncHandler("SMTP-Test fehlgeschlagen", async (_req: Request, res: Response) => {
  const settings = await storage.getCompanySettings();
  if (!settings) {
    res.status(400).json({ error: "CONFIG_ERROR", message: "Firmendaten nicht konfiguriert" });
    return;
  }

  const result = await testSmtpConnection(settings);
  res.json(result);
}));

router.post("/document-delivery/test-epost", asyncHandler("E-POST-Test fehlgeschlagen", async (_req: Request, res: Response) => {
  const settings = await storage.getCompanySettings();
  if (!settings) {
    res.status(400).json({ error: "CONFIG_ERROR", message: "Firmendaten nicht konfiguriert" });
    return;
  }

  const result = await testEpostConnection(settings);
  res.json(result);
}));

router.get("/document-delivery/epost-health", asyncHandler("E-POST Health-Check fehlgeschlagen", async (_req: Request, res: Response) => {
  const result = await checkEpostHealthCheck();
  res.json(result);
}));

router.post("/document-delivery/epost-sms-request", asyncHandler("SMS-Anfrage fehlgeschlagen", async (req: Request, res: Response) => {
  const schema = z.object({
    vendorId: z.string().min(1, "Vendor-ID ist erforderlich"),
    ekp: z.string().length(10, "EKP muss 10 Zeichen lang sein"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message || "Ungültige Daten" });
    return;
  }

  const result = await requestSmsCode(parsed.data.vendorId, parsed.data.ekp);
  res.json(result);
}));

router.post("/document-delivery/epost-set-password", asyncHandler("Passwort setzen fehlgeschlagen", async (req: Request, res: Response) => {
  const schema = z.object({
    vendorId: z.string().min(1, "Vendor-ID ist erforderlich"),
    ekp: z.string().length(10, "EKP muss 10 Zeichen lang sein"),
    newPassword: z.string().min(5, "Passwort muss mindestens 5 Zeichen lang sein").max(100),
    smsCode: z.string().length(6, "SMS-Code muss 6 Zeichen lang sein"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message || "Ungültige Daten" });
    return;
  }

  const result = await setEpostPassword(
    parsed.data.vendorId,
    parsed.data.ekp,
    parsed.data.newPassword,
    parsed.data.smsCode
  );

  if (result.success && result.secret) {
    await storage.updateCompanySettings({
      epostVendorId: parsed.data.vendorId,
      epostEkp: parsed.data.ekp,
      epostPassword: parsed.data.newPassword,
      epostSecret: result.secret,
    }, req.user!.id);
  }

  res.json(result);
}));

export default router;
