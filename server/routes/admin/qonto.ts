import { Router } from "express";
import { requireSuperAdmin } from "../../middleware/auth";
import { asyncHandler, badRequest, notFound, conflict } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { qontoService } from "../../services/qonto";
import { qontoStorage } from "../../storage/qonto";
import { parseAvisCsv } from "../../services/avis-parser";
import { parseQontoCsv } from "../../services/qonto-csv-parser";
import { z } from "zod";
import { db, pool, type DbOrTx } from "../../lib/db";
import { invoices, qontoTransactions, paymentAdviceItems, paymentAdvices } from "@shared/schema";
import { eq, and, ilike, isNull, isNotNull, inArray } from "drizzle-orm";
import { withAudit } from "../../lib/with-audit";
import { readTestFaults } from "../../lib/test-fault-injector";
import { parseLocalDate } from "@shared/utils/datetime";
import { normalizeHideRuleValue } from "@shared/domain/qonto/hide-rules";

const router = Router();
router.use(requireSuperAdmin);

// Task #1284 — Hat eine Rechnung noch eine aktive (nicht soft-deletete) Avis-
// Zuordnung, ist ihr "zurückgesetzter" Status `avis_erhalten`, sonst
// `versendet`. Wird beim Aufheben einer Zahlungs-Zuordnung (Qonto-Unmatch /
// Avis-Löschen) genutzt, damit eine Rechnung nicht versehentlich an einer noch
// vorhandenen Avis-Zuordnung vorbei auf `versendet` herabfällt.
async function resolveAvisBackedStatus(
  exec: DbOrTx,
  invoiceId: number,
): Promise<"avis_erhalten" | "versendet"> {
  const rows = await exec
    .select({ id: paymentAdviceItems.id })
    .from(paymentAdviceItems)
    .innerJoin(paymentAdvices, eq(paymentAdviceItems.paymentAdviceId, paymentAdvices.id))
    .where(and(
      eq(paymentAdviceItems.matchedInvoiceId, invoiceId),
      isNull(paymentAdvices.deletedAt),
    ))
    .limit(1);
  return rows.length > 0 ? "avis_erhalten" : "versendet";
}

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

// Task #1599 — Datums-basierter Backfill über ALLE überwachten Konten (Primär-
// + Zusatzkonten) ab einem gewählten Startdatum. Ersetzt den früheren
// Zusatzkonten-Voll-Sync. Zieht die completed-credit-Historie monatsweise,
// wendet danach die Auto-Ausblenden-Regeln an. GoBD-auditiert.
//
// Task #1591 — Serverseitiger Lauf-Lock: Der teure Voll-Abzug darf immer nur
// EINMAL gleichzeitig laufen. Ein session-scoped `pg_try_advisory_lock` auf
// einer dedizierten Pool-Verbindung serialisiert instanzübergreifend. Wird der
// Lock nicht sofort gewährt, läuft bereits ein Voll-Sync → 409 (kein zweiter
// Abzug). Der Frontend-Button-Disable schützt nur die eigene Sitzung; dieser
// Lock schützt gegen parallele Sitzungen / erneutes Öffnen der Seite.
// Fester 32-bit-Schlüssel "QBKF" (Qonto BacKFill).
const QONTO_BACKFILL_LOCK_KEY = String(0x51424b46);

// Task #1600 — Live-Status des Voll-Sync-Lauf-Locks. Prüft (ohne den Lock selbst
// zu erwerben) via pg_locks, ob der advisory Lock aus Task #1591 aktuell von
// irgendeiner Sitzung gehalten wird. Damit kann das Frontend proaktiv (auch in
// anderen Tabs/Sitzungen) „Voll-Sync läuft…" anzeigen und den Start-Button für
// alle sperren, statt erst reaktiv beim 409 zu reagieren.
// pg_try_advisory_lock(bigint) legt den Lock in pg_locks als classid = obere
// 32 Bit, objid = untere 32 Bit ab (objsubid = 1). Der Schlüssel passt in 32
// Bit → classid = 0, objid = Schlüssel. Bewusst ohne BigInt-Literale (tsc-Target).
const QONTO_BACKFILL_LOCK_CLASSID = Math.floor(Number(QONTO_BACKFILL_LOCK_KEY) / 0x100000000);
const QONTO_BACKFILL_LOCK_OBJID = Number(QONTO_BACKFILL_LOCK_KEY) % 0x100000000;

const backfillSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Startdatum (erwartet YYYY-MM-DD)"),
});

router.get("/backfill/status", asyncHandler("Voll-Sync-Status konnte nicht geladen werden", async (_req, res) => {
  const lockRes = await pool.query<{ running: boolean }>(
    `SELECT COUNT(*) > 0 AS running
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = $1
        AND objid = $2
        AND objsubid = 1`,
    [QONTO_BACKFILL_LOCK_CLASSID, QONTO_BACKFILL_LOCK_OBJID],
  );
  res.json({ running: lockRes.rows?.[0]?.running === true });
}));

router.post("/backfill", asyncHandler("Qonto-Voll-Sync fehlgeschlagen", async (req, res) => {
  const { startDate } = backfillSchema.parse(req.body);
  const parsedStart = parseLocalDate(startDate);

  const lockClient = await pool.connect();
  let gotLock = false;
  try {
    const lockRes = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [QONTO_BACKFILL_LOCK_KEY],
    );
    gotLock = lockRes.rows?.[0]?.locked === true;
    if (!gotLock) {
      throw conflict("QONTO_BACKFILL_RUNNING", "Ein Voll-Sync läuft bereits. Bitte warten Sie, bis der aktuelle Abzug abgeschlossen ist.");
    }

    const result = await qontoService.backfillTransactions(parsedStart);

    await withAudit(async (_dbTx, audit) => {
      audit.record({
        userId: req.user!.id,
        action: "qonto_backfill_executed",
        entityType: "qonto_transaction",
        entityId: 0,
        metadata: {
          startDate,
          synced: result.synced,
          total: result.total,
          accounts: result.accounts,
          autoHidden: result.autoHidden,
        },
        ipAddress: req.ip,
      });
    }, { faults: readTestFaults(req) });

    res.json(result);
  } finally {
    try {
      if (gotLock) {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [QONTO_BACKFILL_LOCK_KEY]);
      }
    } finally {
      lockClient.release();
    }
  }
}));

