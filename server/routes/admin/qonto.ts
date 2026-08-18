import { Router } from "express";
import { requireSuperAdmin } from "../../middleware/auth";
import { asyncHandler, badRequest, notFound, conflict } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { qontoService } from "../../services/qonto";
import { qontoStorage } from "../../storage/qonto";
import { parseAvisCsv, AvisParseUncertainError } from "../../services/avis-parser";
import { parseQontoCsv } from "../../services/qonto-csv-parser";
import { z } from "zod";
import { db, type DbOrTx } from "../../lib/db";
import { invoices, qontoTransactions, paymentAdviceItems, paymentAdvices } from "@shared/schema";
import { eq, and, ilike, isNull, isNotNull, inArray } from "drizzle-orm";
import { withAudit } from "../../lib/with-audit";
import { readTestFaults, readQontoHttpStub } from "../../lib/test-fault-injector";
import { parseLocalDate } from "@shared/utils/datetime";
import { normalizeHideRuleValue } from "@shared/domain/qonto/hide-rules";
import { exceedsBackfillLookbackCap, MAX_BACKFILL_LOOKBACK_MONTHS } from "@shared/domain/qonto/backfill-windows";
import { withQontoBackfillLock, isQontoBackfillRunning } from "../../services/qonto-backfill-runner";
import { scanAdviceSuggestions, MANUAL_BULK_ADVICE_CONFIDENCE } from "@shared/domain/qonto/bulk-advice-match";
import { resolveUniqueMatch } from "@shared/domain/qonto/avis-match";
import {
  classifyPaymentDifference,
  isPaymentFullyCovered,
  PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
} from "@shared/domain/qonto/payment-difference";
import {
  resolveInvoicePaymentStatus,
  type InvoicePaymentStatusResult,
} from "@shared/domain/qonto/invoice-payment-status";
import { AMOUNT_MATCH_REVIEW_CONFIDENCE } from "@shared/domain/qonto/amount-match-guard";
import {
  loadFullyPaidUnlinkedAdvices,
  loadUnmatchedCredits,
  computeProposals,
  applyProposals,
} from "../../../scripts/verify-advice-backfill";
import { updateInvoiceStatusTx, istRechnungNochOffenTx } from "../../storage/billing-storage";
import { statusesAllowedToTransitionTo, statusesAllowedToReverseTo } from "@shared/domain/invoice-status";

const router = Router();
router.use(requireSuperAdmin);

// Task #1284 — Hat eine Rechnung noch eine aktive (nicht soft-deletete) Avis-
// Zuordnung, ist ihr "zurueckgesetzter" Status seit dem Umbau immer
// `versendet`. Wird beim Aufheben einer Zahlungs-Zuordnung (Qonto-Unmatch /
// Avis-Löschen) genutzt, damit eine Rechnung nicht versehentlich an einer noch
// vorhandenen Avis-Zuordnung vorbei auf `versendet` herabfällt.

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
// Task #1591 / #1717 — Serverseitiger Lauf-Lock: Der teure Voll-Abzug darf immer
// nur EINMAL gleichzeitig laufen. Lock-Schlüssel + Erwerb/Freigabe leben jetzt
// zentral in `server/services/qonto-backfill-runner.ts` (geteilt mit dem
// automatischen Backfill neuer IBANs), damit sich manueller und automatischer
// Backfill denselben Lock teilen.

const backfillSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Startdatum (erwartet YYYY-MM-DD)"),
  // Task #1607 — Explizite Zusatz-Bestätigung für „gefährlich große" Läufe,
  // deren Startdatum weiter als MAX_BACKFILL_LOOKBACK_MONTHS zurückreicht.
  acknowledgeExtendedLookback: z.boolean().optional(),
});

router.get("/backfill/status", asyncHandler("Voll-Sync-Status konnte nicht geladen werden", async (_req, res) => {
  res.json({ running: await isQontoBackfillRunning() });
}));

router.post("/backfill", asyncHandler("Qonto-Voll-Sync fehlgeschlagen", async (req, res) => {
  const { startDate, acknowledgeExtendedLookback } = backfillSchema.parse(req.body);
  const parsedStart = parseLocalDate(startDate);

  // Task #1607 — Harte Guardrail gegen versehentliche Mehrjahres-Abzüge: Reicht
  // das Startdatum weiter als MAX_BACKFILL_LOOKBACK_MONTHS zurück, wird der Lauf
  // ohne explizite Zusatz-Bestätigung blockiert (nicht nur gewarnt, Task #1606).
  // Der Frontend-Checkbox-Schutz greift nur in der eigenen Sitzung; dieser
  // Server-Guard schützt auch direkte API-Aufrufe.
  if (exceedsBackfillLookbackCap(parsedStart, new Date()) && !acknowledgeExtendedLookback) {
    throw badRequest(
      `Der gewählte Zeitraum reicht weiter als ${MAX_BACKFILL_LOOKBACK_MONTHS} Monate zurück. Ein so großer Abzug belastet die Qonto-API stark und dauert lange. Bitte wählen Sie ein späteres Startdatum oder bestätigen Sie den erweiterten Zeitraum ausdrücklich.`,
    );
  }

  // Task #1721 — NODE_ENV=test-only Kurzschluss der ausgehenden Qonto-HTTP-
  // Aufrufe, damit die Lock-Freigabe dieser Route end-to-end über HTTP prüfbar
  // ist (der Test-Prozess kann `fetch` des separaten App-Servers nicht stubben).
  const testStubHttp = readQontoHttpStub(req);

  const outcome = await withQontoBackfillLock(async () => {
    const result = await qontoService.backfillTransactions(parsedStart, { testStubHttp });

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

    return result;
  });

  if (!outcome.ran) {
    throw conflict("QONTO_BACKFILL_RUNNING", "Ein Voll-Sync läuft bereits. Bitte warten Sie, bis der aktuelle Abzug abgeschlossen ist.");
  }

  res.json(outcome.result);
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

  // Task #1672 — Sammel-Avis-Anzeige anreichern (Nummer · Rechnungsanzahl · Summe).
  const adviceIds = Array.from(new Set(
    result.transactions.map(t => t.matchedPaymentAdviceId).filter((v): v is number => v !== null),
  ));
  const adviceSummaries = await qontoStorage.getAdviceSummariesByIds(adviceIds);

  // Differenz „gezahlt vs. Forderung" pro zugeordneter Transaktion ableiten
  // (SSoT `classifyPaymentDifference`). Über-Toleranz-Abweichungen bleiben so in
  // der Liste sichtbar, weil die Rechnung dann bewusst NICHT auf „bezahlt"
  // gesetzt, sondern zur Prüfung markiert wurde.
  const grossByTxId = await qontoStorage.getMatchedGrossByTxIds(
    result.transactions.map(t => ({
      id: t.id,
      matchedInvoiceId: t.matchedInvoiceId,
      matchedPaymentAdviceId: t.matchedPaymentAdviceId,
    })),
  );

  // Task #1822: Für 1:1-gebundene Rechnungen den KUMULIERTEN Zahlungsstand über
  // die SSoT `getInvoicePaymentTotals` ermitteln (statt nur diese eine Zahlung),
  // damit mehrere Teilüberweisungen denselben offenen Rest zeigen wie der
  // Invoice-Status. Sammel-Avis-Bindungen behalten die Avis-weite Differenz.
  const singleInvoiceIds = Array.from(new Set(
    result.transactions.map(t => t.matchedInvoiceId).filter((v): v is number => v != null),
  ));
  const paymentTotals = await qontoStorage.getInvoicePaymentTotals(singleInvoiceIds);

  const transactions = result.transactions.map(t => {
    const s = t.matchedPaymentAdviceId ? adviceSummaries.get(t.matchedPaymentAdviceId) : undefined;
    const matchedAdvice = s
      ? { id: s.id, avisNummer: s.avisNummer, invoiceCount: s.invoiceCount, gesamtBetragCents: s.gesamtBetragCents }
      : null;

    const gross = grossByTxId.get(t.id);
    let cls = null;
    if (gross != null) {
      if (t.matchedInvoiceId != null) {
        const tot = paymentTotals.get(t.matchedInvoiceId) ?? { paidCents: 0, skontoCents: 0 };
        cls = classifyPaymentDifference({ invoiceGrossCents: gross, paidCents: tot.paidCents, skontoCents: tot.skontoCents });
      } else {
        cls = classifyPaymentDifference({ invoiceGrossCents: gross, paidCents: Math.abs(t.amountCents) });
      }
    }

    return {
      ...t,
      matchedAdvice,
      matchedGrossCents: gross ?? null,
      paymentDifferenceCents: cls ? cls.differenceCents : null,
      paymentDifferenceResult: cls ? cls.result : null,
    };
  });

  res.json({ ...result, transactions });
}));

