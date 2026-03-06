import { storage } from "../storage";
import { qontoStorage } from "../storage/qonto";
import { invoices } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../lib/db";

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

  async autoMatch(): Promise<{ matched: number; skipped: number }> {
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

    for (const tx of unmatched) {
      const searchText = [tx.reference, tx.label, tx.counterpartyName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      let bestMatch: { invoiceId: number; confidence: string } | null = null;

      for (const [num, inv] of Array.from(invoiceByNumber.entries())) {
        if (searchText.includes(num)) {
          if (Math.abs(tx.amountCents) === inv.grossAmountCents) {
            bestMatch = { invoiceId: inv.id, confidence: "auto_exact" };
            break;
          }
          bestMatch = { invoiceId: inv.id, confidence: "auto_number" };
        }
      }

      if (!bestMatch) {
        const amountMatches = invoiceByAmount.get(Math.abs(tx.amountCents));
        if (amountMatches && amountMatches.length === 1) {
          bestMatch = { invoiceId: amountMatches[0].id, confidence: "auto_amount" };
        }
      }

      if (bestMatch) {
        await qontoStorage.updateTransactionMatch(tx.id, bestMatch.invoiceId, bestMatch.confidence);

        await db.update(invoices)
          .set({ status: "bezahlt", paidAt: tx.emittedAt })
          .where(and(
            eq(invoices.id, bestMatch.invoiceId),
            eq(invoices.status, "versendet")
          ));

        matched++;
      } else {
        skipped++;
      }
    }

    return { matched, skipped };
  }
}

export const qontoService = new QontoService();