router.get("/transactions", asyncHandler("Transaktionen konnten nicht geladen werden", async (req, res) => {
  const { from, to, matched, limit, offset } = req.query;
  const result = await qontoStorage.getTransactions({
    from: from as string | undefined,
    to: to as string | undefined,
    matched: (matched as "matched" | "unmatched" | "ignored" | "all") || "all",
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

  if (tx.billingIrrelevantAt) {
    throw badRequest("Transaktion ist als nicht abrechnungsrelevant markiert. Bitte zuerst die Markierung aufheben.");
  }

  const { invoiceId } = matchSchema.parse(req.body);

  // Idempotenz: gleiche Transaktion bereits auf dieselbe Rechnung
  // gematcht → no-op, keine doppelte Audit-Zeile.
  if (tx.matchedInvoiceId === invoiceId) {
    res.json(tx);
    return;
  }

  if (tx.matchedInvoiceId && tx.matchedInvoiceId !== invoiceId) {
    throw badRequest("Transaktion ist bereits einer anderen Rechnung zugeordnet. Bitte zuerst Zuordnung aufheben.");
  }

  const updated = await withAudit(async (dbTx, audit) => {
    // Geguarded gegen parallele Matches auf dieselbe Transaktion.
    const matchUpdate = await dbTx.update(qontoTransactions)
      .set({ matchedInvoiceId: invoiceId, matchConfidence: "manual" })
      .where(and(
        eq(qontoTransactions.id, id),
        isNull(qontoTransactions.matchedInvoiceId),
        isNull(qontoTransactions.billingIrrelevantAt),
      ))
      .returning();

    if (matchUpdate.length === 0) {
      throw badRequest("Transaktion wurde zwischenzeitlich einer anderen Rechnung zugeordnet.");
    }

    // Task #1284 — Qonto-Zahlungseingang setzt bezahlt, auch wenn die Rechnung
    // bereits über ein Zahlungsavis auf "avis_erhalten" stand.
    const invoiceUpdate = await dbTx.update(invoices)
      .set({ status: "bezahlt", paidAt: tx.emittedAt })
      .where(and(eq(invoices.id, invoiceId), inArray(invoices.status, ["versendet", "avis_erhalten"])))
      .returning({ id: invoices.id });

    if (invoiceUpdate.length === 0) {
      throw badRequest("Rechnung ist nicht im Status 'versendet' oder 'avis_erhalten' und kann nicht abgeglichen werden.");
    }

    audit.record({
      userId: req.user!.id,
      action: "invoice_payment_reconciled",
      entityType: "invoice",
      entityId: invoiceId,
      metadata: {
        qontoTransactionId: id,
        qontoTransactionExternalId: tx.qontoTransactionId,
        matchedBy: "manual",
        confidence: "manual",
        amountCents: tx.amountCents,
      },
      ipAddress: req.ip,
    });

    return matchUpdate[0];
  }, { faults: readTestFaults(req) });

  res.json(updated);
}));

router.delete("/transactions/:id/match", asyncHandler("Zuordnung konnte nicht aufgehoben werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const tx = await qontoStorage.getTransaction(id);
  if (!tx) throw notFound("Transaktion nicht gefunden");

  // Idempotenz: nichts zu lösen → no-op.
  if (!tx.matchedInvoiceId) {
    res.json(tx);
    return;
  }

  const previousInvoiceId = tx.matchedInvoiceId;
  const previousConfidence = tx.matchConfidence;

  const updated = await withAudit(async (dbTx, audit) => {
    const unmatchUpdate = await dbTx.update(qontoTransactions)
      .set({ matchedInvoiceId: null, matchConfidence: null })
      .where(and(
        eq(qontoTransactions.id, id),
        eq(qontoTransactions.matchedInvoiceId, previousInvoiceId),
      ))
      .returning();

    if (unmatchUpdate.length === 0) {
      throw badRequest("Zuordnung wurde zwischenzeitlich verändert.");
    }

    // Task #1284 — Zurücksetzen darf bezahlt/storniert nicht herabstufen und
    // muss eine noch bestehende Avis-Zuordnung respektieren (→ avis_erhalten).
    const resetStatus = await resolveAvisBackedStatus(dbTx, previousInvoiceId);
    await dbTx.update(invoices)
      .set({ status: resetStatus, paidAt: null })
      .where(and(eq(invoices.id, previousInvoiceId), eq(invoices.status, "bezahlt")));

    audit.record({
      userId: req.user!.id,
      action: "invoice_payment_unreconciled",
      entityType: "invoice",
      entityId: previousInvoiceId,
      metadata: {
        qontoTransactionId: id,
        qontoTransactionExternalId: tx.qontoTransactionId,
        previousConfidence,
      },
      ipAddress: req.ip,
    });

    return unmatchUpdate[0];
  }, { faults: readTestFaults(req) });

  res.json(updated);
}));

// „Nicht abrechnungsrelevant" markieren — Qonto-Eingänge, die keine Rechnung
// betreffen (sonstige Einnahmen/Erstattungen/Kosten), aus dem offenen Abgleich
// UND dem Auto-Abgleich ausblenden. Reversibel (DELETE hebt die Markierung
// wieder auf), GoBD-auditiert. Nur für noch NICHT zugeordnete Transaktionen.
router.post("/transactions/:id/ignore", asyncHandler("Markierung fehlgeschlagen", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const tx = await qontoStorage.getTransaction(id);
  if (!tx) throw notFound("Transaktion nicht gefunden");

  if (tx.side !== "credit") {
    throw badRequest("Nur Zahlungseingänge können als nicht abrechnungsrelevant markiert werden.");
  }

  if (tx.matchedInvoiceId) {
    throw badRequest("Zugeordnete Transaktion kann nicht als nicht abrechnungsrelevant markiert werden. Bitte zuerst die Zuordnung aufheben.");
  }

  // Idempotenz: bereits markiert → no-op, keine doppelte Audit-Zeile.
  if (tx.billingIrrelevantAt) {
    res.json(tx);
    return;
  }

  const updated = await withAudit(async (dbTx, audit) => {
    // Manuelles Ausblenden setzt Quelle 'manual' und LÖSCHT einen etwaigen
    // "doch relevant"-Override: der Nutzer entscheidet sich bewusst fürs
    // Ausblenden.
    const marked = await dbTx.update(qontoTransactions)
      .set({ billingIrrelevantAt: new Date(), billingIrrelevantSource: "manual", billingRelevantOverrideAt: null })
      .where(and(
        eq(qontoTransactions.id, id),
        isNull(qontoTransactions.billingIrrelevantAt),
        isNull(qontoTransactions.matchedInvoiceId),
      ))
      .returning();

    if (marked.length === 0) {
      throw badRequest("Transaktion wurde zwischenzeitlich verändert.");
    }

    audit.record({
      userId: req.user!.id,
      action: "qonto_transaction_marked_irrelevant",
      entityType: "qonto_transaction",
      entityId: id,
      metadata: {
        qontoTransactionExternalId: tx.qontoTransactionId,
        amountCents: tx.amountCents,
        counterpartyName: tx.counterpartyName,
      },
      ipAddress: req.ip,
    });

    return marked[0];
  }, { faults: readTestFaults(req) });

  res.json(updated);
}));

