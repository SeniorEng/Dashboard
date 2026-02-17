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
import { ArrowLeft, Loader2, Shield, ChevronLeft, ChevronRight } from "lucide-react";
import { iconSize } from "@/design-system";

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
};

const ENTITY_TYPE_LABELS: Record<string, string> = {
  appointment: "Termin",
  service_record: "Leistungsnachweis",
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
  const [page, setPage] = useState(0);
  const pageSize = 30;

  const { data, isLoading } = useQuery<AuditResponse>({
    queryKey: ["audit-log", entityType, action, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (entityType !== "all") params.set("entityType", entityType);
      if (action !== "all") params.set("action", action);
      params.set("limit", pageSize.toString());
      params.set("offset", (page * pageSize).toString());
      const res = await fetch(`/api/admin/audit-log?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Audit-Log konnte nicht geladen werden");
      return res.json();
    },
    staleTime: 10000,
  });

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
    return parts.join(" · ");
  };

  const actionColor = (act: string): "status" | "activity" | "warning" | "info" => {
    if (act.includes("revoked") || act.includes("deleted")) return "warning";
    if (act.includes("signed") || act.includes("signature")) return "status";
    if (act.includes("created") || act.includes("submitted")) return "activity";
    return "info";
  };

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-5xl">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
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
                  return (
                    <Card key={entry.id} data-testid={`audit-entry-${entry.id}`}>
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
                            </div>
                            <div className="text-sm text-gray-700">
                              <span className="font-medium">{entry.userName}</span>
                              {entry.ipAddress && (
                                <span className="text-xs text-gray-400 ml-2">({entry.ipAddress})</span>
                              )}
                            </div>
                            {metaDisplay && (
                              <div className="text-xs text-gray-500 mt-1">
                                {metaDisplay}
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-gray-400 whitespace-nowrap">
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
        </div>
      </div>
    </Layout>
  );
}