// Task #1742 — Transparenz: welche Rechnungen stecken in EINER Zahlung? Deckt
// 1:1- und Sammel-Avis-Zuordnungen ab (manuell wie automatisch). Rein lesend;
// lazy vom Frontend beim Aufklappen einer zugeordneten Zahlung geladen.
router.get("/transactions/:id/matched-invoices", asyncHandler("Zugeordnete Rechnungen konnten nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const result = await qontoStorage.getMatchedInvoicesForTransaction(id);
  if (!result) throw notFound("Transaktion nicht gefunden");

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

  // Rechnung laden (Brutto + Status) für die Betrags-Klassifikation (SSoT).
  const [invoice] = await db.select({
    id: invoices.id,
    grossAmountCents: invoices.grossAmountCents,
    status: invoices.status,
  }).from(invoices).where(eq(invoices.id, invoiceId));
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  let decision!: InvoicePaymentStatusResult;

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

    // Task #1822 — Status aus dem KUMULIERTEN Zahlungsstand ableiten (Σ aller
    // gebundenen Zahlungen inkl. der soeben gebundenen), nicht nur aus dieser
    // einen Transaktion. Erst die Volldeckung setzt „bezahlt"; eine
    // Unterzahlung wechselt den Status NICHT — sie zeigt sich in der
    // Zahlungssumme und im Badge „Teilweise bezahlt".
    const totals = (await qontoStorage.getInvoicePaymentTotals([invoiceId], dbTx)).get(invoiceId)
      ?? { paidCents: 0, skontoCents: 0 };
    decision = resolveInvoicePaymentStatus({
      invoiceGrossCents: invoice.grossAmountCents,
      paidCents: totals.paidCents,
      skontoCents: totals.skontoCents,
    });

    if (decision.status === "bezahlt") {
      // Vollstaendig gedeckt (exakt/tolerierbar). Die zulaessigen
      // Ausgangs-Status kommen aus der Uebergangs-SSoT.
      const invoiceUpdate = await dbTx.update(invoices)
        .set({ status: "bezahlt", paidAt: tx.emittedAt })
        .where(and(
          eq(invoices.id, invoiceId),
          inArray(invoices.status, statusesAllowedToTransitionTo("bezahlt")),
        ))
        .returning({ id: invoices.id });

      if (invoiceUpdate.length === 0) {
        throw badRequest("Rechnung ist nicht in einem offenen Status und kann nicht abgeglichen werden.");
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
          cumulativePaidCents: totals.paidCents,
          cumulativeSkontoCents: totals.skontoCents,
          invoiceGrossCents: invoice.grossAmountCents,
          differenceCents: decision.classification.differenceCents,
          result: decision.classification.result,
        },
        ipAddress: req.ip,
      });
    } else if (decision.classification.result === "underpaid") {
      // Teilzahlung: Zahlung binden, Status NICHT anfassen.
      //
      // ZUERST aber pruefen, ob die Rechnung ueberhaupt noch Geld annehmen darf.
      // Bis zum Status-Umbau erledigte das der Schreibvorgang selbst: das
      // `UPDATE … WHERE status IN (…)` lief auf 0 Zeilen und der Handler warf
      // 400. Mit dem Wegfall des Statuswechsels fiel dieser Schutz hier
      // ersatzlos weg — eine Zahlung liess sich per 200 an eine STORNIERTE
      // Rechnung binden. Derselbe Fehler wie im Auto-Pfad, nur zehn Zeilen
      // daneben und einen Commit spaeter gefunden.
      if (!(await istRechnungNochOffenTx(dbTx, invoiceId))) {
        throw badRequest(
          "Rechnung ist nicht in einem offenen Status und kann nicht abgeglichen werden.",
        );
      }
      //
      // Bis zum Status-Umbau wurde hier `teilweise_bezahlt` geschrieben. Der
      // Status ist entfallen — eine Teilzahlung aendert den Zustand der
      // Rechnung nicht: sie ist weiterhin `versendet` und wartet auf Zahlung,
      // nur eben nicht mehr auf die volle. Sichtbar wird sie ueber das BADGE
      // „Teilweise bezahlt", das sich bei jedem Lesen aus der Zahlungssumme
      // ergibt (`shared/domain/invoice-badges.ts`).
      //
      // Bewusst KEIN Mismatch-Flag — die Unterzahlung ist ein erwarteter
      // Zwischenstand, keine Abweichung. Das bleibt wie vorher.
      //
      // Der Audit-Eintrag bleibt ebenfalls: er haelt fest, DASS eine
      // Teilzahlung gebunden wurde. Genau dafuer ist er da; er beschreibt ein
      // Ereignis, keinen Zustand.
      audit.record({
        userId: req.user!.id,
        action: "invoice_partial_payment",
        entityType: "invoice",
        entityId: invoiceId,
        metadata: {
          qontoTransactionId: id,
          qontoTransactionExternalId: tx.qontoTransactionId,
          matchedBy: "manual",
          confidence: "manual",
          amountCents: tx.amountCents,
          cumulativePaidCents: totals.paidCents,
          cumulativeSkontoCents: totals.skontoCents,
          invoiceGrossCents: invoice.grossAmountCents,
          differenceCents: decision.classification.differenceCents,
          result: decision.classification.result,
        },
        ipAddress: req.ip,
      });
    } else {
      // Auch hier: eine Ueberzahlung ist genauso wenig an eine stornierte
      // Rechnung zu binden wie eine Teilzahlung. Der Guard stand zuerst nur im
      // Unterzahlungs-Zweig, weil dort der Blocker gemeldet war — dieselbe
      // Luecke bestand daneben weiter.
      if (!(await istRechnungNochOffenTx(dbTx, invoiceId))) {
        throw badRequest(
          "Rechnung ist nicht in einem offenen Status und kann nicht abgeglichen werden.",
        );
      }

      // Über-Toleranz-Überzahlung (decision.status === null): Zahlung an die
      // Rechnung binden, aber NICHT still auf „bezahlt" setzen — sie bleibt zur
      // manuellen Prüfung offen (Differenz-Ansicht). Invariante „niemals still
      // bezahlt" (Task #1284).
      audit.record({
        userId: req.user!.id,
        action: "invoice_payment_mismatch",
        entityType: "invoice",
        entityId: invoiceId,
        metadata: {
          qontoTransactionId: id,
          qontoTransactionExternalId: tx.qontoTransactionId,
          matchedBy: "manual",
          confidence: "manual",
          amountCents: tx.amountCents,
          paidCents: Math.abs(tx.amountCents),
          cumulativePaidCents: totals.paidCents,
          invoiceGrossCents: invoice.grossAmountCents,
          differenceCents: decision.classification.differenceCents,
          result: decision.classification.result,
          toleranceCents: PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
        },
        ipAddress: req.ip,
      });
    }

    return matchUpdate[0];
  }, { faults: readTestFaults(req) });

  res.json({
    ...updated,
    invoiceMarkedPaid: decision.status === "bezahlt",
    // Teilzahlung ist kein Status mehr, sondern ein Badge aus der
    // Zahlungssumme. Die Antwort meldet sie weiterhin — sie kommt jetzt aus
    // der Betrags-Klassifikation statt aus einem gesetzten Status.
    invoicePartiallyPaid: decision.classification.result === "underpaid",
    paymentDifferenceCents: decision.classification.differenceCents,
    paymentDifferenceResult: decision.classification.result,
  });
}));