router.delete("/transactions/:id/ignore", asyncHandler("Markierung konnte nicht aufgehoben werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const tx = await qontoStorage.getTransaction(id);
  if (!tx) throw notFound("Transaktion nicht gefunden");

  // Idempotenz: nicht markiert → no-op.
  if (!tx.billingIrrelevantAt) {
    res.json(tx);
    return;
  }

  const updated = await withAudit(async (dbTx, audit) => {
    // Manuelles Wieder-Sichtbarmachen setzt einen dauerhaften Override:
    // Auto-Ausblenden-Regeln dürfen diese bewusste Entscheidung nie erneut
    // überschreiben. Quelle wird zurückgesetzt.
    const cleared = await dbTx.update(qontoTransactions)
      .set({ billingIrrelevantAt: null, billingIrrelevantSource: null, billingRelevantOverrideAt: new Date() })
      .where(and(
        eq(qontoTransactions.id, id),
        isNotNull(qontoTransactions.billingIrrelevantAt),
      ))
      .returning();

    if (cleared.length === 0) {
      throw badRequest("Transaktion wurde zwischenzeitlich verändert.");
    }

    audit.record({
      userId: req.user!.id,
      action: "qonto_transaction_unmarked_irrelevant",
      entityType: "qonto_transaction",
      entityId: id,
      metadata: {
        qontoTransactionExternalId: tx.qontoTransactionId,
      },
      ipAddress: req.ip,
    });

    return cleared[0];
  }, { faults: readTestFaults(req) });

  res.json(updated);
}));

router.post("/auto-match", asyncHandler("Auto-Abgleich fehlgeschlagen", async (req, res) => {
  const result = await qontoService.autoMatch(req.user!.id, req.ip);
  res.json(result);
}));

// Task #1599 — Auto-Ausblenden-Regeln: markieren neu eingehende (und bei
// Regel-Anlage bereits vorhandene, noch offene) Zahlungseingänge automatisch
// als nicht abrechnungsrelevant. Regel-Anlage/-Löschung sind GoBD-auditiert.
router.get("/hide-rules", asyncHandler("Regeln konnten nicht geladen werden", async (_req, res) => {
  const rules = await qontoStorage.getHideRules();
  res.json(rules);
}));

const hideRuleSchema = z.object({
  ruleType: z.enum(["counterparty", "iban"], {
    errorMap: () => ({ message: "Regeltyp muss 'counterparty' oder 'iban' sein." }),
  }),
  value: z.string().trim().min(1, "Wert darf nicht leer sein."),
});

