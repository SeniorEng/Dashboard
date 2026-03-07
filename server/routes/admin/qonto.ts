import { Router } from "express";
import { requireSuperAdmin } from "../../middleware/auth";
import { asyncHandler, badRequest, notFound } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { qontoService } from "../../services/qonto";
import { qontoStorage } from "../../storage/qonto";
import { parseAvisCsv } from "../../services/avis-parser";
import { parseQontoCsv } from "../../services/qonto-csv-parser";
import { z } from "zod";
import { db } from "../../lib/db";
import { invoices } from "@shared/schema";
import { eq, and, ilike } from "drizzle-orm";

const router = Router();
router.use(requireSuperAdmin);

router.get("/status", asyncHandler("Qonto-Status konnte nicht geladen werden", async (_req, res) => {
  const configured = await qontoService.isConfigured();
  if (!configured) {
    res.json({ configured: false, lastSync: null, connection: null });
    return;
  }
  const lastSync = await qontoStorage.getLastSyncTime();
  const connection = await qontoService.testConnection();
  res.json({ configured: true, lastSync, connection });
}));

router.post("/sync", asyncHandler("Qonto-Synchronisation fehlgeschlagen", async (_req, res) => {
  const result = await qontoService.syncTransactions();
  res.json(result);
}));

router.get("/transactions", asyncHandler("Transaktionen konnten nicht geladen werden", async (req, res) => {
  const { from, to, matched, limit, offset } = req.query;
  const result = await qontoStorage.getTransactions({
    from: from as string | undefined,
    to: to as string | undefined,
    matched: (matched as "matched" | "unmatched" | "all") || "all",
    limit: limit ? parseInt(limit as string) : 50,
    offset: offset ? parseInt(offset as string) : 0,
  });
  res.json(result);
}));

const matchSchema = z.object({
  invoiceId: z.number().int().positive("Ungültige Rechnungs-ID"),
});

router.post("/transactions/:id/match", asyncHandler("Zuordnung fehlgeschlagen", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const tx = await qontoStorage.getTransaction(id);
  if (!tx) throw notFound("Transaktion nicht gefunden");

  const { invoiceId } = matchSchema.parse(req.body);
  const updated = await qontoStorage.updateTransactionMatch(id, invoiceId, "manual");

  await db.update(invoices)
    .set({ status: "bezahlt", paidAt: tx.emittedAt })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.status, "versendet")));

  res.json(updated);
}));

router.delete("/transactions/:id/match", asyncHandler("Zuordnung konnte nicht aufgehoben werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const tx = await qontoStorage.getTransaction(id);
  if (!tx) throw notFound("Transaktion nicht gefunden");

  if (tx.matchedInvoiceId) {
    await db.update(invoices)
      .set({ status: "versendet", paidAt: null })
      .where(eq(invoices.id, tx.matchedInvoiceId));
  }

  const updated = await qontoStorage.updateTransactionMatch(id, null, null);
  res.json(updated);
}));

router.post("/auto-match", asyncHandler("Auto-Abgleich fehlgeschlagen", async (_req, res) => {
  const result = await qontoService.autoMatch();
  res.json(result);
}));

const csvImportSchema = z.object({
  csvContent: z.string().min(1, "CSV-Inhalt fehlt"),
});

router.post("/transactions/import-csv", asyncHandler("CSV-Import fehlgeschlagen", async (req, res) => {
  const { csvContent } = csvImportSchema.parse(req.body);
  const { transactions, skippedRows } = parseQontoCsv(csvContent);

  let imported = 0;
  let updated = 0;

  for (const tx of transactions) {
    const existing = await qontoStorage.getTransactionByQontoId(tx.qontoTransactionId);
    await qontoStorage.upsertTransaction(tx);
    if (existing) {
      updated++;
    } else {
      imported++;
    }
  }

  res.json({ imported, updated, skipped: skippedRows });
}));

async function autoMatchAvisItems(items: Array<{ id: number; rechnungsNummer: string | null }>) {
  let matched = 0;
  for (const item of items) {
    if (!item.rechnungsNummer) continue;

    const searchNum = item.rechnungsNummer;
    let invoiceRows = await db.select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.invoiceNumber, searchNum))
      .limit(1);

    if (invoiceRows.length === 0 && !searchNum.startsWith("RE-") && searchNum.length >= 6) {
      invoiceRows = await db.select({ id: invoices.id })
        .from(invoices)
        .where(ilike(invoices.invoiceNumber, `%${searchNum}%`))
        .limit(1);
    }

    if (invoiceRows.length > 0) {
      await qontoStorage.updatePaymentAdviceItemMatch(item.id, invoiceRows[0].id);
      matched++;
    }
  }
  return matched;
}