// Task #1710 — Manuelle Mehrfach-Zuordnung: 2+ offene Rechnungen von Hand mit
// EINER Qonto-Zahlung verknüpfen. Wiederverwendet den 1:N-Pfad (ad-hoc
// `format='manuell'`-Avis + Items + `matched_payment_advice_id`); die
// Einzel-Rechnung bleibt auf dem 1:1-`matchedInvoiceId`-Pfad.
const bulkMatchSchema = z.object({
  invoiceIds: z.array(z.number().int().positive("Ungültige Rechnungs-ID"))
    .min(2, "Für eine Mehrfach-Zuordnung müssen mindestens zwei Rechnungen gewählt werden"),
});

router.post("/transactions/:id/bulk-match", asyncHandler("Mehrfach-Zuordnung fehlgeschlagen", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const tx = await qontoStorage.getTransaction(id);
  if (!tx) throw notFound("Transaktion nicht gefunden");

  if (tx.billingIrrelevantAt) {
    throw badRequest("Transaktion ist als nicht abrechnungsrelevant markiert. Bitte zuerst die Markierung aufheben.");
  }

  const parsed = bulkMatchSchema.parse(req.body);
  const invoiceIds = Array.from(new Set(parsed.invoiceIds));
  if (invoiceIds.length < 2) {
    throw badRequest("Für eine Mehrfach-Zuordnung müssen mindestens zwei unterschiedliche Rechnungen gewählt werden.");
  }

  // Idempotenz: ist die Transaktion bereits an ein Sammel-Avis mit exakt
  // derselben Rechnungsmenge gebunden → no-op (keine doppelten Audit-Zeilen).
  if (tx.matchedInvoiceId) {
    throw badRequest("Transaktion ist bereits einer einzelnen Rechnung zugeordnet. Bitte zuerst Zuordnung aufheben.");
  }
  if (tx.matchedPaymentAdviceId) {
    const existing = await qontoStorage.getPaymentAdviceById(tx.matchedPaymentAdviceId);
    const existingIds = new Set(
      (existing?.items ?? [])
        .map(it => it.matchedInvoiceId)
        .filter((v): v is number => v != null),
    );
    const requested = new Set(invoiceIds);
    const sameSet = existingIds.size === requested.size
      && [...requested].every(x => existingIds.has(x));
    if (sameSet) {
      res.json(tx);
      return;
    }
    throw badRequest("Transaktion ist bereits einer Zahlung zugeordnet. Bitte zuerst Zuordnung aufheben.");
  }

  // Ausgewählte Rechnungen laden (Existenz, Brutto, Status, Nummer).
  const selectedInvoices = await db.select({
    id: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
    grossAmountCents: invoices.grossAmountCents,
    status: invoices.status,
  })
    .from(invoices)
    .where(inArray(invoices.id, invoiceIds));

  if (selectedInvoices.length !== invoiceIds.length) {
    throw badRequest("Mindestens eine gewählte Rechnung wurde nicht gefunden.");
  }
  const invoiceById = new Map(selectedInvoices.map(inv => [inv.id, inv]));

  // Σ Brutto der gewählten Rechnungen gegen den Zahlungsbetrag klassifizieren (SSoT).
  const sumGrossCents = selectedInvoices.reduce((s, inv) => s + inv.grossAmountCents, 0);
  const classification = classifyPaymentDifference({
    invoiceGrossCents: sumGrossCents,
    paidCents: Math.abs(tx.amountCents),
  });
  const fullyCovered = isPaymentFullyCovered(classification);

  const emitted = tx.emittedAt instanceof Date ? tx.emittedAt : new Date(tx.emittedAt);
  const zahlungsDatum = emitted.toISOString().slice(0, 10);

  const updated = await withAudit(async (dbTx, audit) => {
    // Doppelzählungs-Guard (innerhalb der Transaktion, vor Item-Insert): keine
    // Rechnung darf bereits 1:1 gematcht oder Mitglied eines aktiven Avis sein.
    const claimed = await qontoStorage.getClaimedInvoiceIds(dbTx, invoiceIds);
    if (claimed.size > 0) {
      throw badRequest("Mindestens eine Rechnung ist bereits einer Zahlung zugeordnet.");
    }

    // Ad-hoc Sammel-Avis (format='manuell') als 1:N-Container erstellen.
    const [advice] = await dbTx.insert(paymentAdvices).values({
      fileName: `Manuelle Sammelzuordnung ${tx.qontoTransactionId}`,
      format: "manuell",
      gesamtBetragCents: Math.abs(tx.amountCents),
      zahlungsDatum,
      notes: "Task #1710 — manuelle Mehrfach-Zuordnung zu einer Qonto-Zahlung",
      uploadedByUserId: req.user!.id,
    }).returning();

    await dbTx.insert(paymentAdviceItems).values(
      invoiceIds.map(invId => {
        const inv = invoiceById.get(invId)!;
        return {
          paymentAdviceId: advice.id,
          rechnungsNummer: inv.invoiceNumber,
          betragCents: inv.grossAmountCents,
          matchedInvoiceId: invId,
        };
      }),
    );

    // Transaktion geguarded ans Avis binden (parallele Zuordnung ausschließen).
    const linkUpdate = await dbTx.update(qontoTransactions)
      .set({ matchedPaymentAdviceId: advice.id, matchConfidence: MANUAL_BULK_ADVICE_CONFIDENCE })
      .where(and(
        eq(qontoTransactions.id, id),
        isNull(qontoTransactions.matchedInvoiceId),
        isNull(qontoTransactions.matchedPaymentAdviceId),
        isNull(qontoTransactions.billingIrrelevantAt),
      ))
      .returning();

    if (linkUpdate.length === 0) {
      throw badRequest("Transaktion wurde zwischenzeitlich zugeordnet.");
    }

    if (fullyCovered) {
      // Rechnungen geguarded auf bezahlt setzen (zulaessige Ausgangs-Status aus der SSoT).
      // Nur, wenn die Σ Brutto zum Zahlungsbetrag passt (exakt oder tolerierbar).
      const flipped = await dbTx.update(invoices)
        .set({ status: "bezahlt", paidAt: emitted })
        .where(and(inArray(invoices.id, invoiceIds), inArray(invoices.status, statusesAllowedToTransitionTo("bezahlt"))))
        .returning({ id: invoices.id });

      if (flipped.length !== invoiceIds.length) {
        throw badRequest("Mindestens eine Rechnung ist nicht in einem offenen Status und kann nicht abgeglichen werden.");
      }

      for (const invId of invoiceIds) {
        audit.record({
          userId: req.user!.id,
          action: "invoice_payment_reconciled",
          entityType: "invoice",
          entityId: invId,
          metadata: {
            qontoTransactionId: id,
            qontoTransactionExternalId: tx.qontoTransactionId,
            paymentAdviceId: advice.id,
            matchedBy: "manual_bulk",
            confidence: MANUAL_BULK_ADVICE_CONFIDENCE,
            amountCents: tx.amountCents,
            differenceCents: classification.differenceCents,
            result: classification.result,
          },
          ipAddress: req.ip,
        });
      }

      audit.record({
        userId: req.user!.id,
        action: "advice_payment_reconciled",
        entityType: "payment_advice",
        entityId: advice.id,
        metadata: {
          qontoTransactionId: id,
          qontoTransactionExternalId: tx.qontoTransactionId,
          confidence: MANUAL_BULK_ADVICE_CONFIDENCE,
          invoiceCount: invoiceIds.length,
          amountCents: tx.amountCents,
          differenceCents: classification.differenceCents,
          result: classification.result,
        },
        ipAddress: req.ip,
      });
    } else {
      // Über-Toleranz-Abweichung (Σ Brutto ≠ Zahlung): Avis + Zahlung binden, aber
      // KEINE Rechnung auf „bezahlt" setzen — die Auswahl bleibt zur manuellen
      // Prüfung offen (Differenz-Ansicht), statt still eine falsche Vollzahlung
      // zu buchen.
      for (const invId of invoiceIds) {
        audit.record({
          userId: req.user!.id,
          action: "invoice_payment_mismatch",
          entityType: "invoice",
          entityId: invId,
          metadata: {
            qontoTransactionId: id,
            qontoTransactionExternalId: tx.qontoTransactionId,
            paymentAdviceId: advice.id,
            matchedBy: "manual_bulk",
            confidence: MANUAL_BULK_ADVICE_CONFIDENCE,
            amountCents: tx.amountCents,
            invoiceGrossSumCents: sumGrossCents,
            differenceCents: classification.differenceCents,
            result: classification.result,
            toleranceCents: PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
          },
          ipAddress: req.ip,
        });
      }

      audit.record({
        userId: req.user!.id,
        action: "advice_payment_mismatch",
        entityType: "payment_advice",
        entityId: advice.id,
        metadata: {
          qontoTransactionId: id,
          qontoTransactionExternalId: tx.qontoTransactionId,
          confidence: MANUAL_BULK_ADVICE_CONFIDENCE,
          invoiceCount: invoiceIds.length,
          amountCents: tx.amountCents,
          invoiceGrossSumCents: sumGrossCents,
          differenceCents: classification.differenceCents,
          result: classification.result,
          toleranceCents: PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
        },
        ipAddress: req.ip,
      });
    }

    return linkUpdate[0];
  }, { faults: readTestFaults(req) });

  res.json({
    ...updated,
    invoiceMarkedPaid: fullyCovered,
    paymentDifferenceCents: classification.differenceCents,
    paymentDifferenceResult: classification.result,
  });
}));

