import { useState, useMemo } from "react";
import { SectionCard } from "@/components/patterns/section-card";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useEmployees } from "@/features/customers";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { iconSize } from "@/design-system";
import { EmployeeMatching } from "../admin/employee-matching";
import { EditButton, SaveCancelButtons } from "./section-helpers";
import { Users } from "lucide-react";
import type { SectionProps } from "./types";

export function EmployeeSection({ customer, customerId, editingSection, setEditingSection, saving, setSaving, invalidateCustomer }: SectionProps) {
  const { toast } = useToast();
  const { data: employees } = useEmployees();

  const [employeeData, setEmployeeData] = useState({
    primaryEmployeeId: "",
    backupEmployeeId: "",
    backupEmployeeId2: "",
  });

  const employeeOptions = useMemo(() => [
    { value: "", label: "Nicht zugewiesen" },
    ...(employees?.map((emp) => ({
      value: emp.id.toString(),
      label: emp.displayName,
    })).sort((a, b) => a.label.localeCompare(b.label, "de")) || []),
  ], [employees]);

  const initEmployeeData = () => {
    setEmployeeData({
      primaryEmployeeId: customer.primaryEmployee?.id?.toString() || "",
      backupEmployeeId: customer.backupEmployee?.id?.toString() || "",
      backupEmployeeId2: customer.backupEmployee2?.id?.toString() || "",
    });
  };

  const handleSaveEmployees = async () => {
    const primaryId = employeeData.primaryEmployeeId ? parseInt(employeeData.primaryEmployeeId) : null;
    const backupId = employeeData.backupEmployeeId ? parseInt(employeeData.backupEmployeeId) : null;
    const backupId2 = employeeData.backupEmployeeId2 ? parseInt(employeeData.backupEmployeeId2) : null;
    const ids = [primaryId, backupId, backupId2].filter((id): id is number => id !== null);
    const uniqueIds = new Set(ids);
    if (ids.length !== uniqueIds.size) {
      toast({ title: "Ungültige Auswahl", description: "Alle zugewiesenen Mitarbeiter müssen unterschiedlich sein.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        primaryEmployeeId: primaryId,
        backupEmployeeId: backupId,
        backupEmployeeId2: backupId2,
      });
      unwrapResult(result);
      toast({ title: "Mitarbeiterzuordnung gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: error instanceof Error ? error.message : "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const startEditing = () => {
    initEmployeeData();
    setEditingSection("mitarbeiter");
  };

  const hasChanges = useMemo(() => {
    if (editingSection !== "mitarbeiter") return false;
    const initialPrimary = customer.primaryEmployee?.id?.toString() || "";
    const initialBackup = customer.backupEmployee?.id?.toString() || "";
    const initialBackup2 = customer.backupEmployee2?.id?.toString() || "";
    return (
      employeeData.primaryEmployeeId !== initialPrimary ||
      employeeData.backupEmployeeId !== initialBackup ||
      employeeData.backupEmployeeId2 !== initialBackup2
    );
  }, [editingSection, employeeData, customer.primaryEmployee, customer.backupEmployee, customer.backupEmployee2]);

  return (
    <SectionCard
      title="Zuständige Mitarbeiter"
      icon={<Users className={iconSize.sm} />}
      actions={editingSection !== "mitarbeiter" ? <EditButton section="mitarbeiter" editingSection={editingSection} startEditing={startEditing} /> : undefined}
    >
      {editingSection === "mitarbeiter" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Hauptzuständig</Label>
            <SearchableSelect
              options={employeeOptions}
              value={employeeData.primaryEmployeeId}
              onValueChange={(value) => setEmployeeData((prev) => ({ ...prev, primaryEmployeeId: value }))}
              placeholder="Mitarbeiter auswählen"
              searchPlaceholder="Mitarbeiter suchen..."
              emptyText="Kein Mitarbeiter gefunden."
              data-testid="select-primary-employee"
            />
          </div>

          <div className="space-y-2">
            <Label>1. Vertretung</Label>
            <SearchableSelect
              options={employeeOptions}
              value={employeeData.backupEmployeeId}
              onValueChange={(value) => setEmployeeData((prev) => ({ ...prev, backupEmployeeId: value }))}
              placeholder="Mitarbeiter auswählen"
              searchPlaceholder="Mitarbeiter suchen..."
              emptyText="Kein Mitarbeiter gefunden."
              data-testid="select-backup-employee"
            />
          </div>

          <div className="space-y-2">
            <Label>2. Vertretung</Label>
            <SearchableSelect
              options={employeeOptions}
              value={employeeData.backupEmployeeId2}
              onValueChange={(value) => setEmployeeData((prev) => ({ ...prev, backupEmployeeId2: value }))}
              placeholder="Mitarbeiter auswählen"
              searchPlaceholder="Mitarbeiter suchen..."
              emptyText="Kein Mitarbeiter gefunden."
              data-testid="select-backup-employee-2"
            />
          </div>

          <EmployeeMatching
            customerId={customerId}
            onSelect={(employeeId, displayName) => {
              setEmployeeData((prev) => ({ ...prev, primaryEmployeeId: employeeId.toString() }));
            }}
            selectedLabel="Vorschläge für Hauptzuständig"
          />

          <SaveCancelButtons onSave={handleSaveEmployees} testIdPrefix="mitarbeiter" saving={saving} hasChanges={hasChanges} onCancel={() => setEditingSection(null)} />
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-sm text-gray-500">Hauptzuständig</p>
            <p className="font-medium" data-testid="text-primary-employee">
              {customer.primaryEmployee?.displayName || "Nicht zugewiesen"}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">1. Vertretung</p>
            <p className="font-medium" data-testid="text-backup-employee">
              {customer.backupEmployee?.displayName || "Nicht zugewiesen"}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">2. Vertretung</p>
            <p className="font-medium" data-testid="text-backup-employee-2">
              {customer.backupEmployee2?.displayName || "Nicht zugewiesen"}
            </p>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
