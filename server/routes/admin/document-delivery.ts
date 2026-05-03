import { Router, Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { deliverDocuments } from "../../services/document-delivery";
import { testSmtpConnection } from "../../services/email-service";
import { testLetterxpressConnection, checkLetterxpressHealth } from "../../services/letterxpress-service";
import { deliveryStorage } from "../../storage/deliveries";
import { storage } from "../../storage";
import { getCachedCompanySettings } from "../../services/cache";

const router = Router();

function sendDeliveryResult(res: Response, result: { status: string; deliveryId?: number; error?: string }, extra?: Record<string, unknown>) {
  if (result.status === "error") {
    res.status(502).json({
      code: "DELIVERY_ERROR",
      message: result.error || "Versand fehlgeschlagen — bitte prüfen Sie die Versandeinstellungen",
      deliveryId: result.deliveryId,
    });
    return;
  }
  res.json({
    message: "Dokumente erfolgreich versendet",
    deliveryId: result.deliveryId,
    status: result.status,
    ...extra,
  });
}

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

  sendDeliveryResult(res, result);
}));

router.get("/document-delivery/customer/:customerId", asyncHandler("Versandprotokoll konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const deliveries = await deliveryStorage.getDeliveriesByCustomer(customerId);
  res.json(deliveries);
}));

router.get("/document-delivery/recent", asyncHandler("Versandprotokoll konnte nicht geladen werden", async (_req: Request, res: Response) => {
  const deliveries = await deliveryStorage.getRecentDeliveries(100);
  res.json(deliveries);
}));

router.post("/document-delivery/send-for-customer/:customerId", asyncHandler("Versand fehlgeschlagen", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

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
  const pdfDocs = generatedDocs.filter((d) => d.objectPath && d.objectPath.endsWith(".pdf"));

  if (pdfDocs.length === 0) {
    res.json({ skipped: true, message: "Keine PDF-Dokumente zum Versenden vorhanden" });
    return;
  }

  const result = await deliverDocuments({
    customerId,
    generatedDocumentIds: pdfDocs.map((d) => d.id),
    deliveryMethod,
    userId: req.user!.id,
  });

  sendDeliveryResult(res, result, { method: deliveryMethod });
}));

router.post("/document-delivery/test-smtp", asyncHandler("SMTP-Test fehlgeschlagen", async (_req: Request, res: Response) => {
  const settings = await getCachedCompanySettings();
  if (!settings) {
    res.status(400).json({ error: "CONFIG_ERROR", message: "Firmendaten nicht konfiguriert" });
    return;
  }

  const result = await testSmtpConnection(settings);
  res.json(result);
}));

router.post("/document-delivery/test-letterxpress", asyncHandler("LetterXpress-Test fehlgeschlagen", async (_req: Request, res: Response) => {
  const settings = await getCachedCompanySettings();
  if (!settings) {
    res.status(400).json({ error: "CONFIG_ERROR", message: "Firmendaten nicht konfiguriert" });
    return;
  }

  const result = await testLetterxpressConnection(settings);
  res.json(result);
}));

router.get("/document-delivery/letterxpress-health", asyncHandler("LetterXpress Health-Check fehlgeschlagen", async (_req: Request, res: Response) => {
  const result = await checkLetterxpressHealth();
  res.json(result);
}));

export default router;