router.delete("/transactions/:id/match", asyncHandler("Zuordnung konnte nicht aufgehoben werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const tx = await qontoStorage.getTransaction(id);
  if (!tx) throw notFound("Transaktion nicht gefunden");

  // Idempotenz: nichts zu lösen → no-op.
  if (!tx.matchedInvoiceId && !tx.matchedPaymentAdviceId) {
    res.json(tx);
    return;
  }

  // Task #1672 — Sammel-Avis-Zuordnung (Sammelzahlung) reversibel aufheben:
  // Bindung an das Avis lösen, alle über das Avis bezahlten offenen Rechnungen
  // `bezahlt → versendet` zuruecksetzen (Avis bleibt bestehen).
  if (tx.matchedPaymentAdviceId) {
    const previousAdviceId = tx.matchedPaymentAdviceId;
    const previousConfidence = tx.matchConfidence;
    // Task #1710 — nur ein ad-hoc erzeugtes Sammel-Zuordnungs-Avis (manuelle
    // Mehrfach-Zuordnung) wird beim Aufheben wieder soft-gelöscht und seine
    // Mitglieder pro Rechnung auf ihren avis-gestützten Vorstatus zurückgesetzt
    // (versendet, sofern nicht noch durch ein anderes Avis gedeckt). Importierte
    // Avise bleiben bestehen; der Status geht auf `versendet` zurueck.
    const isAdHocBulk = previousConfidence === MANUAL_BULK_ADVICE_CONFIDENCE;

    const updated = await withAudit(async (dbTx, audit) => {
      const unmatchUpdate = await dbTx.update(qontoTransactions)
        .set({ matchedPaymentAdviceId: null, matchConfidence: null })
        .where(and(
          eq(qontoTransactions.id, id),
          eq(qontoTransactions.matchedPaymentAdviceId, previousAdviceId),
        ))
        .returning();

      if (unmatchUpdate.length === 0) {
        throw badRequest("Zuordnung wurde zwischenzeitlich verändert.");
      }

      // Die durch diese Sammelzahlung geschlossenen Rechnungen zurückstufen.
      // Nur `bezahlt` herabsetzen (storniert/andere Zustände unangetastet).
      const adviceInvoiceRows = await dbTx.select({ invoiceId: paymentAdviceItems.matchedInvoiceId })
        .from(paymentAdviceItems)
        .where(and(
          eq(paymentAdviceItems.paymentAdviceId, previousAdviceId),
          isNotNull(paymentAdviceItems.matchedInvoiceId),
        ));
      const adviceInvoiceIds = adviceInvoiceRows
        .map(r => r.invoiceId)
        .filter((v): v is number => v !== null);

      // Bei einem ad-hoc Bulk-Avis das Avis soft-loeschen. (Frueher war das
      // noetig, damit die Avis-Deckung beim Zuruecksetzen richtig berechnet
      // wurde — die Berechnung gibt es nicht mehr, das Soft-Loeschen des
      // ad-hoc-Avis bleibt aber richtig: es war nur ein Zuordnungs-Behelf.)
      if (isAdHocBulk) {
        await dbTx.update(paymentAdvices)
          .set({ deletedAt: new Date() })
          .where(and(eq(paymentAdvices.id, previousAdviceId), isNull(paymentAdvices.deletedAt)));
      }

      // Zuruecksetzen fuehrt IMMER nach `versendet`.
      //
      // Vorher wurde hier je Rechnung unterschieden, ob noch eine Avis-Deckung
      // besteht — inklusive einer
      // Schleife mit einer Query je Rechnung. Beides entfaellt: der Avis ist
      // eine Zuordnungs-Mechanik, kein Zustand. Faellt die Zahlung weg, wartet
      // die Rechnung wieder auf Zahlung, ob ein Avis vorliegt oder nicht.
      //
      // Der Avis selbst bleibt unberuehrt bestehen — er ist weiterhin die
      // Zuordnungs-Quelle, nur eben nicht mehr im Status abgebildet.
      const reverted: number[] = [];
      if (adviceInvoiceIds.length > 0) {
        // Ausgangs-Status aus der Ruecknahme-SSoT, nicht hingeschrieben —
        // sonst deklariert `INVOICE_STATUS_REVERSAL_TRANSITIONS` die Regel und
        // dieser Pfad fuehrt sie unabhaengig davon aus.
        const revertUpdate = await dbTx.update(invoices)
          .set({ status: "versendet", paidAt: null })
          .where(and(
            inArray(invoices.id, adviceInvoiceIds),
            inArray(invoices.status, statusesAllowedToReverseTo("versendet")),
          ))
          .returning({ id: invoices.id });
        reverted.push(...revertUpdate.map(r => r.id));
      }

      for (const invId of reverted) {
        audit.record({
          userId: req.user!.id,
          action: "invoice_payment_unreconciled",
          entityType: "invoice",
          entityId: invId,
          metadata: {
            qontoTransactionId: id,
            qontoTransactionExternalId: tx.qontoTransactionId,
            paymentAdviceId: previousAdviceId,
            previousConfidence,
          },
          ipAddress: req.ip,
        });
      }

      audit.record({
        userId: req.user!.id,
        action: "advice_payment_unreconciled",
        entityType: "payment_advice",
        entityId: previousAdviceId,
        metadata: {
          qontoTransactionId: id,
          qontoTransactionExternalId: tx.qontoTransactionId,
          previousConfidence,
          invoiceCount: reverted.length,
        },
        ipAddress: req.ip,
      });

      return unmatchUpdate[0];
    }, { faults: readTestFaults(req) });

    res.json(updated);
    return;
  }

  const previousInvoiceId = tx.matchedInvoiceId!;
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

    // Task #1822 / #1284 — Nach dem Lösen der Zuordnung den Rechnungs-Status aus
    // den VERBLEIBENDEN gebundenen Zahlungen neu ableiten (dieselbe SSoT wie der
    // Match-Schreibpfad: `getInvoicePaymentTotals` + `resolveInvoicePaymentStatus`).
    // So fällt eine teilweise_bezahlte Rechnung nach dem Entfernen ihrer
    // (Teil-)Zahlung korrekt zurück, statt am Status „teilweise_bezahlt" hängen zu
    // bleiben. `versendet`/`storniert` bleiben unangetastet.
    let resultingStatus: string | undefined;
    const [invRow] = await dbTx
      .select({ status: invoices.status, grossAmountCents: invoices.grossAmountCents })
      .from(invoices)
      .where(eq(invoices.id, previousInvoiceId))
      .limit(1);

    // Nur eine als bezahlt gefuehrte Rechnung kann zurueckgesetzt werden.
    // `teilweise_bezahlt` ist als Status entfallen; eine teilbezahlte Rechnung
    // steht ohnehin auf `versendet` und braucht keine Ruecknahme.
    if (invRow && invRow.status === "bezahlt") {
      const remaining = (await qontoStorage.getInvoicePaymentTotals([previousInvoiceId], dbTx))
        .get(previousInvoiceId) ?? { paidCents: 0, skontoCents: 0 };
      const decision = resolveInvoicePaymentStatus({
        invoiceGrossCents: invRow.grossAmountCents,
        paidCents: remaining.paidCents,
        skontoCents: remaining.skontoCents,
      });

      // Beide Zweige fuehren zum selben Zustand: die Rechnung ist nicht mehr
      // voll gedeckt und wartet wieder auf Zahlung. Ob gar nichts mehr gebunden
      // ist oder noch eine Teilzahlung steht, unterscheidet nur das BADGE.
      //
      // Der Statuswechsel geht durch `updateInvoiceStatusTx` — denselben
      // geguardeten Engpass wie der manuelle Weg. Genau das war vorher nicht so:
      // hier stand ein Direkt-Update, das die Uebergangs-SSoT umging.
      if (remaining.paidCents <= 0 || decision.classification.result === "underpaid") {
        resultingStatus = "versendet";
        await updateInvoiceStatusTx(dbTx, previousInvoiceId, "versendet", req.user!.id, {
          // Zahlungs-Ruecknahme: die Bindung wurde geloest, das Geld ist weg.
          // Der einzige Weg, auf dem `bezahlt -> versendet` zulaessig ist.
          zahlungsRuecknahme: true,
        });
        await dbTx.update(invoices)
          .set({ paidAt: null })
          .where(eq(invoices.id, previousInvoiceId));
      }
      // Sonst (weiterhin voll gedeckt / Über-Toleranz-Rest) ⇒ Status unverändert
      // (bleibt „bezahlt"; eine Überzahlung wird separat als Mismatch geflaggt).
    }

    audit.record({
      userId: req.user!.id,
      action: "invoice_payment_unreconciled",
      entityType: "invoice",
      entityId: previousInvoiceId,
      metadata: {
        qontoTransactionId: id,
        qontoTransactionExternalId: tx.qontoTransactionId,
        previousConfidence,
        ...(resultingStatus ? { resultingStatus } : {}),
      },
      ipAddress: req.ip,
    });

    return unmatchUpdate[0];
  }, { faults: readTestFaults(req) });

  res.json(updated);
}));

