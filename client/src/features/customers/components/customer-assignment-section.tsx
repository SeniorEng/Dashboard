import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";
import { AlertTriangle, Loader2, Pencil, Save, Users, X } from "lucide-react";
import { useActiveEmployees, type ActiveEmployeeListItem } from "@/features/appointments/hooks/use-active-employees";
import type { Customer } from "@shared/schema";

interface CustomerAssignmentSectionProps {
  customer: Customer;
  customerId: number;
}

export function CustomerAssignmentSection({ customer, customerId }: CustomerAssignmentSectionProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = user?.isAdmin ?? false;
  const isTeamLead = user?.isTeamLead ?? false;
  const canEdit = isAdmin || isTeamLead;

  const { data: activeEmployees = [] } = useActiveEmployees({ enabled: canEdit });

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [primaryId, setPrimaryId] = useState<string>("");
  const [backupId, setBackupId] = useState<string>("");
  const [backupId2, setBackupId2] = useState<string>("");
  const [pendingCrossTeam, setPendingCrossTeam] = useState<ActiveEmployeeListItem[]>([]);
  const [showCrossTeamConfirm, setShowCrossTeamConfirm] = useState(false);

  const employeeOptions = useMemo(() => {
    const opts = activeEmployees
      .map((e) => ({ value: e.id.toString(), label: e.displayName }))
      .sort((a, b) => a.label.localeCompare(b.label, "de"));
    return [{ value: "", label: "Nicht zugewiesen" }, ...opts];
  }, [activeEmployees]);

  const employeeName = (id: number | null | undefined): string => {
    if (id == null) return "Nicht zugewiesen";
    const e = activeEmployees.find((x) => x.id === id);
    return e?.displayName ?? `#${id}`;
  };

  const startEditing = () => {
    setPrimaryId(customer.primaryEmployeeId ? customer.primaryEmployeeId.toString() : "");
    setBackupId(customer.backupEmployeeId ? customer.backupEmployeeId.toString() : "");
    setBackupId2(customer.backupEmployeeId2 ? customer.backupEmployeeId2.toString() : "");
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
  };

  // Berechnet alle neu zugewiesenen Mitarbeiter aus fremden Teams (nur für Teamleiter, nicht Admin).
  const computeCrossTeamTargets = (
    primary: number | null,
    backup: number | null,
    backup2: number | null,
  ): ActiveEmployeeListItem[] => {
    if (!isTeamLead || isAdmin || !user) return [];
    const previousIds = new Set(
      [customer.primaryEmployeeId, customer.backupEmployeeId, customer.backupEmployeeId2]
        .filter((v): v is number => v != null),
    );
    const newlyAssigned = [primary, backup, backup2]
      .filter((v): v is number => v != null)
      .filter((id) => !previousIds.has(id));
    const flagged: ActiveEmployeeListItem[] = [];
    const seen = new Set<number>();
    for (const id of newlyAssigned) {
      if (seen.has(id)) continue;
      seen.add(id);
      const target = activeEmployees.find((e) => e.id === id);
      if (!target) continue;
      if (target.id === user.id) continue;
      if (target.teamLeadId === user.id) continue;
      flagged.push(target);
    }
    return flagged;
  };

  const performSave = async (primary: number | null, backup: number | null, backup2: number | null) => {
    setSaving(true);
    try {
      const result = await api.patch(`/customers/${customerId}/assignment`, {
        primaryEmployeeId: primary,
        backupEmployeeId: backup,
        backupEmployeeId2: backup2,
      });
      unwrapResult(result);
      toast({ title: "Mitarbeiterzuordnung gespeichert" });
      await queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      setEditing(false);
    } catch (error: unknown) {
      toast({
        variant: "destructive",
        title: "Fehler",
        description: error instanceof Error ? error.message : "Speichern fehlgeschlagen.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    const primary = primaryId ? parseInt(primaryId) : null;
    const backup = backupId ? parseInt(backupId) : null;
    const backup2 = backupId2 ? parseInt(backupId2) : null;

    const ids = [primary, backup, backup2].filter((v): v is number => v != null);
    if (new Set(ids).size !== ids.length) {
      toast({
        variant: "destructive",
        title: "Ungültige Auswahl",
        description: "Alle zugewiesenen Mitarbeiter müssen unterschiedlich sein.",
      });
      return;
    }

    const flagged = computeCrossTeamTargets(primary, backup, backup2);
    if (flagged.length > 0) {
      setPendingCrossTeam(flagged);
      setShowCrossTeamConfirm(true);
      return;
    }

    void performSave(primary, backup, backup2);
  };

  const confirmCrossTeamAndSave = () => {
    setShowCrossTeamConfirm(false);
    const primary = primaryId ? parseInt(primaryId) : null;
    const backup = backupId ? parseInt(backupId) : null;
    const backup2 = backupId2 ? parseInt(backupId2) : null;
    void performSave(primary, backup, backup2);
  };

  if (!canEdit && customer.primaryEmployeeId == null && customer.backupEmployeeId == null && customer.backupEmployeeId2 == null) {
    return null;
  }

  return (
    <Card className="mb-4" data-testid="card-customer-assignment">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Users className={`${iconSize.sm} text-primary`} />
            Zuständige Mitarbeiter
          </h2>
          {canEdit && !editing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={startEditing}
              data-testid="button-edit-customer-assignment"
            >
              <Pencil className={iconSize.sm} />
              <span className="ml-1 text-xs">Bearbeiten</span>
            </Button>
          )}
        </div>

        {editing ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Hauptzuständig</Label>
              <SearchableSelect
                options={employeeOptions}
                value={primaryId}
                onValueChange={setPrimaryId}
                placeholder="Mitarbeiter auswählen"
                searchPlaceholder="Mitarbeiter suchen..."
                emptyText="Kein Mitarbeiter gefunden."
                data-testid="select-customer-primary-employee"
              />
            </div>
            <div className="space-y-1.5">
              <Label>1. Vertretung</Label>
              <SearchableSelect
                options={employeeOptions}
                value={backupId}
                onValueChange={setBackupId}
                placeholder="Mitarbeiter auswählen"
                searchPlaceholder="Mitarbeiter suchen..."
                emptyText="Kein Mitarbeiter gefunden."
                data-testid="select-customer-backup-employee"
              />
            </div>
            <div className="space-y-1.5">
              <Label>2. Vertretung</Label>
              <SearchableSelect
                options={employeeOptions}
                value={backupId2}
                onValueChange={setBackupId2}
                placeholder="Mitarbeiter auswählen"
                searchPlaceholder="Mitarbeiter suchen..."
                emptyText="Kein Mitarbeiter gefunden."
                data-testid="select-customer-backup-employee-2"
              />
            </div>
            <div className="flex items-center gap-2 pt-2">
              <Button
                onClick={handleSave}
                disabled={saving}
                size="sm"
                data-testid="button-save-customer-assignment"
              >
                {saving ? <Loader2 className={`${iconSize.sm} animate-spin mr-1`} /> : <Save className={`${iconSize.sm} mr-1`} />}
                Speichern
              </Button>
              <Button
                variant="ghost"
                onClick={cancelEditing}
                disabled={saving}
                size="sm"
                data-testid="button-cancel-customer-assignment"
              >
                <X className={`${iconSize.sm} mr-1`} />
                Abbrechen
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Hauptzuständig</span>
              <span className="font-medium" data-testid="text-customer-primary-employee">
                {employeeName(customer.primaryEmployeeId)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">1. Vertretung</span>
              <span className="font-medium" data-testid="text-customer-backup-employee">
                {employeeName(customer.backupEmployeeId)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">2. Vertretung</span>
              <span className="font-medium" data-testid="text-customer-backup-employee-2">
                {employeeName(customer.backupEmployeeId2)}
              </span>
            </div>
          </div>
        )}
      </CardContent>

      <AlertDialog open={showCrossTeamConfirm} onOpenChange={setShowCrossTeamConfirm}>
        <AlertDialogContent className="max-w-md" data-testid="dialog-customer-cross-team-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className={`${iconSize.md} text-amber-500`} />
              Mitarbeiter aus anderem Team
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-2">
                <span className="block">
                  {pendingCrossTeam.length === 1
                    ? "Folgender Mitarbeiter gehört nicht zu Ihrem Team:"
                    : "Folgende Mitarbeiter gehören nicht zu Ihrem Team:"}
                </span>
                <ul className="block space-y-1 list-disc pl-5">
                  {pendingCrossTeam.map((t) => (
                    <li key={t.id} data-testid={`text-customer-cross-team-target-${t.id}`}>
                      <strong>{t.displayName}</strong>
                      {t.teamLeadName && (
                        <>
                          {" "}— Teamleitung: <strong>{t.teamLeadName}</strong>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                <span className="block">Möchten Sie die Zuordnung trotzdem speichern?</span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-customer-cross-team-cancel">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCrossTeamAndSave}
              data-testid="button-customer-cross-team-confirm"
            >
              Trotzdem speichern
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