router.post("/hide-rules", asyncHandler("Regel konnte nicht angelegt werden", async (req, res) => {
  const parsed = hideRuleSchema.parse(req.body);
  const value = normalizeHideRuleValue(parsed.ruleType, parsed.value);
  if (!value) {
    throw badRequest("Wert darf nicht leer sein.");
  }

  const rule = await qontoStorage.createHideRule({
    ruleType: parsed.ruleType,
    value,
    createdByUserId: req.user!.id,
  });

  // Regel rückwirkend auf bereits vorhandene offene Transaktionen anwenden.
  const autoHidden = await qontoService.applyHideRules();

  await withAudit(async (_dbTx, audit) => {
    audit.record({
      userId: req.user!.id,
      action: "qonto_hide_rule_created",
      entityType: "qonto_hide_rule",
      entityId: rule.id,
      metadata: { ruleType: rule.ruleType, value: rule.value, autoHidden },
      ipAddress: req.ip,
    });
  }, { faults: readTestFaults(req) });

  res.json({ rule, autoHidden });
}));

router.delete("/hide-rules/:id", asyncHandler("Regel konnte nicht gelöscht werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const deleted = await qontoStorage.deleteHideRule(id);
  if (!deleted) throw notFound("Regel nicht gefunden");

  await withAudit(async (_dbTx, audit) => {
    audit.record({
      userId: req.user!.id,
      action: "qonto_hide_rule_deleted",
      entityType: "qonto_hide_rule",
      entityId: id,
      metadata: { ruleType: deleted.ruleType, value: deleted.value },
      ipAddress: req.ip,
    });
  }, { faults: readTestFaults(req) });

  res.json(deleted);
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

async function autoMatchAvisItems(
  items: Array<{ id: number; rechnungsNummer: string | null }>,
  userId: number,
  ipAddress?: string,
) {
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
      const invoiceId = invoiceRows[0].id;
      await qontoStorage.updatePaymentAdviceItemMatch(item.id, invoiceId);
      matched++;

      // Task #1284 — Avis-Treffer setzt die Rechnung von "versendet" auf
      // "avis_erhalten". Bereits bezahlte/stornierte Rechnungen werden NICHT
      // herabgestuft (Guard auf status='versendet'), audit-protokolliert.
      await withAudit(async (dbTx, audit) => {
        const flipped = await dbTx.update(invoices)
          .set({ status: "avis_erhalten" })
          .where(and(eq(invoices.id, invoiceId), eq(invoices.status, "versendet")))
          .returning({ id: invoices.id });

        if (flipped.length > 0) {
          audit.record({
            userId,
            action: "invoice_avis_received",
            entityType: "invoice",
            entityId: invoiceId,
            metadata: {
              paymentAdviceItemId: item.id,
              rechnungsNummer: searchNum,
              matchedBy: "avis",
            },
            ipAddress,
          });
        }
      });
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
    const matchCount = await autoMatchAvisItems(itemsToMatch, req.user!.id, req.ip);

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

  // Task #1284 — Pro Avis anreichern, wie viele zugeordnete Rechnungen es gibt
  // und wie viele davon noch offen (versendet/avis_erhalten) sind. Das FE blendet
  // den "Als bezahlt markieren"-Button nur ein, wenn offene Treffer existieren.
  const matchedInvoiceIds = Array.from(new Set(
    advices.flatMap(a => a.items.map(i => i.matchedInvoiceId).filter((x): x is number => x != null)),
  ));
  const statusById = new Map<number, string>();
  if (matchedInvoiceIds.length > 0) {
    const rows = await db.select({ id: invoices.id, status: invoices.status })
      .from(invoices)
      .where(inArray(invoices.id, matchedInvoiceIds));
    for (const row of rows) statusById.set(row.id, row.status);
  }

  const enriched = advices.map(a => {
    const matchedIds = a.items.map(i => i.matchedInvoiceId).filter((x): x is number => x != null);
    const unpaidMatchedCount = matchedIds.filter(
      id => statusById.get(id) === "versendet" || statusById.get(id) === "avis_erhalten",
    ).length;
    return { ...a, matchedInvoiceCount: matchedIds.length, unpaidMatchedCount };
  });

  res.json(enriched);
}));

