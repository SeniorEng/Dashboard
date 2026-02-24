import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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

  const [vereinbarteLeistungen, setVereinbarteLeistungen] = useState("");
  const [acceptsPrivatePayment, setAcceptsPrivatePayment] = useState(false);

  const startEditing = (section: string) => {
    if (section === "leistungen") {
      setVereinbarteLeistungen(customer.currentContract?.vereinbarteLeistungen || "");
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

  const handleSaveLeistungen = async () => {
    setSaving(true);
    try {
      if (customer.currentContract?.id) {
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

  return (
    <div className="space-y-4">
      <SectionCard
        title="Vertragsdaten"
        icon={<FileText className={iconSize.sm} />}
      >
        {customer.currentContract ? (
          <div className="space-y-3" data-testid="text-contract">
            <div className="grid gap-3 grid-cols-2">
              <div>
                <p className="text-sm text-gray-500">Vertragsabschluss</p>
                <p className="font-medium">
                  {customer.currentContract.contractDate
                    ? formatDateForDisplay(customer.currentContract.contractDate)
                    : "Nicht angegeben"}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Vertragsbeginn</p>
                <p className="font-medium" data-testid="text-contract-start">
                  {formatDateForDisplay(customer.currentContract.contractStart)}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Vertragsumfang</p>
                <p className="font-medium" data-testid="text-contract-hours">
                  {customer.currentContract.hoursPerPeriod > 0
                    ? `${customer.currentContract.hoursPerPeriod} Std. / ${formatPeriodType(customer.currentContract.periodType)}`
                    : "Nicht festgelegt"}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Status</p>
                <StatusBadge type="contract" value={customer.currentContract.status} />
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-400" data-testid="text-no-contract">Kein aktiver Vertrag vorhanden</p>
        )}
      </SectionCard>

      <SectionCard
        title="Vereinbarte Leistungen"
        icon={<ClipboardList className={iconSize.sm} />}
        actions={editingSection !== "leistungen" ? editButton("leistungen") : undefined}
      >
        {editingSection === "leistungen" ? (
          <div className="space-y-4">
            {!customer.currentContract && (
              <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
                Kein aktiver Vertrag vorhanden. Leistungstext kann erst nach Vertragsanlage gespeichert werden.
              </p>
            )}
            <Textarea
              value={vereinbarteLeistungen}
              onChange={(e) => setVereinbarteLeistungen(e.target.value)}
              placeholder="Beschreibung der vereinbarten Leistungen..."
              rows={4}
              disabled={!customer.currentContract}
              data-testid="input-vereinbarte-leistungen"
            />
            <div className="flex items-center gap-2 pt-3">
              <Button
                className={componentStyles.btnPrimary}
                onClick={handleSaveLeistungen}
                disabled={saving || !customer.currentContract}
                data-testid="button-save-leistungen"
              >
                {saving ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Save className={`${iconSize.sm} mr-2`} />
                )}
                Speichern
              </Button>
              <Button
                variant="outline"
                onClick={cancelEditing}
                disabled={saving}
                data-testid="button-cancel-leistungen"
              >
                <X className={`${iconSize.sm} mr-2`} />
                Abbrechen
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-gray-700 whitespace-pre-wrap" data-testid="text-vereinbarte-leistungen">
            {customer.currentContract?.vereinbarteLeistungen || "Keine Angabe"}
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