// Task #1672 — rückwirkende Sammel-Avis-Vorschläge: offene Zahlungseingänge
// (~30 Tage, nicht abgelehnt) gegen offene Avise per Triple-Equality scannen.
// Reine Anzeige — Buchen erst über „Bestätigen" (confirm-Route). Kein Auto-Close.
const ADVICE_SUGGESTION_WINDOW_DAYS = 30;

router.get("/transactions/advice-suggestions", asyncHandler("Vorschläge konnten nicht geladen werden", async (_req, res) => {
  const openAdvices = await qontoStorage.getOpenAdvicesForMatching();
  if (openAdvices.length === 0) {
    res.json({ suggestions: [] });
    return;
  }

  const candidates = openAdvices.map(a => ({
    adviceId: a.id,
    advice: {
      avisNummer: a.avisNummer,
      gesamtBetragCents: a.gesamtBetragCents,
      zahlungsempfaengerIban: a.zahlungsempfaengerIban,
    },
    sumOpenInvoiceCents: a.sumOpenInvoiceCents,
  }));
  const adviceById = new Map(openAdvices.map(a => [a.id, a]));

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - ADVICE_SUGGESTION_WINDOW_DAYS);

  const unmatched = await qontoStorage.getUnmatchedTransactions();
  const suggestions = [];
  for (const qtx of unmatched) {
    if (qtx.adviceSuggestionDismissedAt) continue;
    if (qtx.emittedAt < windowStart) continue;

    const hits = scanAdviceSuggestions(qtx, Math.abs(qtx.amountCents), candidates);
    if (hits.length === 0) continue;

    suggestions.push({
      transactionId: qtx.id,
      candidates: hits.map(h => {
        const a = adviceById.get(h.adviceId)!;
        return {
          adviceId: h.adviceId,
          avisNummer: a.avisNummer,
          invoiceCount: a.openInvoiceIds.length,
          gesamtBetragCents: a.gesamtBetragCents,
          reason: h.reason,
          strong: h.strong,
        };
      }),
    });
  }

  res.json({ suggestions });
}));

const confirmAdviceSchema = z.object({
  adviceId: z.number().int().positive("Ungültige Avis-ID"),
});