router.get("/payment-advices/:id", asyncHandler("Zahlungsavis konnte nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const advice = await qontoStorage.getPaymentAdviceById(id);
  if (!advice) throw notFound("Zahlungsavis nicht gefunden");
  res.json(advice);
}));

// Task #1284 — "Avis als bezahlt markieren": setzt alle dem Avis zugeordneten,
// noch offenen Rechnungen (versendet/avis_erhalten) auf "bezahlt". paidAt kommt
// aus dem Zahlungsdatum des Avis (Fallback: jetzt). Bereits bezahlte/stornierte
// Rechnungen werden übersprungen (nie herabstufen). GoBD-auditiert.
router.post("/payment-advices/:id/mark-paid", asyncHandler("Avis konnte nicht als bezahlt markiert werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const advice = await qontoStorage.getPaymentAdviceById(id);
  if (!advice) throw notFound("Zahlungsavis nicht gefunden");

  const matchedInvoiceIds = Array.from(new Set(
    advice.items.map(i => i.matchedInvoiceId).filter((x): x is number => x != null),
  ));

  const paidAt = advice.zahlungsDatum ? parseLocalDate(advice.zahlungsDatum) : new Date();

  let paid = 0;
  if (matchedInvoiceIds.length > 0) {
    await withAudit(async (dbTx, audit) => {
      const updatedRows = await dbTx.update(invoices)
        .set({ status: "bezahlt", paidAt })
        .where(and(
          inArray(invoices.id, matchedInvoiceIds),
          inArray(invoices.status, ["versendet", "avis_erhalten"]),
        ))
        .returning({ id: invoices.id });

      for (const row of updatedRows) {
        audit.record({
          userId: req.user!.id,
          action: "invoice_payment_reconciled",
          entityType: "invoice",
          entityId: row.id,
          metadata: {
            paymentAdviceId: id,
            matchedBy: "avis",
            zahlungsDatum: advice.zahlungsDatum,
          },
          ipAddress: req.ip,
        });
      }

      paid = updatedRows.length;
    }, { faults: readTestFaults(req) });
  }

  res.json({ paid });
}));

router.delete("/payment-advices/:id", asyncHandler("Zahlungsavis konnte nicht gelöscht werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const advice = await qontoStorage.getPaymentAdviceById(id);
  if (!advice) throw notFound("Zahlungsavis nicht gefunden");

  const matchedInvoiceIds = Array.from(new Set(
    advice.items.map(i => i.matchedInvoiceId).filter((x): x is number => x != null),
  ));

  await withAudit(async (dbTx, audit) => {
    const deletedRows = await dbTx.update(paymentAdvices)
      .set({ deletedAt: new Date() })
      .where(and(eq(paymentAdvices.id, id), isNull(paymentAdvices.deletedAt)))
      .returning({ id: paymentAdvices.id });

    if (deletedRows.length === 0) {
      throw notFound("Zahlungsavis nicht gefunden");
    }

    // Task #1284 — Löschen eines Avis nimmt den von ihm gesetzten
    // "avis_erhalten"-Status zurück (→ versendet). Bezahlte/stornierte
    // Rechnungen bleiben unangetastet.
    if (matchedInvoiceIds.length > 0) {
      const resetRows = await dbTx.update(invoices)
        .set({ status: "versendet" })
        .where(and(
          inArray(invoices.id, matchedInvoiceIds),
          eq(invoices.status, "avis_erhalten"),
        ))
        .returning({ id: invoices.id });

      for (const row of resetRows) {
        audit.record({
          userId: req.user!.id,
          action: "invoice_avis_reverted",
          entityType: "invoice",
          entityId: row.id,
          metadata: { paymentAdviceId: id, reason: "advice_deleted" },
          ipAddress: req.ip,
        });
      }
    }
  }, { faults: readTestFaults(req) });

  res.json({ success: true });
}));

export default router;
