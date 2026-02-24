import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { customerKeys } from "@/features/customers";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { iconSize, componentStyles } from "@/design-system";
import {
  FileText,
  ClipboardList,
  CreditCard,
  Pencil,
  Save,
  X,
  Loader2,
} from "lucide-react";
import type { CustomerDetail } from "@/lib/api/types";

function formatPeriodType(type: string): string {
  switch (type) {
    case "week": return "Woche";
    case "month": return "Monat";
    case "year": return "Jahr";
    default: return type;
  }
}

interface CustomerContractTabProps {
  customer: CustomerDetail;
  customerId: number;
}

export function CustomerContractTab({ customer, customerId }: CustomerContractTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [contractStart, setContractStart] = useState("");
  const [contractDate, setContractDate] = useState("");
  const [contractEnd, setContractEnd] = useState("");
  const [hoursPerPeriod, setHoursPerPeriod] = useState(0);
  const [periodType, setPeriodType] = useState("week");

  const [vereinbarteLeistungen, setVereinbarteLeistungen] = useState("");
  const [acceptsPrivatePayment, setAcceptsPrivatePayment] = useState(false);

  const [creatingContract, setCreatingContract] = useState(false);
  const [newContractStart, setNewContractStart] = useState("");

  const contract = customer.currentContract;

  const startEditing = (section: string) => {
    if (section === "vertragsdaten" && contract) {
      setContractStart(contract.contractStart || "");
      setContractDate(contract.contractDate || "");
      setContractEnd(contract.contractEnd || "");
      setHoursPerPeriod(contract.hoursPerPeriod || 0);
      setPeriodType(contract.periodType || "week");
    } else if (section === "leistungen") {
      setVereinbarteLeistungen(contract?.vereinbarteLeistungen || "");
    } else if (section === "abrechnung") {
      setAcceptsPrivatePayment(customer.acceptsPrivatePayment ?? false);
    }
    setEditingSection(section);
  };

  const cancelEditing = () => {
    setEditingSection(null);
  };

  const invalidateCustomer = () => {
    queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
    queryClient.invalidateQueries({ queryKey: customerKeys.lists() });
  };

  const handleCreateContract = async () => {
    if (!newContractStart) {
      toast({ variant: "destructive", title: "Fehler", description: "Bitte Vertragsbeginn angeben." });
      return;
    }
    setSaving(true);
    try {
      const result = await api.post(`/admin/customers/${customerId}/contract`, {
        contractStart: newContractStart,
      });
      unwrapResult(result);
      toast({ title: "Vertrag angelegt" });
      invalidateCustomer();
      setCreatingContract(false);
      setNewContractStart("");
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Vertrag konnte nicht angelegt werden." });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveVertragsdaten = async () => {
    setSaving(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}/contract`, {
        contractStart: contractStart || undefined,
        contractDate: contractDate || null,
        contractEnd: contractEnd || null,
        hoursPerPeriod,
        periodType,
      });
      unwrapResult(result);
      toast({ title: "Vertragsdaten gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveLeistungen = async () => {
    setSaving(true);
    try {
      if (contract?.id) {
        const contractPatch = await api.patch(`/admin/customers/${customerId}/contract`, {
          vereinbarteLeistungen: vereinbarteLeistungen.trim() || null,
        });
        unwrapResult(contractPatch);
      }
      toast({ title: "Vereinbarte Leistungen gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const togglePrivatePayment = useMutation({
    mutationFn: async (accepts: boolean) => {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        acceptsPrivatePayment: accepts,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateCustomer();
      toast({ title: "Abrechnungseinstellung aktualisiert" });
      setEditingSection(null);
    },
    onError: (err: Error) => {
      toast({ title: "Fehler", description: err.message, variant: "destructive" });
    },
  });

  const editButton = (section: string) => (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => startEditing(section)}
      disabled={editingSection !== null && editingSection !== section}
      data-testid={`button-edit-${section}`}
    >
      <Pencil className={iconSize.sm} />
    </Button>
  );

  const saveCancel = (onSave: () => void, isSaving: boolean, testIdPrefix: string, extraDisabled = false) => (
    <div className="flex items-center gap-2 pt-3">
      <Button
        className={componentStyles.btnPrimary}
        onClick={onSave}
        disabled={isSaving || extraDisabled}
        data-testid={`button-save-${testIdPrefix}`}
      >
        {isSaving ? (
          <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
        ) : (
          <Save className={`${iconSize.sm} mr-2`} />
        )}
        Speichern
      </Button>
      <Button
        variant="outline"
        onClick={cancelEditing}
        disabled={isSaving}
        data-testid={`button-cancel-${testIdPrefix}`}
      >
        <X className={`${iconSize.sm} mr-2`} />
        Abbrechen
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <SectionCard
        title="Vertragsdaten"
        icon={<FileText className={iconSize.sm} />}
        actions={contract && editingSection !== "vertragsdaten" ? editButton("vertragsdaten") : undefined}
      >
        {!contract ? (
          <div className="space-y-3">
            {creatingContract ? (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="newContractStart">Vertragsbeginn</Label>
                  <Input
                    id="newContractStart"
                    type="date"
                    value={newContractStart}
                    onChange={(e) => setNewContractStart(e.target.value)}
                    data-testid="input-new-contract-start"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    className={componentStyles.btnPrimary}
                    onClick={handleCreateContract}
                    disabled={saving}
                    data-testid="button-create-contract"
                  >
                    {saving ? (
                      <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                    ) : (
                      <Save className={`${iconSize.sm} mr-2`} />
                    )}
                    Vertrag anlegen
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => { setCreatingContract(false); setNewContractStart(""); }}
                    disabled={saving}
                    data-testid="button-cancel-create-contract"
                  >
                    <X className={`${iconSize.sm} mr-2`} />
                    Abbrechen
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-400" data-testid="text-no-contract">Kein aktiver Vertrag vorhanden</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCreatingContract(true)}
                  data-testid="button-start-create-contract"
                >
                  Vertrag anlegen
                </Button>
              </div>
            )}
          </div>
        ) : editingSection === "vertragsdaten" ? (
          <div className="space-y-4">
            <div className="grid gap-4 grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="contractStart">Vertragsbeginn</Label>
                <Input
                  id="contractStart"
                  type="date"
                  value={contractStart}
                  onChange={(e) => setContractStart(e.target.value)}
                  data-testid="input-contract-start"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contractDate">Vertragsabschluss</Label>
                <Input
                  id="contractDate"
                  type="date"
                  value={contractDate}
                  onChange={(e) => setContractDate(e.target.value)}
                  data-testid="input-contract-date"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contractEnd">Vertragsende</Label>
                <Input
                  id="contractEnd"
                  type="date"
                  value={contractEnd}
                  onChange={(e) => setContractEnd(e.target.value)}
                  data-testid="input-contract-end"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hoursPerPeriod">Stundenumfang</Label>
                <div className="flex gap-2">
                  <Input
                    id="hoursPerPeriod"
                    type="number"
                    min={0}
                    value={hoursPerPeriod}
                    onChange={(e) => setHoursPerPeriod(parseInt(e.target.value) || 0)}
                    className="w-20"
                    data-testid="input-hours-per-period"
                  />
                  <Select value={periodType} onValueChange={setPeriodType}>
                    <SelectTrigger className="flex-1" data-testid="select-period-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="week">pro Woche</SelectItem>
                      <SelectItem value="month">pro Monat</SelectItem>
                      <SelectItem value="year">pro Jahr</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            {saveCancel(handleSaveVertragsdaten, saving, "vertragsdaten")}
          </div>
        ) : (
          <div className="space-y-3" data-testid="text-contract">
            <div className="grid gap-3 grid-cols-2">
              <div>
                <p className="text-sm text-gray-500">Vertragsbeginn</p>
                <p className="font-medium" data-testid="text-contract-start">
                  {formatDateForDisplay(contract.contractStart)}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Vertragsabschluss</p>
                <p className="font-medium" data-testid="text-contract-date">
                  {contract.contractDate
                    ? formatDateForDisplay(contract.contractDate)
                    : "Nicht angegeben"}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Vertragsende</p>
                <p className="font-medium" data-testid="text-contract-end">
                  {contract.contractEnd
                    ? formatDateForDisplay(contract.contractEnd)
                    : "Kein Ende festgelegt"}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Vertragsumfang</p>
                <p className="font-medium" data-testid="text-contract-hours">
                  {contract.hoursPerPeriod > 0
                    ? `${contract.hoursPerPeriod} Std. / ${formatPeriodType(contract.periodType)}`
                    : "Nicht festgelegt"}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Status</p>
                <StatusBadge type="contract" value={contract.status} />
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Vereinbarte Leistungen"
        icon={<ClipboardList className={iconSize.sm} />}
        actions={editingSection !== "leistungen" ? editButton("leistungen") : undefined}
      >
        {editingSection === "leistungen" ? (
          <div className="space-y-4">
            {!contract && (
              <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
                Kein aktiver Vertrag vorhanden. Leistungstext kann erst nach Vertragsanlage gespeichert werden.
              </p>
            )}
            <Textarea
              value={vereinbarteLeistungen}
              onChange={(e) => setVereinbarteLeistungen(e.target.value)}
              placeholder="Beschreibung der vereinbarten Leistungen..."
              rows={4}
              disabled={!contract}
              data-testid="input-vereinbarte-leistungen"
            />
            {saveCancel(handleSaveLeistungen, saving, "leistungen", !contract)}
          </div>
        ) : (
          <p className="text-gray-700 whitespace-pre-wrap" data-testid="text-vereinbarte-leistungen">
            {contract?.vereinbarteLeistungen || "Keine Angabe"}
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Abrechnung"
        icon={<CreditCard className={iconSize.sm} />}
        actions={editingSection !== "abrechnung" ? editButton("abrechnung") : undefined}
      >
        {editingSection === "abrechnung" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
              <div className="space-y-0.5">
                <Label htmlFor="acceptsPrivatePayment" className="cursor-pointer">Private Zuzahlung</Label>
                <p className="text-xs text-gray-500">Kunde akzeptiert private Zuzahlungen</p>
              </div>
              <Switch
                id="acceptsPrivatePayment"
                checked={acceptsPrivatePayment}
                onCheckedChange={setAcceptsPrivatePayment}
                data-testid="switch-accepts-private-payment"
              />
            </div>
            <div className="flex items-center gap-2 pt-3">
              <Button
                className={componentStyles.btnPrimary}
                onClick={() => togglePrivatePayment.mutate(acceptsPrivatePayment)}
                disabled={togglePrivatePayment.isPending}
                data-testid="button-save-abrechnung"
              >
                {togglePrivatePayment.isPending ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Save className={`${iconSize.sm} mr-2`} />
                )}
                Speichern
              </Button>
              <Button
                variant="outline"
                onClick={cancelEditing}
                disabled={togglePrivatePayment.isPending}
                data-testid="button-cancel-abrechnung"
              >
                <X className={`${iconSize.sm} mr-2`} />
                Abbrechen
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2" data-testid="text-private-payment">
              <p className="text-sm text-gray-700">Private Zuzahlung:</p>
              <StatusBadge
                type={customer.acceptsPrivatePayment ? "activity" : "info"}
                value={customer.acceptsPrivatePayment ? "Ja" : "Nein"}
              />
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
