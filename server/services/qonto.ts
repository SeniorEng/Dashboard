import { storage } from "../storage";
import { qontoStorage } from "../storage/qonto";
import { invoices, qontoTransactions } from "@shared/schema";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { withAudit } from "../lib/with-audit";
import { resolveMonitoredIbans, normalizeIban } from "@shared/domain/qonto/monitored-ibans";
import { matchesAnyHideRule } from "@shared/domain/qonto/hide-rules";
import { enumerateMonthlyWindows } from "@shared/domain/qonto/backfill-windows";
import {
  resolveUniqueBulkMatch,
  scanAdviceSuggestions,
  BULK_ADVICE_CONFIDENCE,
  type BulkAdviceCandidate,
} from "@shared/domain/qonto/bulk-advice-match";
import {
  classifyPaymentDifference,
  isPaymentFullyCovered,
  PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
} from "@shared/domain/qonto/payment-difference";
import { resolveInvoicePaymentStatus } from "@shared/domain/qonto/invoice-payment-status";

const QONTO_BASE_URL = "https://thirdparty.qonto.com/v2";

interface QontoCredentials {
  login: string;
  secretKey: string;
  /** Primäres Geschäftskonto (Legacy-Feld). Für den Sync über alle Konten
   *  wird stattdessen {@link QontoService.getMonitoredIbans} verwendet. */
  iban: string;
}

export interface QontoAccountStatus {
  iban: string;
  success: boolean;
  error?: string;
}

interface QontoApiTransaction {
  transaction_id: string;
  amount: number;
  amount_cents: number;
  currency: string;
  side: string;
  operation_type: string;
  counterparty: string;
  label: string;
  reference: string;
  emitted_at: string;
  status: string;
}

interface QontoTransactionsResponse {
  transactions: QontoApiTransaction[];
  meta: {
    current_page: number;
    total_pages: number;
    total_count: number;
    per_page: number;
  };
}

class QontoService {
  private async getCredentials(): Promise<QontoCredentials | null> {
    const settings = await storage.getCompanySettings();
    if (!settings.qontoLogin || !settings.qontoSecretKey || !settings.qontoIban) {
      return null;
    }
    return {
      login: settings.qontoLogin,
      secretKey: settings.qontoSecretKey,
      iban: settings.qontoIban,
    };
  }

  /**
   * SSoT für "welche Konten synchronisieren wir?". Liefert die deduplizierte
   * Liste aller überwachten IBANs (primäres Geschäftskonto + weitere IBANs
   * desselben Logins). Sync, testConnection und Status lesen ausschließlich
   * hierüber.
   */
  async getMonitoredIbans(): Promise<string[]> {
    const settings = await storage.getCompanySettings();
    return resolveMonitoredIbans({
      qontoIban: settings.qontoIban,
      qontoAdditionalIbans: settings.qontoAdditionalIbans,
    });
  }

  private async apiRequest<T>(path: string, params?: Record<string, string>): Promise<T> {
    const creds = await this.getCredentials();
    if (!creds) {
      throw new Error("Qonto-Zugangsdaten nicht konfiguriert. Bitte unter Einstellungen hinterlegen.");
    }

    const url = new URL(`${QONTO_BASE_URL}${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const response = await fetch(url.toString(), {
      headers: {
        "Authorization": `${creds.login}:${creds.secretKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401) {
        throw new Error("Qonto-Authentifizierung fehlgeschlagen. Bitte Login und Secret Key prüfen.");
      }
      throw new Error(`Qonto API Fehler (${response.status}): ${body}`);
    }

    return response.json() as Promise<T>;
  }

  async isConfigured(): Promise<boolean> {
    const creds = await this.getCredentials();
    return creds !== null;
  }

