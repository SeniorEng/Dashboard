import { useState } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { useUpload } from "@/hooks/use-upload";
import { iconSize, componentStyles } from "@/design-system";
import {
  ArrowLeft,
  RefreshCw,
  Loader2,
  Link2,
  Unlink,
  Upload,
  Trash2,
  Eye,
  CheckCircle2,
  XCircle,
  Zap,
  Landmark,
  FileText,
} from "lucide-react";

interface QontoStatus {
  configured: boolean;
  lastSync: string | null;
  connection: { success: boolean; error?: string; bankAccountName?: string } | null;
}

interface QontoTransaction {
  id: number;
  qontoTransactionId: string;
  amountCents: number;
  currency: string;
  side: string;
  counterpartyName: string | null;
  reference: string | null;
  label: string | null;
  emittedAt: string;
  status: string;
  matchedInvoiceId: number | null;
  matchConfidence: string | null;
}

interface Invoice {
  id: number;
  invoiceNumber: string;
  customerName: string | null;
  grossAmountCents: number;
  status: string;
}

interface PaymentAdvice {
  id: number;
  insuranceProviderName: string | null;
  ikNummer: string | null;
  objectPath: string;
  fileName: string;
  notes: string | null;
  uploadedAt: string;
}

type Tab = "status" | "transactions" | "advices";

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",") + " €";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function AdminQonto() {
  const [tab, setTab] = useState<Tab>("status");
  const [matchFilter, setMatchFilter] = useState<"all" | "matched" | "unmatched">("all");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const statusQuery = useQuery<QontoStatus>({
    queryKey: ["qonto", "status"],
    queryFn: async () => unwrapResult(await api.get("/admin/qonto/status")),
    staleTime: 30000,
  });

  const tabs: { id: Tab; label: string }[] = [
    { id: "status", label: "Verbindung" },
    { id: "transactions", label: "Transaktionen" },
    { id: "advices", label: "Avise" },
  ];

  return (
    <Layout variant="admin">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/admin">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div>
          <h1 className={componentStyles.pageTitle}>Zahlungen & Qonto</h1>
          <p className="text-sm text-gray-600">Zahlungseingänge, Rechnungsabgleich und Avise</p>
        </div>
      </div>

      <div className="flex gap-1.5 mb-6">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id
                ? "bg-teal-50 text-teal-700 border border-teal-200"
                : "bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100"
            }`}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "status" && <StatusTab status={statusQuery.data} isLoading={statusQuery.isLoading} />}
      {tab === "transactions" && (
        <TransactionsTab
          configured={statusQuery.data?.configured ?? false}
          matchFilter={matchFilter}
          onFilterChange={setMatchFilter}
        />
      )}
      {tab === "advices" && <AdvicesTab />}
    </Layout>
  );
}

function StatusTab({ status, isLoading }: { status?: QontoStatus; isLoading: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const syncMutation = useMutation({
    mutationFn: async () => unwrapResult(await api.post<{ synced: number }>("/admin/qonto/sync", {})),
    onSuccess: (data) => {
      toast({ title: `${data.synced} Transaktionen synchronisiert` });
      queryClient.invalidateQueries({ queryKey: ["qonto"] });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
      </div>
    );
  }

  const configured = status?.configured ?? false;
  const connected = status?.connection?.success ?? false;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Landmark className={iconSize.sm} />
            Verbindungsstatus
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!configured ? (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <XCircle className={`${iconSize.sm} text-amber-600 shrink-0 mt-0.5`} />
              <div>
                <p className="text-sm font-medium text-amber-800">Nicht konfiguriert</p>
                <p className="text-xs text-amber-700 mt-1">
                  Bitte hinterlegen Sie die Qonto-Zugangsdaten unter Einstellungen → Qonto-Verbindung (Login, Secret Key und IBAN).
                </p>
              </div>
            </div>
          ) : connected ? (
            <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
              <CheckCircle2 className={`${iconSize.sm} text-green-600 shrink-0 mt-0.5`} />
              <div>
                <p className="text-sm font-medium text-green-800">Verbunden</p>
                {status?.connection?.bankAccountName && (
                  <p className="text-xs text-green-700 mt-1">{status.connection.bankAccountName}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
              <XCircle className={`${iconSize.sm} text-red-600 shrink-0 mt-0.5`} />
              <div>
                <p className="text-sm font-medium text-red-800">Verbindung fehlgeschlagen</p>
                <p className="text-xs text-red-700 mt-1">{status?.connection?.error}</p>
              </div>
            </div>
          )}

          {status?.lastSync && (
            <p className="text-xs text-gray-500">
              Letzter Sync: {formatDate(status.lastSync)} um {new Date(status.lastSync).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
            </p>
          )}

          {configured && (
            <Button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="w-full sm:w-auto"
              data-testid="button-sync"
            >
              {syncMutation.isPending ? (
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
              ) : (
                <RefreshCw className={`${iconSize.sm} mr-2`} />
              )}
              Jetzt synchronisieren
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TransactionsTab({
  configured,
  matchFilter,
  onFilterChange,
}: {
  configured: boolean;
  matchFilter: "all" | "matched" | "unmatched";
  onFilterChange: (v: "all" | "matched" | "unmatched") => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [matchingTxId, setMatchingTxId] = useState<number | null>(null);

  const transactionsQuery = useQuery<{ transactions: QontoTransaction[]; total: number }>({
    queryKey: ["qonto", "transactions", matchFilter],
    queryFn: async () => unwrapResult(await api.get(`/admin/qonto/transactions?matched=${matchFilter}&limit=100`)),
    enabled: configured,
    staleTime: 15000,
  });

  const invoicesQuery = useQuery<Invoice[]>({
    queryKey: ["billing", "open-for-match"],
    queryFn: async () => {
      const result = await api.get<Invoice[]>("/billing?status=versendet");
      return unwrapResult(result);
    },
    enabled: matchingTxId !== null,
  });

  const matchMutation = useMutation({
    mutationFn: async ({ txId, invoiceId }: { txId: number; invoiceId: number }) =>
      unwrapResult(await api.post(`/admin/qonto/transactions/${txId}/match`, { invoiceId })),
    onSuccess: () => {
      toast({ title: "Zuordnung gespeichert" });
      setMatchingTxId(null);
      queryClient.invalidateQueries({ queryKey: ["qonto"] });
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const unmatchMutation = useMutation({
    mutationFn: async (txId: number) =>
      unwrapResult(await api.delete(`/admin/qonto/transactions/${txId}/match`)),
    onSuccess: () => {
      toast({ title: "Zuordnung aufgehoben" });
      queryClient.invalidateQueries({ queryKey: ["qonto"] });
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const autoMatchMutation = useMutation({
    mutationFn: async () => unwrapResult(await api.post<{ matched: number; skipped: number }>("/admin/qonto/auto-match", {})),
    onSuccess: (data) => {
      toast({ title: `Auto-Abgleich: ${data.matched} zugeordnet, ${data.skipped} ohne Treffer` });
      queryClient.invalidateQueries({ queryKey: ["qonto"] });
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  if (!configured) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-gray-500">
          Bitte zuerst die Qonto-Verbindung einrichten.
        </CardContent>
      </Card>
    );
  }

  const transactions = transactionsQuery.data?.transactions ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <Select value={matchFilter} onValueChange={v => onFilterChange(v as typeof matchFilter)}>
          <SelectTrigger className="w-[200px]" data-testid="select-match-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Transaktionen</SelectItem>
            <SelectItem value="unmatched">Offen (ohne Zuordnung)</SelectItem>
            <SelectItem value="matched">Zugeordnet</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          onClick={() => autoMatchMutation.mutate()}
          disabled={autoMatchMutation.isPending}
          data-testid="button-auto-match"
        >
          {autoMatchMutation.isPending ? (
            <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
          ) : (
            <Zap className={`${iconSize.sm} mr-2`} />
          )}
          Auto-Abgleich
        </Button>
      </div>

      {transactionsQuery.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : transactions.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-gray-500">
            Keine Transaktionen gefunden. Bitte zuerst synchronisieren.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {transactions.map(tx => (
            <Card key={tx.id} data-testid={`transaction-card-${tx.id}`}>
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{formatCents(tx.amountCents)}</span>
                      <span className="text-xs text-gray-500">{formatDate(tx.emittedAt)}</span>
                      {tx.matchedInvoiceId ? (
                        <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs" data-testid={`badge-matched-${tx.id}`}>
                          Zugeordnet
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs" data-testid={`badge-unmatched-${tx.id}`}>
                          Offen
                        </Badge>
                      )}
                      {tx.matchConfidence && (
                        <span className="text-xs text-gray-400">
                          ({tx.matchConfidence === "manual" ? "manuell" : "automatisch"})
                        </span>
                      )}
                    </div>
                    {tx.counterpartyName && (
                      <p className="text-sm text-gray-700 mt-1 truncate">{tx.counterpartyName}</p>
                    )}
                    {tx.reference && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">Ref: {tx.reference}</p>
                    )}
                    {tx.label && tx.label !== tx.reference && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">{tx.label}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {tx.matchedInvoiceId ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => unmatchMutation.mutate(tx.id)}
                        disabled={unmatchMutation.isPending}
                        aria-label="Zuordnung aufheben"
                        data-testid={`button-unmatch-${tx.id}`}
                      >
                        <Unlink className={iconSize.sm} />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setMatchingTxId(matchingTxId === tx.id ? null : tx.id)}
                        aria-label="Rechnung zuordnen"
                        data-testid={`button-match-${tx.id}`}
                      >
                        <Link2 className={iconSize.sm} />
                      </Button>
                    )}
                  </div>
                </div>

                {matchingTxId === tx.id && (
                  <div className="mt-3 pt-3 border-t space-y-2">
                    <Label className="text-xs font-medium text-gray-600">Rechnung zuordnen</Label>
                    {invoicesQuery.isLoading ? (
                      <Loader2 className={`${iconSize.sm} animate-spin`} />
                    ) : (
                      <Select
                        onValueChange={v => matchMutation.mutate({ txId: tx.id, invoiceId: parseInt(v) })}
                      >
                        <SelectTrigger data-testid={`select-invoice-${tx.id}`}>
                          <SelectValue placeholder="Rechnung wählen..." />
                        </SelectTrigger>
                        <SelectContent>
                          {(invoicesQuery.data ?? []).map(inv => (
                            <SelectItem key={inv.id} value={inv.id.toString()}>
                              {inv.invoiceNumber} — {inv.customerName} — {formatCents(inv.grossAmountCents)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
          <p className="text-xs text-gray-400 text-center pt-2">
            {transactionsQuery.data?.total ?? 0} Transaktionen gesamt
          </p>
        </div>
      )}
    </div>
  );
}

function AdvicesTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { uploadFile } = useUpload();
  const [uploading, setUploading] = useState(false);
  const [newAdvice, setNewAdvice] = useState({ insuranceProviderName: "", ikNummer: "", notes: "" });

  const advicesQuery = useQuery<PaymentAdvice[]>({
    queryKey: ["qonto", "payment-advices"],
    queryFn: async () => unwrapResult(await api.get("/admin/qonto/payment-advices")),
  });

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) =>
      unwrapResult(await api.post("/admin/qonto/payment-advices", data)),
    onSuccess: () => {
      toast({ title: "Zahlungsavis gespeichert" });
      queryClient.invalidateQueries({ queryKey: ["qonto", "payment-advices"] });
      setNewAdvice({ insuranceProviderName: "", ikNummer: "", notes: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) =>
      unwrapResult(await api.delete(`/admin/qonto/payment-advices/${id}`)),
    onSuccess: () => {
      toast({ title: "Zahlungsavis gelöscht" });
      queryClient.invalidateQueries({ queryKey: ["qonto", "payment-advices"] });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const objectPath = await uploadFile(file);
      if (!objectPath) throw new Error("Upload fehlgeschlagen");

      await createMutation.mutateAsync({
        objectPath,
        fileName: file.name,
        insuranceProviderName: newAdvice.insuranceProviderName || null,
        ikNummer: newAdvice.ikNummer || null,
        notes: newAdvice.notes || null,
      });
    } catch (err) {
      toast({ title: "Fehler", description: err instanceof Error ? err.message : "Upload fehlgeschlagen", variant: "destructive" });
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const advices = advicesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className={iconSize.sm} />
            Neues Zahlungsavis hochladen
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="advice-provider">Pflegekasse (optional)</Label>
              <Input
                id="advice-provider"
                value={newAdvice.insuranceProviderName}
                onChange={e => setNewAdvice(prev => ({ ...prev, insuranceProviderName: e.target.value }))}
                placeholder="z.B. AOK Bayern"
                data-testid="input-advice-provider"
              />
            </div>
            <div>
              <Label htmlFor="advice-ik">IK-Nummer (optional)</Label>
              <Input
                id="advice-ik"
                value={newAdvice.ikNummer}
                onChange={e => setNewAdvice(prev => ({ ...prev, ikNummer: e.target.value }))}
                placeholder="z.B. 108034103"
                data-testid="input-advice-ik"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="advice-notes">Notizen (optional)</Label>
            <Textarea
              id="advice-notes"
              value={newAdvice.notes}
              onChange={e => setNewAdvice(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Anmerkungen zum Zahlungsavis..."
              rows={2}
              data-testid="input-advice-notes"
            />
          </div>
          <div>
            <Label htmlFor="advice-file">Datei wählen (PDF, Bild)</Label>
            <Input
              id="advice-file"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={handleFileUpload}
              disabled={uploading}
              className="mt-1"
              data-testid="input-advice-file"
            />
            {uploading && (
              <div className="flex items-center gap-2 mt-2 text-sm text-gray-500">
                <Loader2 className={`${iconSize.sm} animate-spin`} />
                Wird hochgeladen...
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {advicesQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
          </div>
        ) : advices.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-gray-500">
              Noch keine Zahlungsavise hochgeladen.
            </CardContent>
          </Card>
        ) : (
          advices.map(advice => (
            <Card key={advice.id} data-testid={`advice-card-${advice.id}`}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <FileText className={`${iconSize.sm} text-gray-400 shrink-0`} />
                      <span className="font-medium text-sm truncate">{advice.fileName}</span>
                      <span className="text-xs text-gray-500">{formatDate(advice.uploadedAt)}</span>
                    </div>
                    {advice.insuranceProviderName && (
                      <p className="text-xs text-gray-600 mt-1">{advice.insuranceProviderName}{advice.ikNummer ? ` (IK: ${advice.ikNummer})` : ""}</p>
                    )}
                    {advice.notes && (
                      <p className="text-xs text-gray-400 mt-0.5">{advice.notes}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => window.open(`/api/object-storage/download?path=${encodeURIComponent(advice.objectPath)}`, "_blank")}
                      aria-label="Avis anzeigen"
                      data-testid={`button-view-advice-${advice.id}`}
                    >
                      <Eye className={iconSize.sm} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => deleteMutation.mutate(advice.id)}
                      disabled={deleteMutation.isPending}
                      aria-label="Avis löschen"
                      data-testid={`button-delete-advice-${advice.id}`}
                    >
                      <Trash2 className={iconSize.sm} />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
