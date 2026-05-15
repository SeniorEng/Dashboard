import { storage } from "../storage";
import { qontoStorage } from "../storage/qonto";
import { invoices, qontoTransactions } from "@shared/schema";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { withAudit } from "../lib/with-audit";

const QONTO_BASE_URL = "https://thirdparty.qonto.com/v2";

interface QontoCredentials {
  login: string;
  secretKey: string;
  iban: string;
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

  async testConnection(): Promise<{ success: boolean; error?: string; bankAccountName?: string }> {
    try {
      const creds = await this.getCredentials();
      if (!creds) {
        return { success: false, error: "Zugangsdaten nicht konfiguriert" };
      }

      const response = await this.apiRequest<QontoTransactionsResponse>("/transactions", {
        iban: creds.iban,
        per_page: "1",
        status: "completed",
      });

      return {
        success: true,
        bankAccountName: `IBAN: ...${creds.iban.slice(-4)}`,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Verbindung fehlgeschlagen",
      };
    }
  }

  async syncTransactions(): Promise<{ synced: number; total: number }> {
    const creds = await this.getCredentials();
    if (!creds) {
      throw new Error("Qonto-Zugangsdaten nicht konfiguriert.");
    }

    const lastSync = await qontoStorage.getLastSyncTime();

    let page = 1;
    let totalSynced = 0;
    let totalFetched = 0;
    let hasMore = true;

    while (hasMore) {
      const params: Record<string, string> = {
        iban: creds.iban,
        status: "completed",
        side: "credit",
        per_page: "100",
        page: page.toString(),
      };

      if (lastSync) {
        const syncDate = new Date(lastSync.getTime() - 24 * 60 * 60 * 1000);
        params.updated_at_from = syncDate.toISOString();
      }

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
          rawData: tx as unknown as Record<string, unknown>,
        });
        totalSynced++;
      }

      totalFetched += response.transactions.length;
      hasMore = page < response.meta.total_pages;
      page++;
    }

    return { synced: totalSynced, total: totalFetched };
  }

  async autoMatch(userId: number, ipAddress?: string): Promise<{ matched: number; skipped: number }> {
    const unmatched = await qontoStorage.getUnmatchedTransactions();

    const openInvoices = await db.select()
      .from(invoices)
      .where(inArray(invoices.status, ["versendet", "entwurf"]));

    const invoiceByNumber = new Map(openInvoices.map(inv => [inv.invoiceNumber.toLowerCase(), inv]));
    const invoiceByAmount = new Map<number, typeof openInvoices>();

    for (const inv of openInvoices) {
      const key = inv.grossAmountCents;
      if (!invoiceByAmount.has(key)) invoiceByAmount.set(key, []);
      invoiceByAmount.get(key)!.push(inv);
    }

    let matched = 0;
    let skipped = 0;

    for (const qtx of unmatched) {
      const searchText = [qtx.reference, qtx.label, qtx.counterpartyName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      let bestMatch: { invoiceId: number; confidence: string } | null = null;

      for (const [num, inv] of Array.from(invoiceByNumber.entries())) {
        if (searchText.includes(num)) {
          if (Math.abs(qtx.amountCents) === inv.grossAmountCents) {
            bestMatch = { invoiceId: inv.id, confidence: "auto_exact" };
            break;
          }
          bestMatch = { invoiceId: inv.id, confidence: "auto_number" };
        }
      }

      if (!bestMatch) {
        const amountMatches = invoiceByAmount.get(Math.abs(qtx.amountCents));
        if (amountMatches && amountMatches.length === 1) {
          bestMatch = { invoiceId: amountMatches[0].id, confidence: "auto_amount" };
        }
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
          ))
          .returning({ id: qontoTransactions.id });

        if (matchUpdate.length === 0) {
          return false;
        }

        const invoiceUpdate = await dbTx.update(invoices)
          .set({ status: "bezahlt", paidAt: qtx.emittedAt })
          .where(and(
            eq(invoices.id, match.invoiceId),
            eq(invoices.status, "versendet"),
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
          action: "invoice_payment_reconciled",
          entityType: "invoice",
          entityId: match.invoiceId,
          metadata: {
            qontoTransactionId: qtx.id,
            qontoTransactionExternalId: qtx.qontoTransactionId,
            matchedBy: "auto",
            confidence: match.confidence,
            amountCents: qtx.amountCents,
          },
          ipAddress,
        });

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
}

export const qontoService = new QontoService();
