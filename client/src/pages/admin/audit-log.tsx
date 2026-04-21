import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/patterns/status-badge";
import { ArrowLeft, Loader2, Shield, ChevronLeft, ChevronRight, Layers, X } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";

const ACTION_LABELS: Record<string, string> = {
  documentation_submitted: "Dokumentation eingereicht",
  documentation_signature_added: "Unterschrift hinzugefügt",
  service_record_created: "Leistungsnachweis erstellt",
  service_record_signed_employee: "Mitarbeiter-Unterschrift",
  service_record_signed_customer: "Kunden-Unterschrift",
  service_record_revoked: "Leistungsnachweis storniert",
  appointment_revoked: "Termin storniert",
  appointment_updated: "Termin bearbeitet",
  appointment_deleted: "Termin gelöscht",
  import_trim_reconciled: "Import-Reparatur (Termin)",
  import_trim_reconciled_batch: "Import-Reparatur (Sitzung)",
};

const ENTITY_TYPE_LABELS: Record<string, string> = {
  appointment: "Termin",
  service_record: "Leistungsnachweis",
  customer: "Kunde",
};

interface AuditEntry {
  id: number;
  userId: number;
  userName: string;
  action: string;
  entityType: string;
  entityId: number;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  total: number;
}

export default function AdminAuditLog() {
  const [entityType, setEntityType] = useState<string>("all");
  const [action, setAction] = useState<string>("all");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 30;

  const { data, isLoading } = useQuery<AuditResponse>({
    queryKey: ["audit-log", entityType, action, batchId, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (entityType !== "all") params.set("entityType", entityType);
      if (action !== "all") params.set("action", action);
      if (batchId) params.set("batchId", batchId);
      params.set("limit", pageSize.toString());
      params.set("offset", (page * pageSize).toString());
      const result = await api.get<AuditResponse>(`/admin/audit-log?${params}`);
      return unwrapResult(result);
    },
    staleTime: 10000,
  });

  const filterByBatch = (id: string) => {
    setBatchId(id);
    setEntityType("all");
    setAction("all");
    setPage(0);
  };

  const clearBatchFilter = () => {
    setBatchId(null);
    setPage(0);
  };

  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const getMetadataDisplay = (entry: AuditEntry): string => {
    if (!entry.metadata) return "";
    const parts: string[] = [];
    const m = entry.metadata;
    if (m.customerId) parts.push(`Kunde #${m.customerId}`);
    if (m.hasSignature !== undefined) parts.push(m.hasSignature ? "Mit Unterschrift" : "Ohne Unterschrift");
    if (m.year && m.month) parts.push(`${m.month}/${m.year}`);
    if (m.appointmentCount) parts.push(`${m.appointmentCount} Termine`);
    if (m.changedFields && Array.isArray(m.changedFields)) parts.push(`Felder: ${(m.changedFields as string[]).join(", ")}`);
    if (m.reason) parts.push(`Grund: ${m.reason}`);
    if (m.previousStatus) parts.push(`Vorher: ${m.previousStatus}`);
    if (m.date) parts.push(`Datum: ${m.date}`);
    if (typeof m.previousMinutes === "number" && typeof m.restoredMinutes === "number") {
      parts.push(`${m.previousMinutes} → ${m.restoredMinutes} Min`);
    }
    if (typeof m.restored === "number" || typeof m.insufficient === "number" || typeof m.skipped === "number") {
      const r = (m.restored as number | undefined) ?? 0;
      const i = (m.insufficient as number | undefined) ?? 0;
      const s = (m.skipped as number | undefined) ?? 0;
      parts.push(`${r} wiederhergestellt · ${i} unzureichend · ${s} übersprungen`);
    }
    if (typeof m.batchId === "string") {
      parts.push(`Sitzung: ${m.batchId.slice(0, 8)}`);
    }
    return parts.join(" · ");
  };

  const actionColor = (act: string): "status" | "activity" | "warning" | "info" => {
    if (act.includes("revoked") || act.includes("deleted")) return "warning";
    if (act.includes("signed") || act.includes("signature")) return "status";
    if (act.includes("created") || act.includes("submitted")) return "activity";
    return "info";
  };

  return (
    <Layout variant="wide">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className={`${componentStyles.pageTitle} flex items-center gap-2`}>
                <Shield className={iconSize.lg} />
                Audit-Log
              </h1>
              <p className="text-gray-600">Unveränderliches Protokoll aller Unterschriften und Dokumentationen</p>
            </div>
          </div>

          <Card className="mb-4">
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-4">
                <div className="space-y-1">
                  <Label className="text-xs">Bereich</Label>
                  <Select value={entityType} onValueChange={(v) => { setEntityType(v); setPage(0); }}>
                    <SelectTrigger className="w-[180px]" data-testid="select-entity-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Alle</SelectItem>
                      <SelectItem value="appointment">Termine</SelectItem>
                      <SelectItem value="service_record">Leistungsnachweise</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Aktion</Label>
                  <Select value={action} onValueChange={(v) => { setAction(v); setPage(0); }}>
                    <SelectTrigger className="w-[220px]" data-testid="select-action">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Alle</SelectItem>
                      {Object.entries(ACTION_LABELS).map(([key, label]) => (
                        <SelectItem key={key} value={key}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <span className="text-sm text-gray-500" data-testid="text-total-entries">
                    {data ? `${data.total} Einträge` : ""}
                  </span>
                </div>
              </div>
              {batchId && (
                <div className="mt-3 flex items-center gap-2 rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-900" data-testid="banner-batch-filter">
                  <Layers className={iconSize.sm} />
                  <span>
                    Gefiltert nach Reparatur-Sitzung <span className="font-mono font-medium">{batchId.slice(0, 8)}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 px-2"
                    onClick={clearBatchFilter}
                    data-testid="button-clear-batch-filter"
                  >
                    <X className={iconSize.sm} />
                    <span className="ml-1">Filter aufheben</span>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
            </div>
          ) : !data || data.entries.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-gray-500">
                Keine Audit-Einträge gefunden.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                {data.entries.map((entry) => {
                  const metaDisplay = getMetadataDisplay(entry);
                  const entryBatchId = typeof entry.metadata?.batchId === "string" ? (entry.metadata.batchId as string) : null;
                  const isBatchSummary = entry.action === "import_trim_reconciled_batch";
                  const isActiveBatch = !!entryBatchId && entryBatchId === batchId;
                  return (
                    <Card
                      key={entry.id}
                      data-testid={`audit-entry-${entry.id}`}
                      className={isBatchSummary ? "border-teal-300 bg-teal-50/40" : isActiveBatch ? "border-teal-200" : undefined}
                    >
                      <CardContent className="p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              <StatusBadge
                                type={actionColor(entry.action)}
                                value={ACTION_LABELS[entry.action] || entry.action}
                              />
                              <span className="text-xs text-gray-500">
                                {ENTITY_TYPE_LABELS[entry.entityType] || entry.entityType} #{entry.entityId}
                              </span>
                              {entryBatchId && entryBatchId !== batchId && (
                                <button
                                  type="button"
                                  onClick={() => filterByBatch(entryBatchId)}
                                  className="inline-flex items-center gap-1 rounded border border-teal-300 bg-white px-2 py-0.5 text-xs text-teal-800 hover:bg-teal-50"
                                  data-testid={`button-filter-batch-${entry.id}`}
                                  title="Alle Einträge dieser Reparatur-Sitzung anzeigen"
                                >
                                  <Layers className="h-3 w-3" />
                                  {isBatchSummary ? "Sitzung anzeigen" : `Sitzung ${entryBatchId.slice(0, 8)}`}
                                </button>
                              )}
                            </div>
                            <div className="text-sm text-gray-700">
                              <span className="font-medium">{entry.userName}</span>
                              {entry.ipAddress && (
                                <span className="text-xs text-gray-500 ml-2">({entry.ipAddress})</span>
                              )}
                            </div>
                            {metaDisplay && (
                              <div className="text-xs text-gray-500 mt-1">
                                {metaDisplay}
                              </div>
                            )}
                            {isBatchSummary && entryBatchId && (
                              <div className="text-xs text-teal-700 mt-1">
                                Sammel-Eintrag der Reparatur-Sitzung — enthält die zugehörigen Einzel-Termine.
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 whitespace-nowrap">
                            {formatDate(entry.createdAt)}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-4 mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className={iconSize.sm} />
                  </Button>
                  <span className="text-sm text-gray-600">
                    Seite {page + 1} von {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    data-testid="button-next-page"
                  >
                    <ChevronRight className={iconSize.sm} />
                  </Button>
                </div>
              )}
            </>
          )}
    </Layout>
  );
}