  async testConnection(): Promise<{
    success: boolean;
    error?: string;
    bankAccountName?: string;
    accounts?: QontoAccountStatus[];
  }> {
    const creds = await this.getCredentials();
    if (!creds) {
      return { success: false, error: "Zugangsdaten nicht konfiguriert" };
    }

    const ibans = await this.getMonitoredIbans();
    if (ibans.length === 0) {
      return { success: false, error: "Keine IBAN hinterlegt" };
    }

    const accounts: QontoAccountStatus[] = [];
    for (const iban of ibans) {
      try {
        await this.apiRequest<QontoTransactionsResponse>("/transactions", {
          iban,
          per_page: "1",
          status: "completed",
        });
        accounts.push({ iban, success: true });
      } catch (err) {
        accounts.push({
          iban,
          success: false,
          error: err instanceof Error ? err.message : "Verbindung fehlgeschlagen",
        });
      }
    }

    const allOk = accounts.every(a => a.success);
    const okCount = accounts.filter(a => a.success).length;
    const failed = accounts.filter(a => !a.success);

    return {
      success: allOk,
      bankAccountName: ibans.length === 1
        ? `IBAN: ...${ibans[0].slice(-4)}`
        : `${okCount}/${ibans.length} Konten verbunden`,
      error: allOk
        ? undefined
        : `Verbindung fehlgeschlagen für: ${failed.map(a => `...${a.iban.slice(-4)}`).join(", ")}`,
      accounts,
    };
  }

  /**
   * Paginiert die completed-credit-Transaktionen der übergebenen Konten und
   * schreibt sie (idempotent) in den Store. `updatedSince` grenzt inkrementell
   * ein (`updated_at_from`); `null` zieht die vollständige Historie (Backfill).
   * Jede Transaktion wird mit ihrer Quell-IBAN gestempelt.
   */
  private async fetchAndUpsert(
    ibans: string[],
    dateParams: Record<string, string> = {},
  ): Promise<{ synced: number; total: number }> {
    let totalSynced = 0;
    let totalFetched = 0;

    for (const iban of ibans) {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const params: Record<string, string> = {
          iban,
          status: "completed",
          side: "credit",
          per_page: "100",
          page: page.toString(),
          ...dateParams,
        };

        const response = await this.apiRequest<QontoTransactionsResponse>("/transactions", params);

        for (const tx of response.transactions) {
          await qontoStorage.upsertTransaction({
            qontoTransactionId: tx.transaction_id,
            amountCents: tx.amount_cents,
            currency: tx.currency,
            side: tx.side,
            counterpartyName: tx.counterparty || null,
            reference: tx.reference || null,
            label: tx.label || null,
            emittedAt: new Date(tx.emitted_at),
            status: tx.status,
            sourceIban: iban,
            rawData: tx as unknown as Record<string, unknown>,
          });
          totalSynced++;
        }

        totalFetched += response.transactions.length;
        hasMore = page < response.meta.total_pages;
        page++;
      }
    }

