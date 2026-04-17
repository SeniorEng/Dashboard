import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, Loader2, AlertTriangle, ArrowRight, Users, CheckCircle2 } from "lucide-react";
import { api, unwrapResult, ApiError } from "@/lib/api/client";
import { useToast } from "@/hooks/use-toast";

interface DuplicateCustomer {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  status: string;
  geburtsdatum: string | null;
  stadt: string | null;
  strasse: string | null;
  nr: string | null;
  createdAt: string;
  primaryEmployeeId: number | null;
  appointmentCount: number;
  budgetAllocationCount: number;
  budgetTransactionCount: number;
  documentCount: number;
  invoiceCount: number;
  contractCount: number;
  hasInsurance: boolean;
  hasContacts: boolean;
}

interface DuplicateGroup {
  key: string;
  displayName: string;
  customers: DuplicateCustomer[];
}

interface DuplicatesResponse {
  groups: DuplicateGroup[];
}

interface MergeResponse {
  success: boolean;
  sourceCustomerId: number;
  targetCustomerId: number;
  counts: Record<string, number>;
}

function formatAddress(c: DuplicateCustomer): string {
  const street = [c.strasse, c.nr].filter(Boolean).join(" ");
  return [street, c.stadt].filter(Boolean).join(", ") || "—";
}

