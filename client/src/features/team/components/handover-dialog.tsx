import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DialogContent } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { iconSize } from "@/design-system";
import { Loader2, AlertTriangle, ArrowRightLeft, Calendar, Users } from "lucide-react";
import type { UserData } from "./user-types";

interface HandoverPreview {
  sourceEmployee: { id: number; displayName: string };
  targetEmployee: { id: number; displayName: string };
  primaryCustomers: { id: number; name: string; vorname: string; nachname: string }[];
  backupCustomers: { id: number; name: string; vorname: string; nachname: string }[];
  backup2Customers: { id: number; name: string; vorname: string; nachname: string }[];
  futureAppointments: { id: number; date: string; startTime: string; endTime: string; customerName: string; customerVorname: string; customerNachname: string }[];
  summary: { primaryCount: number; backupCount: number; backup2Count: number; appointmentCount: number };
}

export function HandoverDialog({ user, allUsers, onClose }: { user: UserData; allUsers: UserData[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [targetEmployeeId, setTargetEmployeeId] = useState<string>("");

  const activeEmployees = useMemo(
    () => allUsers.filter((u) => u.isActive && u.id !== user.id && !u.isAnonymized),
    [allUsers, user.id]
  );

  const { data: preview, isLoading: previewLoading } = useQuery<HandoverPreview>({
    queryKey: ["admin", "handover-preview", user.id, targetEmployeeId],
    queryFn: async () => {
      const result = await api.get<HandoverPreview>(`/admin/employees/${user.id}/handover-preview?targetEmployeeId=${targetEmployeeId}`);
      return unwrapResult(result);
    },
    enabled: !!targetEmployeeId,
  });

  interface HandoverResult {
    primaryCount?: number;
    backupCount?: number;
    backup2Count?: number;
    appointmentCount?: number;
  }

  const handoverMutation = useMutation({
    mutationFn: async (): Promise<HandoverResult> => {
      const result = await api.post<HandoverResult>(`/admin/employees/${user.id}/handover`, {
        targetEmployeeId: parseInt(targetEmployeeId),
      });
      return unwrapResult(result);
    },
    onSuccess: (data: HandoverResult) => {
      invalidateRelated(queryClient, "admin-users", "customers", "appointments");
      const total = (data.primaryCount || 0) + (data.backupCount || 0) + (data.backup2Count || 0);
      toast({
        title: "Übergabe erfolgreich",
        description: `${total} Kundenzuordnung(en) und ${data.appointmentCount || 0} Termin(e) übertragen.`,
      });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Fehler bei der Übergabe", description: error.message, variant: "destructive" });
    },
  });

  const totalCustomers = preview ? preview.summary.primaryCount + preview.summary.backupCount + preview.summary.backup2Count : 0;
  const totalAffected = totalCustomers + (preview?.summary.appointmentCount || 0);

  return (
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-handover">
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900" data-testid="text-handover-title">
            Kunden & Termine übergeben
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Alle Kundenzuordnungen und zukünftigen Termine von <strong>{user.displayName}</strong> an eine andere Mitarbeiterin übergeben.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Übergeben an</Label>
          <Select value={targetEmployeeId} onValueChange={setTargetEmployeeId}>
            <SelectTrigger data-testid="select-handover-target">
              <SelectValue placeholder="Mitarbeiter/in auswählen..." />
            </SelectTrigger>
            <SelectContent>
              {activeEmployees.map((emp) => (
                <SelectItem key={emp.id} value={String(emp.id)} data-testid={`select-handover-target-${emp.id}`}>
                  {emp.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {previewLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
          </div>
        )}

        {preview && (
          <div className="space-y-4">
            {totalAffected === 0 ? (
              <div className="text-center py-6 text-gray-500" data-testid="text-handover-empty">
                <Users className={`${iconSize.lg} mx-auto mb-2 text-gray-500`} />
                <p>Keine Kunden oder Termine zum Übergeben gefunden.</p>
              </div>
            ) : (
              <>
                {preview.summary.primaryCount > 0 && (
                  <div className="border rounded-lg p-3" data-testid="section-handover-primary">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                      <Users className={iconSize.sm} />
                      Hauptansprechpartner ({preview.summary.primaryCount})
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {preview.primaryCustomers.map((c) => (
                        <span key={c.id} className="text-xs bg-teal-50 text-teal-700 px-2 py-1 rounded" data-testid={`text-handover-primary-${c.id}`}>
                          {c.vorname} {c.nachname}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {preview.summary.backupCount > 0 && (
                  <div className="border rounded-lg p-3" data-testid="section-handover-backup">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                      <Users className={iconSize.sm} />
                      1. Vertretung ({preview.summary.backupCount})
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {preview.backupCustomers.map((c) => (
                        <span key={c.id} className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded" data-testid={`text-handover-backup-${c.id}`}>
                          {c.vorname} {c.nachname}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {preview.summary.backup2Count > 0 && (
                  <div className="border rounded-lg p-3" data-testid="section-handover-backup2">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                      <Users className={iconSize.sm} />
                      2. Vertretung ({preview.summary.backup2Count})
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {preview.backup2Customers.map((c) => (
                        <span key={c.id} className="text-xs bg-purple-50 text-purple-700 px-2 py-1 rounded" data-testid={`text-handover-backup2-${c.id}`}>
                          {c.vorname} {c.nachname}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {preview.summary.appointmentCount > 0 && (
                  <div className="border rounded-lg p-3" data-testid="section-handover-appointments">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                      <Calendar className={iconSize.sm} />
                      Zukünftige Termine ({preview.summary.appointmentCount})
                    </h3>
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {preview.futureAppointments.map((apt) => (
                        <div key={apt.id} className="text-xs text-gray-600 flex justify-between" data-testid={`text-handover-appointment-${apt.id}`}>
                          <span>{apt.customerVorname} {apt.customerNachname}</span>
                          <span className="text-gray-500">
                            {new Date(apt.date + "T00:00:00").toLocaleDateString("de-DE")} {apt.startTime}–{apt.endTime}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2" data-testid="warning-handover">
                  <AlertTriangle className={`${iconSize.sm} text-amber-600 mt-0.5 shrink-0`} />
                  <div className="text-sm text-amber-800">
                    <strong>{totalCustomers} Kundenzuordnung(en)</strong> und <strong>{preview.summary.appointmentCount} zukünftige Termin(e)</strong> werden
                    von <strong>{user.displayName}</strong> an <strong>{preview.targetEmployee.displayName}</strong> übertragen.
                    Diese Aktion kann nicht automatisch rückgängig gemacht werden.
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} data-testid="button-handover-cancel">
            Abbrechen
          </Button>
          <Button
            onClick={() => handoverMutation.mutate()}
            disabled={!targetEmployeeId || !preview || totalAffected === 0 || handoverMutation.isPending}
            className="bg-teal-600 hover:bg-teal-700"
            data-testid="button-handover-confirm"
          >
            {handoverMutation.isPending ? (
              <>
                <Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />
                Übergabe läuft...
              </>
            ) : (
              <>
                <ArrowRightLeft className={`mr-2 ${iconSize.sm}`} />
                Übergeben
              </>
            )}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}