// Vorschlag „Bestätigen" bzw. manuelles „dieser Zahlung ein Avis zuordnen":
// bindet die gewählte Transaktion gezielt an das gewählte Avis (Triple-Equality
// bleibt als Sicherheitsnetz erzwungen) und schließt dessen offene Rechnungen.
router.post("/transactions/:id/confirm-advice", asyncHandler("Avis-Zuordnung fehlgeschlagen", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const tx = await qontoStorage.getTransaction(id);
  if (!tx) throw notFound("Transaktion nicht gefunden");
  if (tx.billingIrrelevantAt) {
    throw badRequest("Transaktion ist als nicht abrechnungsrelevant markiert. Bitte zuerst die Markierung aufheben.");
  }
  if (tx.matchedInvoiceId || tx.matchedPaymentAdviceId) {
    throw badRequest("Transaktion ist bereits zugeordnet. Bitte zuerst die Zuordnung aufheben.");
  }

  const { adviceId } = confirmAdviceSchema.parse(req.body);
  const result = await qontoService.confirmBulkAdviceMatch(id, adviceId, req.user!.id, req.ip);
  if (!result) {
    throw badRequest("Zuordnung nicht möglich: Betrag stimmt nicht mit dem Avis-Gesamtbetrag und der Summe der offenen Rechnungen überein (±2 ct).");
  }

  const updated = await qontoStorage.getTransaction(id);
  res.json(updated);
}));

// Differenz bewusst akzeptieren: Eine bereits GEBUNDENE Zahlung mit Über-Toleranz-
// Abweichung (siehe /match & /bulk-match Bind-only-Pfad) wird vom Operator nach
// Prüfung final als „bezahlt" bestätigt. Setzt NUR noch offene, gebundene
// Rechnungen auf bezahlt und protokolliert die akzeptierte Differenz. Ersetzt
// das frühere stille Auto-Setzen bei abweichendem Betrag durch eine explizite
// menschliche Freigabe.
router.post("/transactions/:id/confirm-paid", asyncHandler("Rechnung konnte nicht als bezahlt bestätigt werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const tx = await qontoStorage.getTransaction(id);
  if (!tx) throw notFound("Transaktion nicht gefunden");
  if (!tx.matchedInvoiceId && !tx.matchedPaymentAdviceId) {
    throw badRequest("Transaktion ist keiner Rechnung zugeordnet.");
  }

  // Gebundene Rechnungs-IDs ermitteln (1:1 oder über Sammel-Avis).
  let boundInvoiceIds: number[] = [];
  if (tx.matchedInvoiceId) {
    boundInvoiceIds = [tx.matchedInvoiceId];
  } else if (tx.matchedPaymentAdviceId) {
    const advice = await qontoStorage.getPaymentAdviceById(tx.matchedPaymentAdviceId);
    boundInvoiceIds = Array.from(new Set(
      (advice?.items ?? []).map(i => i.matchedInvoiceId).filter((x): x is number => x != null),
    ));
  }
  if (boundInvoiceIds.length === 0) {
    throw badRequest("Keine zugeordnete Rechnung gefunden.");
  }

  const rows = await db.select({
    id: invoices.id,
    grossAmountCents: invoices.grossAmountCents,
    status: invoices.status,
  }).from(invoices).where(inArray(invoices.id, boundInvoiceIds));
  const sumGrossCents = rows.reduce((s, r) => s + r.grossAmountCents, 0);
  const classification = classifyPaymentDifference({
    invoiceGrossCents: sumGrossCents,
    paidCents: Math.abs(tx.amountCents),
  });

  const emitted = tx.emittedAt instanceof Date ? tx.emittedAt : new Date(tx.emittedAt);

  let paid = 0;
  await withAudit(async (dbTx, audit) => {
    const updatedRows = await dbTx.update(invoices)
      .set({ status: "bezahlt", paidAt: emitted })
      .where(and(
        inArray(invoices.id, boundInvoiceIds),
        inArray(invoices.status, statusesAllowedToTransitionTo("bezahlt")),
      ))
      .returning({ id: invoices.id });

    for (const row of updatedRows) {
      audit.record({
        userId: req.user!.id,
        action: "invoice_payment_difference_accepted",
        entityType: "invoice",
        entityId: row.id,
        metadata: {
          qontoTransactionId: id,
          qontoTransactionExternalId: tx.qontoTransactionId,
          amountCents: tx.amountCents,
          paidCents: Math.abs(tx.amountCents),
          invoiceGrossSumCents: sumGrossCents,
          differenceCents: classification.differenceCents,
          result: classification.result,
        },
        ipAddress: req.ip,
      });
    }
    // Task #1864 — war dies ein reiner Betrags-Treffer im Prüf-Zustand
    // („auto_amount_review"), ist er mit dieser Freigabe bestätigt: Kennzeichen auf
    // „auto_amount" heben, damit die Prüf-Aufforderung im UI verschwindet.
    if (tx.matchConfidence === AMOUNT_MATCH_REVIEW_CONFIDENCE && updatedRows.length > 0) {
      await dbTx.update(qontoTransactions)
        .set({ matchConfidence: "auto_amount" })
        .where(eq(qontoTransactions.id, id));
    }
    paid = updatedRows.length;
  }, { faults: readTestFaults(req) });

  res.json({
    paid,
    paymentDifferenceCents: classification.differenceCents,
    paymentDifferenceResult: classification.result,
  });
}));

// Vorschlag „Ablehnen": denselben rückwirkenden Vorschlag nach dem nächsten
// Sync/Import nicht erneut anbieten. Manuelles Zuordnen bleibt weiter möglich.
router.post("/transactions/:id/dismiss-advice-suggestion", asyncHandler("Vorschlag konnte nicht abgelehnt werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const tx = await qontoStorage.getTransaction(id);
  if (!tx) throw notFound("Transaktion nicht gefunden");

  // Idempotenz: bereits abgelehnt → no-op.
  if (tx.adviceSuggestionDismissedAt) {
    res.json(tx);
    return;
  }

  const updated = await qontoStorage.dismissAdviceSuggestion(id);
  res.json(updated);
}));

// Task #1685 — Mehrdeutige Sammel-Avis ↔ Sammelzahlung-Zuordnungen im Admin-UI
// auflösen. Nutzt EXAKT dieselbe Mehrdeutigkeits-Logik wie der Backfill-Verifier
// (`computeProposals`, SSoT), damit UI und Skript nie auseinanderlaufen: ein Avis
// ist mehrdeutig, wenn mehrere Gutschriften passen (`multiple_credits`) oder seine
// einzige passende Gutschrift von einem weiteren Avis beansprucht wird
// (`credit_collision`). Der Operator sieht je Avis die konkurrierenden Gutschriften
// und wählt die richtige aus.
router.get("/transactions/ambiguous-advices", asyncHandler("Mehrdeutige Zuordnungen konnten nicht geladen werden", async (_req, res) => {
  const [advices, credits] = await Promise.all([
    loadFullyPaidUnlinkedAdvices(),
    loadUnmatchedCredits(),
  ]);
  const { ambiguous } = computeProposals(advices, credits);

  const result = ambiguous.map(entry => ({
    adviceId: entry.advice.id,
    avisNummer: entry.advice.avisNummer,
    adviceAmountCents: entry.advice.gesamtBetragCents,
    adviceIban: entry.advice.zahlungsempfaengerIban,
    kostentraegerName: entry.advice.kostentraegerName,
    anchorDate: entry.advice.anchorDate ? entry.advice.anchorDate.toISOString() : null,
    invoiceCount: entry.advice.invoiceCount,
    reason: entry.reason,
    collidingAdviceIds: entry.collidingAdviceIds,
    candidates: entry.candidates.map(c => ({
      txId: c.txId,
      txAmountCents: c.txAmountCents,
      txEmittedAt: c.txEmittedAt.toISOString(),
      daysDelta: c.daysDelta,
      txCounterpartyName: c.txCounterpartyName,
      txSourceIban: c.txSourceIban,
      nameMatchesAdvisory: c.nameMatchesAdvisory,
    })),
  }));

  res.json({ ambiguous: result });
}));