    return { synced: totalSynced, total: totalFetched };
  }

  async syncTransactions(): Promise<{ synced: number; total: number; autoHidden: number }> {
    const creds = await this.getCredentials();
    if (!creds) {
      throw new Error("Qonto-Zugangsdaten nicht konfiguriert.");
    }

    const ibans = await this.getMonitoredIbans();
    if (ibans.length === 0) {
      throw new Error("Qonto-Zugangsdaten nicht konfiguriert.");
    }

    // getLastSyncTime bleibt global (ein Sync-Lauf über alle Konten).
    const lastSync = await qontoStorage.getLastSyncTime();
    const dateParams: Record<string, string> = lastSync
      ? { updated_at_from: new Date(lastSync.getTime() - 24 * 60 * 60 * 1000).toISOString() }
      : {};

    // Pro überwachtem Konto paginiert synchronisieren (gleiche Zugangsdaten).
    const result = await this.fetchAndUpsert(ibans, dateParams);
    const autoHidden = await this.applyHideRules();
    return { ...result, autoHidden };
  }

  /**
   * Task #1599 — Datums-basierter Backfill über ALLE überwachten Konten
   * (Primär- + Zusatzkonten): zieht die komplette completed-credit-Historie ab
   * `startDate` monatsweise (`emitted_at_from`/`emitted_at_to`), damit vor einer
   * Konto-Umstellung eingegangene (Fehl-)Überweisungen sicher erfasst und
   * zuordenbar werden. Ersetzt den früheren Zusatzkonten-Voll-Sync. Upserts sind
   * idempotent; das Auto-Matching bleibt unberührt. Nach dem Abruf werden die
   * Auto-Ausblenden-Regeln angewandt.
   */
  async backfillTransactions(
    startDate: Date,
    options?: { ibans?: string[]; testStubHttp?: boolean },
  ): Promise<{ synced: number; total: number; accounts: number; autoHidden: number }> {
    // Task #1721 — NODE_ENV=test-only Kurzschluss: behandelt den Lauf so, als
    // hätte Qonto für jedes Konto eine leere Antwort geliefert, OHNE eine echte
    // ausgehende HTTP-Abfrage und OHNE Abhängigkeit vom (prozess-lokal
    // gecachten) Company-Settings-Zustand des separaten App-Server-Prozesses.
    // Dient EINZIG dem End-to-End-Test der Lock-Freigabe dieser Route über HTTP
    // (der Test-Prozess kann `fetch` des App-Servers nicht stubben). Der Lock
    // wird davon nicht berührt — er wird weiterhin von `withQontoBackfillLock`
    // in der Route erworben/freigegeben. Inert außerhalb von NODE_ENV=test.
    if (options?.testStubHttp === true && process.env.NODE_ENV === "test") {
      const autoHidden = await this.applyHideRules();
      return { synced: 0, total: 0, accounts: 0, autoHidden };
    }

    const creds = await this.getCredentials();
    if (!creds) {
      throw new Error("Qonto-Zugangsdaten nicht konfiguriert.");
    }

    const monitored = await this.getMonitoredIbans();
    if (monitored.length === 0) {
      throw new Error("Qonto-Zugangsdaten nicht konfiguriert.");
    }

    // Task #1717 — Optionaler Fokus auf ein/mehrere Konto(en) (z.B. eine neu
    // ergänzte IBAN). Nur überwachte Konten sind zulässig; unbekannte IBANs
    // werden ignoriert. Ohne `options.ibans` läuft der Backfill wie bisher über
    // ALLE überwachten Konten.
    const focus = options?.ibans;
    const ibans = focus
      ? monitored.filter((m) =>
          focus.some((f) => normalizeIban(f) === normalizeIban(m)),
        )
      : monitored;
    if (ibans.length === 0) {
      throw new Error("Keine überwachte IBAN für den Backfill gefunden.");
    }

    const windows = enumerateMonthlyWindows(startDate, new Date());
    let totalSynced = 0;
    let totalFetched = 0;

    for (const window of windows) {
      const result = await this.fetchAndUpsert(ibans, {
        emitted_at_from: window.from.toISOString(),
        emitted_at_to: window.to.toISOString(),
      });
      totalSynced += result.synced;
      totalFetched += result.total;
    }

    const autoHidden = await this.applyHideRules();
    return { synced: totalSynced, total: totalFetched, accounts: ibans.length, autoHidden };
  }

  /**
   * Task #1599 — wendet die aktiven Auto-Ausblenden-Regeln auf alle offenen,
   * noch nicht ausgeblendeten Zahlungseingänge an (respektiert manuelle
   * „doch relevant"-Overrides). Liefert die Anzahl neu ausgeblendeter
   * Transaktionen. Idempotent — mehrfaches Ausführen blendet nichts doppelt aus.
   */
  async applyHideRules(): Promise<number> {
    const rules = await qontoStorage.getHideRules();
    if (rules.length === 0) return 0;

    const candidates = await qontoStorage.getAutoHideCandidates();
    const toHide = candidates
      .filter((tx) => matchesAnyHideRule(tx, rules))
      .map((tx) => tx.id);

    return qontoStorage.markTransactionsIrrelevantAuto(toHide);
  }

  async autoMatch(userId: number, ipAddress?: string): Promise<{ matched: number; skipped: number }> {
    const unmatched = await qontoStorage.getUnmatchedTransactions();

    // Task #1284 — "avis_erhalten" zählt als offen: ein Qonto-Zahlungseingang
    // darf eine bereits über ein Avis als "avis_erhalten" markierte Rechnung
    // auf "bezahlt" hochstufen.
    const openInvoices = await db.select()
      .from(invoices)
      .where(inArray(invoices.status, ["versendet", "avis_erhalten", "entwurf"]));

    const invoiceByNumber = new Map(openInvoices.map(inv => [inv.invoiceNumber.toLowerCase(), inv]));
    const invoiceByAmount = new Map<number, typeof openInvoices>();

    for (const inv of openInvoices) {
      const key = inv.grossAmountCents;
      if (!invoiceByAmount.has(key)) invoiceByAmount.set(key, []);
      invoiceByAmount.get(key)!.push(inv);
    }

    // Task #1672 — offene Avise (Sammel-Avis-Match). Der Bulk-Strategie-Pfad
    // läuft NACH den Einzelrechnungs-Strategien (Priorität: Rechnungsnummer > Bulk).
    let openAdvices = await qontoStorage.getOpenAdvicesForMatching();

    let matched = 0;
    let skipped = 0;

    for (const qtx of unmatched) {
      const searchText = [qtx.reference, qtx.label, qtx.counterpartyName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      let bestMatch: { invoiceId: number; confidence: string; invoiceGrossCents: number } | null = null;

      for (const [num, inv] of Array.from(invoiceByNumber.entries())) {
        if (searchText.includes(num)) {
          if (Math.abs(qtx.amountCents) === inv.grossAmountCents) {
            bestMatch = { invoiceId: inv.id, confidence: "auto_exact", invoiceGrossCents: inv.grossAmountCents };
            break;
          }
          bestMatch = { invoiceId: inv.id, confidence: "auto_number", invoiceGrossCents: inv.grossAmountCents };
        }
      }

      if (!bestMatch) {
        const amountMatches = invoiceByAmount.get(Math.abs(qtx.amountCents));
        if (amountMatches && amountMatches.length === 1) {
          bestMatch = { invoiceId: amountMatches[0].id, confidence: "auto_amount", invoiceGrossCents: amountMatches[0].grossAmountCents };
        }
      }

      // Task #1788 — Disambiguierung Einzelrechnung vs. Sammel-Avis: Eine
      // Sammelzahlung kann im Verwendungszweck EINE Rechnungsnummer tragen,
      // obwohl sie einen ganzen Sammel-Avis begleicht. Trifft die Einzelrechnung
      // zwar (per Nummer), deckt der Betrag sie aber NICHT voll (Sammelbetrag ≠
      // Einzelbrutto), und es gibt einen Sammel-Avis, dessen Triple-Equality
      // exakt aufgeht ⇒ hat der Avis-Abgleich Vorrang: der ganze Stapel wird
      // „bezahlt", statt die Einzelrechnung nur zu binden und zu flaggen. Reicht
      // KEIN Avis heran, bleibt es beim bisherigen Einzel-Bind+Flag (kein Regress).
      if (bestMatch && openAdvices.length > 0) {
        const matchedInvoiceId = bestMatch.invoiceId;
        const singleInvoiceCovered = isPaymentFullyCovered(
          classifyPaymentDifference({
            invoiceGrossCents: bestMatch.invoiceGrossCents,
            paidCents: Math.abs(qtx.amountCents),
          }),
        );
        if (!singleInvoiceCovered) {
          // Nur Avise, welche die getroffene Einzelrechnung tatsächlich ENTHALTEN,
          // sind Kandidaten: die Zahlung soll GENAU den Sammel-Avis begleichen, zu
          // dem die genannte Rechnung gehört — nicht irgendeinen betragsgleichen
          // Fremd-Avis (der die genannte Rechnung fälschlich offen ließe).
          const memberAdvices = openAdvices.filter(a => a.openInvoiceIds.includes(matchedInvoiceId));
          if (memberAdvices.length > 0) {
            const didBulk = await this.tryBulkAdviceMatch(qtx, memberAdvices, userId, ipAddress);
            if (didBulk) {
              matched++;
              openAdvices = openAdvices.filter(a => a.id !== didBulk.adviceId);
              continue;
            }
          }
          // Kein passender Avis geht triple-equal auf ⇒ Einzel-Bind+Flag unten.
        }
      }

      // Task #1672 — Bulk-Avis-Strategie NACH den Einzelrechnungs-Strategien:
      // nur versuchen, wenn keine Rechnungsnummer/Betrag-Einzelrechnung traf.
      if (!bestMatch && openAdvices.length > 0) {
        const didBulk = await this.tryBulkAdviceMatch(qtx, openAdvices, userId, ipAddress);
        if (didBulk) {
          matched++;
          // in-memory: geschlossenes Avis nicht erneut als Kandidat anbieten.
          openAdvices = openAdvices.filter(a => a.id !== didBulk.adviceId);
        } else {
          skipped++;
        }
        continue;
      }

      if (!bestMatch) {
        skipped++;
        continue;
      }

      const match = bestMatch;

      // Pro Match komplett transaktional: Match-Update mit Guard
      // (matched_invoice_id IS NULL), Invoice-Status-Update mit Guard
      // (status='versendet'), Audit-Log in derselben Transaktion.
      // Wenn ein parallel laufender autoMatch oder manueller Match die
      // Transaktion bereits gebunden hat, springt das geguarded Update
      // auf 0 Zeilen — kein Status-Wechsel, kein Audit (Idempotenz).
      const didMatch = await withAudit(async (dbTx, audit) => {
        const matchUpdate = await dbTx.update(qontoTransactions)
          .set({ matchedInvoiceId: match.invoiceId, matchConfidence: match.confidence })
          .where(and(
            eq(qontoTransactions.id, qtx.id),
            isNull(qontoTransactions.matchedInvoiceId),
            isNull(qontoTransactions.billingIrrelevantAt),
          ))
          .returning({ id: qontoTransactions.id });

        if (matchUpdate.length === 0) {
          return false;
        }

        // Task #1822 — Status aus dem KUMULIERTEN Zahlungsstand ableiten (Σ aller
        // gebundenen Zahlungen inkl. der soeben gebundenen), nicht nur aus dieser
        // einen Transaktion. Unterzahlung ⇒ „teilweise_bezahlt", Volldeckung ⇒
        // „bezahlt", Über-Toleranz-Überzahlung ⇒ nur binden + Mismatch-Flag
        // (nie still als Vollzahlung gebucht).
        const totals = (await qontoStorage.getInvoicePaymentTotals([match.invoiceId], dbTx)).get(match.invoiceId)
          ?? { paidCents: 0, skontoCents: 0 };
        const decision = resolveInvoicePaymentStatus({
          invoiceGrossCents: match.invoiceGrossCents,
          paidCents: totals.paidCents,
          skontoCents: totals.skontoCents,
        });

        if (decision.status === "bezahlt" || decision.status === "teilweise_bezahlt") {
          const nextStatus = decision.status;
          const invoiceUpdate = await dbTx.update(invoices)
            .set(nextStatus === "bezahlt"
              ? { status: "bezahlt", paidAt: qtx.emittedAt }
              : { status: "teilweise_bezahlt" })
            .where(and(
              eq(invoices.id, match.invoiceId),
              inArray(invoices.status, ["versendet", "avis_erhalten", "teilweise_bezahlt"]),
            ))
            .returning({ id: invoices.id });

          if (invoiceUpdate.length === 0) {
            // Invoice wurde parallel storniert/bereits bezahlt — Tx
            // zurückrollen, damit der Match nicht ohne Status-Wechsel
            // committed wird (Audit-Konsistenz).
            throw new Error("INVOICE_STATUS_CHANGED");
          }

          audit.record({
            userId,
            action: nextStatus === "bezahlt" ? "invoice_payment_reconciled" : "invoice_partial_payment",
            entityType: "invoice",
            entityId: match.invoiceId,
            metadata: {
              qontoTransactionId: qtx.id,
              qontoTransactionExternalId: qtx.qontoTransactionId,
              matchedBy: "auto",
              confidence: match.confidence,
              amountCents: qtx.amountCents,
              cumulativePaidCents: totals.paidCents,
              cumulativeSkontoCents: totals.skontoCents,
              invoiceGrossCents: match.invoiceGrossCents,
              differenceCents: decision.classification.differenceCents,
              result: decision.classification.result,
            },
            ipAddress,
          });
        } else {
          // Über-Toleranz-Überzahlung (decision.status === null): Transaktion
          // bleibt an die Rechnung gebunden, aber die Rechnung wird NICHT still
          // auf „bezahlt" gesetzt, sondern nur zur manuellen Prüfung markiert.
          // Seit Task #1788 wird der Sonderfall „Sammelzahlung nennt EINE
          // Rechnungsnummer, begleicht aber einen ganzen Sammel-Avis" bereits
          // oben abgefangen (Avis-Abgleich hat Vorrang); hier landen nur noch
          // echte Überzahlungen — Freigabe nach Prüfung per confirm-paid.
          audit.record({
            userId,
            action: "invoice_payment_mismatch",
            entityType: "invoice",
            entityId: match.invoiceId,
            metadata: {
              qontoTransactionId: qtx.id,
              qontoTransactionExternalId: qtx.qontoTransactionId,
              matchedBy: "auto",
              confidence: match.confidence,
              amountCents: qtx.amountCents,
              paidCents: Math.abs(qtx.amountCents),
              cumulativePaidCents: totals.paidCents,
              invoiceGrossCents: match.invoiceGrossCents,
              differenceCents: decision.classification.differenceCents,
              result: decision.classification.result,
              toleranceCents: PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
            },
            ipAddress,
          });
        }

        return true;
      }).catch((err: unknown) => {
        if (err instanceof Error && err.message === "INVOICE_STATUS_CHANGED") {
          return false;
        }
        throw err;
      });

      if (didMatch) matched++; else skipped++;
    }

    return { matched, skipped };
  }

  /**
   * Task #1672 — versucht, eine Sammelzahlung (Qonto-Credit) genau einem offenen
   * Sammel-Avis zuzuordnen. Triple-Equality + Eindeutigkeits-/Diskriminator-Logik
   * liegen pur in shared/domain (SSoT). Auf Treffer: transaktion → Avis binden
   * (guarded, XOR/billing-irrelevant respektiert), alle offenen Avis-Rechnungen
   * `versendet|avis_erhalten → bezahlt` (guarded), ein Audit je Rechnung + ein
   * Avis-Level-Audit. Idempotent: geguardete Updates greifen auf 0 Zeilen, wenn
   * bereits gebunden/geschlossen. Liefert das getroffene Avis oder null.
   */
  async tryBulkAdviceMatch(
    qtx: Pick<typeof qontoTransactions.$inferSelect,
      "id" | "amountCents" | "emittedAt" | "reference" | "label" | "counterpartyName" | "sourceIban" | "qontoTransactionId">,
    openAdvices: Array<{
      id: number;
      avisNummer: string | null;
      gesamtBetragCents: number | null;
      zahlungsempfaengerIban: string | null;
      openInvoiceIds: number[];
      sumOpenInvoiceCents: number;
    }>,
    userId: number,
    ipAddress?: string,
  ): Promise<{ adviceId: number } | null> {
    const candidates: BulkAdviceCandidate[] = openAdvices.map(a => ({
      adviceId: a.id,
      advice: {
        avisNummer: a.avisNummer,
        gesamtBetragCents: a.gesamtBetragCents,
        zahlungsempfaengerIban: a.zahlungsempfaengerIban,
      },
      sumOpenInvoiceCents: a.sumOpenInvoiceCents,
    }));

    const resolved = resolveUniqueBulkMatch(qtx, Math.abs(qtx.amountCents), candidates);
    if (!resolved) return null;

    const advice = openAdvices.find(a => a.id === resolved.adviceId);
    if (!advice) return null;

    const didMatch = await withAudit(async (dbTx, audit) => {
      const matchUpdate = await dbTx.update(qontoTransactions)
        .set({ matchedPaymentAdviceId: resolved.adviceId, matchConfidence: BULK_ADVICE_CONFIDENCE })
        .where(and(
          eq(qontoTransactions.id, qtx.id),
          isNull(qontoTransactions.matchedInvoiceId),
          isNull(qontoTransactions.matchedPaymentAdviceId),
          isNull(qontoTransactions.billingIrrelevantAt),
        ))
        .returning({ id: qontoTransactions.id });

      if (matchUpdate.length === 0) {
        return false;
      }

      const invoiceUpdate = await dbTx.update(invoices)
        .set({ status: "bezahlt", paidAt: qtx.emittedAt })
        .where(and(
          inArray(invoices.id, advice.openInvoiceIds),
          inArray(invoices.status, ["versendet", "avis_erhalten", "teilweise_bezahlt"]),
        ))
        .returning({ id: invoices.id });

      if (invoiceUpdate.length === 0) {
        // Alle Rechnungen wurden parallel bezahlt/storniert — Match zurückrollen,
        // damit keine Bindung ohne Status-Wechsel committed wird.
        throw new Error("ADVICE_INVOICES_CHANGED");
      }

      for (const row of invoiceUpdate) {
        audit.record({
          userId,
          action: "invoice_payment_reconciled",
          entityType: "invoice",
          entityId: row.id,
          metadata: {
            qontoTransactionId: qtx.id,
            qontoTransactionExternalId: qtx.qontoTransactionId,
            paymentAdviceId: resolved.adviceId,
            matchedBy: "auto",
            confidence: BULK_ADVICE_CONFIDENCE,
            amountCents: qtx.amountCents,
          },
          ipAddress,
        });
      }

      // Avis-Level-Audit (eine Aktion für die Sammel-Zuordnung).
      audit.record({
        userId,
        action: "advice_payment_reconciled",
        entityType: "payment_advice",
        entityId: resolved.adviceId,
        metadata: {
          qontoTransactionId: qtx.id,
          qontoTransactionExternalId: qtx.qontoTransactionId,
          matchedBy: "auto",
          reason: resolved.reason,
          invoiceCount: invoiceUpdate.length,
          amountCents: qtx.amountCents,
        },
        ipAddress,
      });

      return true;
    }).catch((err: unknown) => {
      if (err instanceof Error && err.message === "ADVICE_INVOICES_CHANGED") {
        return false;
      }
      throw err;
    });

    return didMatch ? { adviceId: resolved.adviceId } : null;
  }

  /**
   * Task #1672 — expliziter Confirm-Pfad (Vorschlag „Bestätigen" bzw. manuelles
   * „dieser Zahlung ein Avis zuordnen"): bindet die Transaktion an GENAU das
   * gewählte Avis. Die Triple-Equality bleibt als Sicherheitsnetz erzwungen
   * (der Nutzer wählt aus den betrags-passenden Kandidaten). Liefert das Avis
   * bei Erfolg, sonst null (z.B. Betrag passt nicht (mehr), bereits gebunden).
   */
  async confirmBulkAdviceMatch(
    txId: number,
    adviceId: number,
    userId: number,
    ipAddress?: string,
  ): Promise<{ adviceId: number } | null> {
    const [qtx] = await db.select().from(qontoTransactions).where(eq(qontoTransactions.id, txId));
    if (!qtx) return null;
    if (qtx.matchedInvoiceId || qtx.matchedPaymentAdviceId || qtx.billingIrrelevantAt) return null;

    const openAdvices = await qontoStorage.getOpenAdvicesForMatching();
    const chosen = openAdvices.filter(a => a.id === adviceId);
    if (chosen.length === 0) return null;

    // Nur das gewählte Avis als Kandidat ⇒ resolveUniqueBulkMatch verlangt
    // weiterhin die Triple-Equality (unique_amount), bindet aber gezielt dieses.
    return this.tryBulkAdviceMatch(qtx, chosen, userId, ipAddress);
  }

  /**
   * Task #1672 — Import-Zeit-Auto-Close: direkt nach dem Anlegen eines neuen
   * Sammel-Avis prüfen, ob bereits eine offene Sammelzahlung dazu in Qonto liegt.
   * NUR bei einem starken Signal (Triple-Equality UND Diskriminator: Avis-Nummer
   * im Verwendungszweck ODER passende Empfänger-IBAN) und NUR wenn genau EINE
   * Transaktion stark trifft, wird automatisch gebunden/geschlossen. Sonst nichts
   * (mehrdeutige/schwache Fälle bleiben dem rückwirkenden Vorschlag überlassen).
   * Liefert die getroffene Transaktion oder null.
   */
  async autoCloseAdviceFromTransactions(
    adviceId: number,
    userId: number,
    ipAddress?: string,
  ): Promise<{ adviceId: number; txId: number } | null> {
    const openAdvices = await qontoStorage.getOpenAdvicesForMatching();
    const chosen = openAdvices.find(a => a.id === adviceId);
    if (!chosen) return null;

    const candidate: BulkAdviceCandidate = {
      adviceId: chosen.id,
      advice: {
        avisNummer: chosen.avisNummer,
        gesamtBetragCents: chosen.gesamtBetragCents,
        zahlungsempfaengerIban: chosen.zahlungsempfaengerIban,
      },
      sumOpenInvoiceCents: chosen.sumOpenInvoiceCents,
    };

    const unmatched = await qontoStorage.getUnmatchedTransactions();
    const strongTxs = unmatched.filter(qtx =>
      scanAdviceSuggestions(qtx, Math.abs(qtx.amountCents), [candidate]).some(s => s.strong),
    );

    // Nur bei genau EINER stark passenden Zahlung automatisch schließen.
    if (strongTxs.length !== 1) return null;

    const bound = await this.tryBulkAdviceMatch(strongTxs[0], [chosen], userId, ipAddress);
    return bound ? { adviceId: bound.adviceId, txId: strongTxs[0].id } : null;
  }
}

export const qontoService = new QontoService();