function CustomerCard({
  customer,
  role,
  onSetTarget,
  onSetSource,
  onClear,
}: {
  customer: DuplicateCustomer;
  role: "target" | "source" | null;
  onSetTarget: () => void;
  onSetSource: () => void;
  onClear: () => void;
}) {
  const ringClass = role === "target"
    ? "ring-2 ring-emerald-500"
    : role === "source"
      ? "ring-2 ring-amber-500"
      : "ring-1 ring-border";

  return (
    <div
      className={`rounded-lg p-3 bg-white transition-shadow ${ringClass}`}
      data-testid={`card-duplicate-customer-${customer.id}`}
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-semibold text-sm">
            {(customer.vorname ?? "") + " " + (customer.nachname ?? customer.name)}
            <span className="text-muted-foreground ml-2 text-xs">#{customer.id}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            <Link href={`/admin/customers/${customer.id}`} className="text-teal-600 hover:underline" data-testid={`link-customer-detail-${customer.id}`}>
              Detailseite öffnen
            </Link>
          </div>
        </div>
        <Badge
          variant="outline"
          className={
            customer.status === "aktiv"
              ? "bg-emerald-100 text-emerald-800 border-emerald-300"
              : customer.status === "erstberatung"
                ? "bg-blue-100 text-blue-800 border-blue-300"
                : "bg-gray-100 text-gray-700 border-gray-300"
          }
          data-testid={`badge-status-${customer.id}`}
        >
          {customer.status}
        </Badge>
      </div>
      <div className="text-xs space-y-1 text-muted-foreground">
        <div data-testid={`text-address-${customer.id}`}>📍 {formatAddress(customer)}</div>
        {customer.geburtsdatum && (
          <div data-testid={`text-birthday-${customer.id}`}>🎂 {customer.geburtsdatum}</div>
        )}
        <div data-testid={`text-created-${customer.id}`}>📅 Erstellt: {new Date(customer.createdAt).toLocaleDateString("de-DE")}</div>
      </div>
      <div className="grid grid-cols-2 gap-1 mt-3 text-xs">
        <Badge variant="outline" className="justify-between" data-testid={`badge-appointments-${customer.id}`}>
          <span>Termine</span>
          <span className="font-bold">{customer.appointmentCount}</span>
        </Badge>
        <Badge variant="outline" className="justify-between" data-testid={`badge-allocations-${customer.id}`}>
          <span>Allokat.</span>
          <span className="font-bold">{customer.budgetAllocationCount}</span>
        </Badge>
        <Badge variant="outline" className="justify-between" data-testid={`badge-transactions-${customer.id}`}>
          <span>Trans.</span>
          <span className="font-bold">{customer.budgetTransactionCount}</span>
        </Badge>
        <Badge variant="outline" className="justify-between" data-testid={`badge-invoices-${customer.id}`}>
          <span>Rechn.</span>
          <span className="font-bold">{customer.invoiceCount}</span>
        </Badge>
        <Badge variant="outline" className="justify-between" data-testid={`badge-contracts-${customer.id}`}>
          <span>Verträge</span>
          <span className="font-bold">{customer.contractCount}</span>
        </Badge>
        <Badge variant="outline" className="justify-between" data-testid={`badge-documents-${customer.id}`}>
          <span>Dok.</span>
          <span className="font-bold">{customer.documentCount}</span>
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1 mt-2">
        {customer.hasInsurance && (
          <Badge className="text-[10px] py-0 px-1.5 bg-purple-100 text-purple-800 hover:bg-purple-100">
            Versicherung
          </Badge>
        )}
        {customer.hasContacts && (
          <Badge className="text-[10px] py-0 px-1.5 bg-blue-100 text-blue-800 hover:bg-blue-100">
            Kontakte
          </Badge>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant={role === "target" ? "default" : "outline"}
          className={role === "target" ? "bg-emerald-600 hover:bg-emerald-700" : ""}
          onClick={role === "target" ? onClear : onSetTarget}
          data-testid={`button-set-target-${customer.id}`}
        >
          {role === "target" ? "✓ Ziel (bleibt)" : "Als Ziel"}
        </Button>
        <Button
          size="sm"
          variant={role === "source" ? "default" : "outline"}
          className={role === "source" ? "bg-amber-600 hover:bg-amber-700" : ""}
          onClick={role === "source" ? onClear : onSetSource}
          data-testid={`button-set-source-${customer.id}`}
        >
          {role === "source" ? "✓ Quelle (mergen)" : "Als Quelle"}
        </Button>
      </div>
    </div>
  );
}

function GroupSection({ group, onMergeRequest }: { group: DuplicateGroup; onMergeRequest: (source: DuplicateCustomer, target: DuplicateCustomer) => void }) {
  // Default: lowest ID = target, second-lowest = source
  const sorted = [...group.customers].sort((a, b) => a.id - b.id);
  const [targetId, setTargetId] = useState<number | null>(sorted[0]?.id ?? null);
  const [sourceId, setSourceId] = useState<number | null>(sorted.length === 2 ? sorted[1].id : null);

  const target = targetId ? group.customers.find((c) => c.id === targetId) ?? null : null;
  const source = sourceId ? group.customers.find((c) => c.id === sourceId) ?? null : null;

  const setAsTarget = (id: number) => {
    if (sourceId === id) setSourceId(null);
    setTargetId(id);
  };
  const setAsSource = (id: number) => {
    if (targetId === id) setTargetId(null);
    setSourceId(id);
  };
  const clearRole = (id: number) => {
    if (targetId === id) setTargetId(null);
    if (sourceId === id) setSourceId(null);
  };

  return (
    <Card data-testid={`group-${group.key}`}>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="h-4 w-4 text-amber-600" />
          {group.displayName}
          <Badge variant="outline" className="ml-2">{group.customers.length} Datensätze</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xs text-muted-foreground mb-3">
          Markieren Sie pro Karte explizit, ob es sich um das <strong className="text-emerald-700">Ziel</strong> (bleibt erhalten) oder die <strong className="text-amber-700">Quelle</strong> (wird zusammengeführt) handelt.
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {group.customers.map((c) => {
            const role: "target" | "source" | null =
              c.id === targetId ? "target" : c.id === sourceId ? "source" : null;
            return (
              <CustomerCard
                key={c.id}
                customer={c}
                role={role}
                onSetTarget={() => setAsTarget(c.id)}
                onSetSource={() => setAsSource(c.id)}
                onClear={() => clearRole(c.id)}
              />
            );
          })}
        </div>
        <div className="mt-4 flex justify-end gap-2 items-center">
          {target && source && (
            <div className="text-xs text-muted-foreground mr-auto" data-testid={`text-merge-summary-${group.key}`}>
              <span className="font-semibold">#{source.id}</span> wird in <span className="font-semibold">#{target.id}</span> zusammengeführt
            </div>
          )}
          <Button
            disabled={!source || !target || source.id === target.id}
            onClick={() => source && target && onMergeRequest(source, target)}
            data-testid={`button-merge-${group.key}`}
          >
            <ArrowRight className="h-4 w-4 mr-2" />
            Zusammenführen
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminDuplicates() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pendingMerge, setPendingMerge] = useState<{ source: DuplicateCustomer; target: DuplicateCustomer } | null>(null);
  const [resultDialog, setResultDialog] = useState<MergeResponse | null>(null);

  const { data, isLoading, error } = useQuery<DuplicatesResponse>({
    queryKey: ["admin-customers-duplicates"],
    queryFn: async () => unwrapResult(await api.get<DuplicatesResponse>("/admin/customers/duplicates")),
  });

  const mergeMutation = useMutation<MergeResponse, ApiError, { sourceCustomerId: number; targetCustomerId: number }>({
    mutationFn: async (vars) =>
      unwrapResult(await api.post<MergeResponse>("/admin/customers/merge", vars)),
    onSuccess: (data) => {
      setPendingMerge(null);
      setResultDialog(data);
      queryClient.invalidateQueries({ queryKey: ["admin-customers-duplicates"] });
      queryClient.invalidateQueries({ queryKey: ["admin-customers"] });
      toast({ title: "Erfolgreich zusammengeführt", description: `Kunde #${data.sourceCustomerId} → #${data.targetCustomerId}` });
    },
    onError: (err) => {
      toast({
        title: "Zusammenführen fehlgeschlagen",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const groups = data?.groups ?? [];

  return (
    <Layout>
      <div className="container mx-auto p-4 max-w-6xl">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin">
            <Button variant="ghost" size="sm" data-testid="button-back">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Zurück
            </Button>
          </Link>
          <h1 className="text-2xl font-bold">Doppelte Kunden zusammenführen</h1>
        </div>

        <Card className="mb-6 bg-amber-50 border-amber-200">
          <CardContent className="pt-4">
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold text-amber-900">So funktioniert es</div>
                <div className="text-amber-800">
                  Kunden mit identischem Namen werden hier aufgelistet. Wählen Sie pro Gruppe den <strong>Ziel-Kunden</strong> (bleibt erhalten, üblicherweise der ältere) und den <strong>Quell-Kunden</strong> (wird zusammengeführt). Alle Termine, Budgets, Dokumente, Verträge und sonstigen Daten werden auf den Ziel-Kunden übertragen. Der Quell-Kunde wird inaktiv und auf den Ziel-Kunden verwiesen. Die Aktion ist nicht rückgängig zu machen.
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {isLoading && (
          <div className="flex items-center justify-center py-12" data-testid="loading-duplicates">
            <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
          </div>
        )}

        {error && (
          <Card className="bg-red-50 border-red-200">
            <CardContent className="pt-4 text-sm text-red-800" data-testid="error-duplicates">
              Fehler beim Laden: {(error as Error).message}
            </CardContent>
          </Card>
        )}

        {!isLoading && groups.length === 0 && (
          <Card>
            <CardContent className="pt-6 text-center py-12" data-testid="empty-duplicates">
              <CheckCircle2 className="h-12 w-12 mx-auto text-emerald-500 mb-3" />
              <div className="font-semibold">Keine Duplikate gefunden</div>
              <div className="text-sm text-muted-foreground mt-1">
                Alle Kunden haben einzigartige Namen.
              </div>
            </CardContent>
          </Card>
        )}

        <div className="space-y-4">
          {groups.map((g) => (
            <GroupSection
              key={g.key}
              group={g}
              onMergeRequest={(source, target) => setPendingMerge({ source, target })}
            />
          ))}
        </div>
      </div>

      {/* Confirmation dialog */}
      <Dialog open={pendingMerge !== null} onOpenChange={(open) => !open && setPendingMerge(null)}>
        <DialogContent data-testid="dialog-merge-confirm">
          <DialogHeader>
            <DialogTitle>Zusammenführen bestätigen</DialogTitle>
            <DialogDescription>
              Die Aktion ist nicht umkehrbar. Bitte prüfen Sie die Auswahl genau.
            </DialogDescription>
          </DialogHeader>
          {pendingMerge && (
            <div className="space-y-3 text-sm">
              <div className="rounded p-3 bg-amber-50 border border-amber-200">
                <div className="font-semibold text-amber-900">Quelle (wird zusammengeführt):</div>
                <div data-testid="text-merge-source">
                  #{pendingMerge.source.id} – {(pendingMerge.source.vorname ?? "") + " " + (pendingMerge.source.nachname ?? pendingMerge.source.name)}
                </div>
                <div className="text-xs text-amber-800 mt-1">
                  {pendingMerge.source.appointmentCount} Termine, {pendingMerge.source.budgetAllocationCount} Allokationen, {pendingMerge.source.budgetTransactionCount} Transaktionen, {pendingMerge.source.invoiceCount} Rechnungen werden übertragen.
                </div>
              </div>
              <div className="text-center text-xs">↓</div>
              <div className="rounded p-3 bg-emerald-50 border border-emerald-200">
                <div className="font-semibold text-emerald-900">Ziel (bleibt):</div>
                <div data-testid="text-merge-target">
                  #{pendingMerge.target.id} – {(pendingMerge.target.vorname ?? "") + " " + (pendingMerge.target.nachname ?? pendingMerge.target.name)}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingMerge(null)} data-testid="button-cancel-merge">
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              disabled={mergeMutation.isPending}
              onClick={() =>
                pendingMerge &&
                mergeMutation.mutate({
                  sourceCustomerId: pendingMerge.source.id,
                  targetCustomerId: pendingMerge.target.id,
                })
              }
              data-testid="button-confirm-merge"
            >
              {mergeMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Endgültig zusammenführen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Result dialog */}
      <Dialog open={resultDialog !== null} onOpenChange={(open) => !open && setResultDialog(null)}>
        <DialogContent data-testid="dialog-merge-result">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              Zusammenführung abgeschlossen
            </DialogTitle>
          </DialogHeader>
          {resultDialog && (
            <div className="space-y-2 text-sm">
              <div>
                Kunde #{resultDialog.sourceCustomerId} wurde in #{resultDialog.targetCustomerId} zusammengeführt.
              </div>
              <div className="text-xs text-muted-foreground">
                <div className="font-semibold mb-1">Übertragene Datensätze:</div>
                <ul className="space-y-0.5">
                  {Object.entries(resultDialog.counts)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => (
                      <li key={k} data-testid={`count-${k}`}>
                        <span className="font-mono">{k}</span>: <span className="font-bold">{n}</span>
                      </li>
                    ))}
                </ul>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setResultDialog(null)} data-testid="button-close-result">Schließen</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