const paymentAdviceSchema = z.object({
  insuranceProviderName: z.string().optional().nullable(),
  ikNummer: z.string().optional().nullable(),
  objectPath: z.string().optional().nullable(),
  fileName: z.string().min(1, "Dateiname fehlt"),
  notes: z.string().optional().nullable(),
  csvContent: z.string().optional().nullable(),
  force: z.boolean().optional(),
});

router.post("/payment-advices", asyncHandler("Zahlungsavis konnte nicht gespeichert werden", async (req, res) => {
  const data = paymentAdviceSchema.parse(req.body);

  if (data.csvContent) {
    const parsed = parseAvisCsv(data.csvContent);
    if (parsed.items.length === 0) {
      return res.status(400).json({ message: "CSV enthält keine Positionen" });
    }

    if (!data.force) {
      const existing = await qontoStorage.findDuplicateAdvice(
        data.fileName,
        parsed.header.avisNummer,
        parsed.header.gesamtBetragCents,
        parsed.header.zahlungsDatum,
      );
      if (existing) {
        return res.status(409).json({
          message: "Ein Zahlungsavis mit diesem Dateinamen oder dieser Avisnummer existiert bereits.",
          code: "DUPLICATE_ADVICE",
          details: {
            duplicate: true,
            existingAdvice: {
              id: existing.id,
              fileName: existing.fileName,
              uploadedAt: existing.uploadedAt,
            },
          },
        });
      }
    }

    const advice = await qontoStorage.createPaymentAdviceWithItems(
      {
        fileName: data.fileName,
        objectPath: data.objectPath || null,
        notes: data.notes || null,
        insuranceProviderName: parsed.header.kostentraegerName || data.insuranceProviderName || null,
        ikNummer: parsed.header.kostentraegerIk || data.ikNummer || null,
        format: parsed.header.format,
        avisNummer: parsed.header.avisNummer,
        belegNummer: parsed.header.belegNummer,
        gesamtBetragCents: parsed.header.gesamtBetragCents,
        zahlungsDatum: parsed.header.zahlungsDatum,
        kostentraegerIk: parsed.header.kostentraegerIk,
        kostentraegerName: parsed.header.kostentraegerName,
        zahlungsempfaengerIk: parsed.header.zahlungsempfaengerIk,
        zahlungsempfaengerIban: parsed.header.zahlungsempfaengerIban,
        skontoCents: parsed.header.skontoCents,
        kuerzungCents: parsed.header.kuerzungCents,
        uploadedByUserId: req.user!.id,
      },
      parsed.items.map(item => ({
        belegNr: item.belegNr,
        vorgangsNr: item.vorgangsNr,
        rechnungsNummer: item.rechnungsNummer,
        rechnungsDatum: item.rechnungsDatum,
        verwendungszweck: item.verwendungszweck,
        betragCents: item.betragCents,
        skontoCents: item.skontoCents,
        buchungsDatum: item.buchungsDatum,
        matchedInvoiceId: null,
      }))
    );

    const itemsToMatch = advice.items
      .filter(i => i.rechnungsNummer)
      .map(i => ({ id: i.id, rechnungsNummer: i.rechnungsNummer }));
    const matchCount = await autoMatchAvisItems(itemsToMatch);

    const refreshed = await qontoStorage.getPaymentAdviceById(advice.id);
    res.json({ advice: refreshed, matched: matchCount });
    return;
  }

  if (!data.objectPath) {
    throw badRequest("Dateipfad oder CSV-Inhalt erforderlich");
  }

  if (!data.force) {
    const existing = await qontoStorage.findDuplicateAdvice(data.fileName);
    if (existing) {
      return res.status(409).json({
        message: "Ein Zahlungsavis mit diesem Dateinamen existiert bereits.",
        code: "DUPLICATE_ADVICE",
        details: {
          duplicate: true,
          existingAdvice: {
            id: existing.id,
            fileName: existing.fileName,
            uploadedAt: existing.uploadedAt,
          },
        },
      });
    }
  }

  const advice = await qontoStorage.createPaymentAdvice({
    ...data,
    objectPath: data.objectPath,
    format: "manuell",
    uploadedByUserId: req.user!.id,
  });
  res.json({ advice, matched: 0 });
}));

router.get("/payment-advices", asyncHandler("Zahlungsavise konnten nicht geladen werden", async (_req, res) => {
  const advices = await qontoStorage.getPaymentAdvices();
  res.json(advices);
}));

router.get("/payment-advices/:id", asyncHandler("Zahlungsavis konnte nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const advice = await qontoStorage.getPaymentAdviceById(id);
  if (!advice) throw notFound("Zahlungsavis nicht gefunden");
  res.json(advice);
}));

router.delete("/payment-advices/:id", asyncHandler("Zahlungsavis konnte nicht gelöscht werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const deleted = await qontoStorage.deletePaymentAdvice(id);
  if (!deleted) throw notFound("Zahlungsavis nicht gefunden");
  res.json({ success: true });
}));

export default router;