const resolveAmbiguousSchema = z.object({
  txId: z.number().int().positive("Ungültige Transaktions-ID"),
});

// Auflösen einer mehrdeutigen Zuordnung: der Operator hat für das Avis genau EINE
// der konkurrierenden Gutschriften gewählt. Vor dem Buchen wird die Mehrdeutigkeit
// FRISCH neu berechnet (dieselbe SSoT-Gate wie oben), damit ein veraltetes UI keine
// inzwischen ungültige Paarung schreibt. Das eigentliche Verknüpfen läuft über den
// geteilten, geguardeten & auditierten Backfill-Linker (`applyProposals`) —
// XOR-sicher und idempotent, ein GoBD-Audit je Avis.
router.post("/transactions/ambiguous-advices/:adviceId/resolve", asyncHandler("Zuordnung konnte nicht aufgelöst werden", async (req, res) => {
  const adviceId = requireIntParam(req.params.adviceId, res);
  if (adviceId === null) return;

  const { txId } = resolveAmbiguousSchema.parse(req.body);

  const [advices, credits] = await Promise.all([
    loadFullyPaidUnlinkedAdvices(),
    loadUnmatchedCredits(),
  ]);
  const { ambiguous } = computeProposals(advices, credits);

  const entry = ambiguous.find(a => a.advice.id === adviceId);
  if (!entry) {
    throw badRequest("Dieses Avis ist nicht mehr mehrdeutig (bereits zugeordnet oder keine passende Gutschrift mehr). Bitte die Liste aktualisieren.");
  }

  const candidate = entry.candidates.find(c => c.txId === txId);
  if (!candidate) {
    throw badRequest("Die gewählte Gutschrift passt nicht mehr zu diesem Avis. Bitte die Liste aktualisieren.");
  }

  const reason = `Manuelle Auflösung einer mehrdeutigen Sammel-Avis-Zuordnung im Admin-UI (Grund: ${entry.reason}).`;
  const linked = await applyProposals(
    [{
      advice: entry.advice,
      txId: candidate.txId,
      txAmountCents: candidate.txAmountCents,
      txEmittedAt: candidate.txEmittedAt,
      txCounterpartyName: candidate.txCounterpartyName,
      txSourceIban: candidate.txSourceIban,
      daysDelta: candidate.daysDelta,
      nameMatchesAdvisory: candidate.nameMatchesAdvisory,
    }],
    req.user!.id,
    reason,
  );

  if (linked === 0) {
    throw badRequest("Zuordnung nicht möglich — das Avis oder die Gutschrift wurde zwischenzeitlich anderweitig zugeordnet. Bitte die Liste aktualisieren.");
  }

  res.json({ success: true, adviceId, txId });
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
  items: Array<{ id: number; rechnungsNummer: string | null; betragCents: number }>,
  userId: number,
  ipAddress?: string,
) {
  let matched = 0;
  for (const item of items) {
    const searchNum = item.rechnungsNummer;
    let matchedId: number | null = null;

    if (searchNum) {
      // 1) Exakte Rechnungsnummer (bereits O→0-normalisiert vom Parser).
      const exact = await db.select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.invoiceNumber, searchNum))
        .limit(1);
      if (exact.length > 0) {
        matchedId = exact[0].id;
      } else if (!searchNum.startsWith("RE-") && searchNum.length >= 6) {
        // 2) Tolerante Teilstring-Suche — aber nur bei GENAU EINEM Treffer
        //    (limit 2 ⇒ resolveUniqueMatch verwirft ≥2 als mehrdeutig).
        const fuzzy = await db.select({ id: invoices.id })
          .from(invoices)
          .where(ilike(invoices.invoiceNumber, `%${searchNum}%`))
          .limit(2);
        const unique = resolveUniqueMatch(fuzzy);
        if (unique) matchedId = unique.id;
      }
    }

    // 3) Betrags-Fallback: keine Referenz-Zuordnung ⇒ genau EINE offene Rechnung
    //    (offen laut Uebergangs-SSoT) mit exakt passendem Bruttobetrag.
    if (matchedId === null && item.betragCents > 0) {
      const byAmount = await db.select({ id: invoices.id })
        .from(invoices)
        .where(and(
          eq(invoices.grossAmountCents, item.betragCents),
          inArray(invoices.status, statusesAllowedToTransitionTo("bezahlt")),
        ))
        .limit(2);
      const unique = resolveUniqueMatch(byAmount);
      if (unique) matchedId = unique.id;
    }

    if (matchedId !== null) {
      const invoiceId = matchedId;
      await qontoStorage.updatePaymentAdviceItemMatch(item.id, invoiceId);
      matched++;

      // Der Avis-Treffer aendert den STATUS NICHT mehr.
      //
      // Bis zum Status-Umbau wurde die Rechnung hier von `versendet` auf
      // `avis_erhalten` gehoben. Der Avis ist aber eine ZUORDNUNGS-Mechanik: er
      // verbindet einen angekuendigten Geldeingang mit einer Rechnung, genau
      // wie eine Qonto-Banktransaktion. Bezahlt ist die Rechnung damit nicht,
      // und ihr Zustand aendert sich nicht — sie wartet weiter auf Zahlung.
      //
      // Die ZUORDNUNG selbst bleibt vollstaendig erhalten
      // (`updatePaymentAdviceItemMatch` oben) und mit ihr der Audit-Eintrag:
      // dass ein Avis eine Rechnung getroffen hat, ist ein Ereignis und gehoert
      // protokolliert. Nur der Status hat davon nichts mehr.
      await withAudit(async (_dbTx, audit) => {
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
  // Task #1687 — manuelles Spalten-Mapping (Fallback), wenn die strukturelle
  // Betrags-Erkennung mehrdeutig war (`AvisParseUncertainError` ⇒ 422 ⇒ Dialog).
  columnMap: z.object({
    betrag: z.number().int().nonnegative(),
    referenz: z.number().int().nonnegative().nullable(),
    datum: z.number().int().nonnegative().nullable(),
  }).optional().nullable(),
});

router.post("/payment-advices", asyncHandler("Zahlungsavis konnte nicht gespeichert werden", async (req, res) => {
  const data = paymentAdviceSchema.parse(req.body);

  if (data.csvContent) {
    let parsed;
    try {
      parsed = parseAvisCsv(data.csvContent, { fileName: data.fileName, columnMap: data.columnMap ?? null });
    } catch (err) {
      // Task #1687 — `1;`-Format strukturell nicht eindeutig (Betragsfeld unklar):
      // kein stiller Barmer-Default, sondern Vorschau + Mapping-Vorschlag ans FE.
      if (err instanceof AvisParseUncertainError) {
        return res.status(422).json({
          message: err.message,
          code: "AVIS_PARSE_UNCERTAIN",
          details: {
            avisUncertain: true,
            preview: err.preview,
            suggestedColumnMap: err.suggestedColumnMap,
          },
        });
      }
      throw err;
    }
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
      .filter(i => i.rechnungsNummer || i.betragCents > 0)
      .map(i => ({ id: i.id, rechnungsNummer: i.rechnungsNummer, betragCents: i.betragCents }));
    const matchCount = await autoMatchAvisItems(itemsToMatch, req.user!.id, req.ip);

    // Task #1672 — Import-Zeit-Auto-Close: liegt bereits eine passende Sammel-
    // zahlung in Qonto (starkes Signal, genau eine Transaktion), das Avis direkt
    // schließen und die offenen Rechnungen auf „bezahlt" setzen.
    const bulkClose = await qontoService.autoCloseAdviceFromTransactions(advice.id, req.user!.id, req.ip);

    const refreshed = await qontoStorage.getPaymentAdviceById(advice.id);
    res.json({ advice: refreshed, matched: matchCount, bulkClosed: bulkClose != null });
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
  // und wie viele davon noch offen sind. Das FE blendet
  // den "Als bezahlt markieren"-Button nur ein, wenn offene Treffer existieren.
  const matchedInvoiceIds = Array.from(new Set(
    advices.flatMap(a => a.items.map(i => i.matchedInvoiceId).filter((x): x is number => x != null)),
  ));
  const statusById = new Map<number, string>();
  const grossById = new Map<number, number>();
  if (matchedInvoiceIds.length > 0) {
    const rows = await db.select({ id: invoices.id, status: invoices.status, grossAmountCents: invoices.grossAmountCents })
      .from(invoices)
      .where(inArray(invoices.id, matchedInvoiceIds));
    for (const row of rows) {
      statusById.set(row.id, row.status);
      grossById.set(row.id, row.grossAmountCents);
    }
  }

  // Kürzung/Unter-/Überzahlung für die Kassen-Formate wird am Lesepfad
  // abgeleitet (kein Forderungsfeld in der CSV, kein Schema-Write): pro
  // zugeordneter Position über die SSoT `classifyPaymentDifference`
  // (Rechnungs-Brutto − Skonto − gezahlter Betrag). Ersetzt das frühere
  // `Math.max(0, gross − betrag)`, das Überzahlungen verschluckte und Skonto ignorierte.
  const enriched = advices.map(a => {
    const matchedIds = a.items.map(i => i.matchedInvoiceId).filter((x): x is number => x != null);
    const unpaidMatchedCount = matchedIds.filter(
      id => statusesAllowedToTransitionTo("bezahlt").includes(statusById.get(id) ?? ""),
    ).length;
    const items = a.items.map(i => {
      if (i.matchedInvoiceId == null) {
        return { ...i, matchedInvoiceGrossCents: null, unterzahlungCents: 0, ueberzahlungCents: 0, paymentDifferenceResult: null };
      }
      const gross = grossById.get(i.matchedInvoiceId) ?? null;
      if (gross == null) {
        return { ...i, matchedInvoiceGrossCents: null, unterzahlungCents: 0, ueberzahlungCents: 0, paymentDifferenceResult: null };
      }
      const cls = classifyPaymentDifference({
        invoiceGrossCents: gross,
        paidCents: i.betragCents,
        skontoCents: i.skontoCents ?? 0,
      });
      return {
        ...i,
        matchedInvoiceGrossCents: gross,
        unterzahlungCents: cls.differenceCents > 0 ? cls.differenceCents : 0,
        ueberzahlungCents: cls.differenceCents < 0 ? -cls.differenceCents : 0,
        paymentDifferenceResult: cls.result,
      };
    });
    const unterzahlungCents = items.reduce((sum, i) => sum + i.unterzahlungCents, 0);
    const ueberzahlungCents = items.reduce((sum, i) => sum + i.ueberzahlungCents, 0);
    return { ...a, items, matchedInvoiceCount: matchedIds.length, unpaidMatchedCount, unterzahlungCents, ueberzahlungCents };
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
// noch offenen Rechnungen auf "bezahlt". paidAt kommt
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

  // Brutto je zugeordneter Rechnung laden und pro Avis-Position klassifizieren
  // (SSoT, inkl. Skonto). Nur voll gedeckte Positionen dürfen auf „bezahlt"
  // kippen; gekürzte/über-tolerierte bleiben offen und werden gemeldet.
  const grossById = new Map<number, number>();
  if (matchedInvoiceIds.length > 0) {
    const rows = await db.select({ id: invoices.id, grossAmountCents: invoices.grossAmountCents })
      .from(invoices)
      .where(inArray(invoices.id, matchedInvoiceIds));
    for (const row of rows) grossById.set(row.id, row.grossAmountCents);
  }

  const coveredInvoiceIds = new Set<number>();
  const flagged: { invoiceId: number; differenceCents: number; result: string }[] = [];
  for (const item of advice.items) {
    if (item.matchedInvoiceId == null) continue;
    const gross = grossById.get(item.matchedInvoiceId);
    if (gross == null) continue;
    const cls = classifyPaymentDifference({
      invoiceGrossCents: gross,
      paidCents: item.betragCents,
      skontoCents: item.skontoCents ?? 0,
    });
    if (isPaymentFullyCovered(cls)) {
      coveredInvoiceIds.add(item.matchedInvoiceId);
    } else {
      flagged.push({ invoiceId: item.matchedInvoiceId, differenceCents: cls.differenceCents, result: cls.result });
    }
  }
  const coveredIds = Array.from(coveredInvoiceIds);

  let paid = 0;
  if (coveredIds.length > 0 || flagged.length > 0) {
    await withAudit(async (dbTx, audit) => {
      if (coveredIds.length > 0) {
        const updatedRows = await dbTx.update(invoices)
          .set({ status: "bezahlt", paidAt })
          .where(and(
            inArray(invoices.id, coveredIds),
            inArray(invoices.status, statusesAllowedToTransitionTo("bezahlt")),
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
      }

      // Gekürzte/über-tolerierte Positionen: NICHT bezahlt setzen, sondern zur
      // Prüfung protokollieren (bleiben in der Differenz-Ansicht sichtbar).
      for (const f of flagged) {
        audit.record({
          userId: req.user!.id,
          action: "invoice_payment_mismatch",
          entityType: "invoice",
          entityId: f.invoiceId,
          metadata: {
            paymentAdviceId: id,
            matchedBy: "avis",
            zahlungsDatum: advice.zahlungsDatum,
            differenceCents: f.differenceCents,
            result: f.result,
            toleranceCents: PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
          },
          ipAddress: req.ip,
        });
      }
    }, { faults: readTestFaults(req) });
  }

  res.json({ paid, flagged });
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

    // Das Loeschen eines Avis nimmt keinen Status mehr zurueck — es gibt
    // keinen, den der Avis gesetzt haette. Der Audit-Eintrag bleibt: dass die
    // Zuordnung wegfaellt, ist ein Ereignis.
    for (const invId of matchedInvoiceIds) {
      audit.record({
        userId: req.user!.id,
        action: "invoice_avis_reverted",
        entityType: "invoice",
        entityId: invId,
        metadata: { paymentAdviceId: id, reason: "advice_deleted" },
        ipAddress: req.ip,
      });
    }
  }, { faults: readTestFaults(req) });

  res.json({ success: true });
}));

export default router;
