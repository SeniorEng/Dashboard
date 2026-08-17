import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import { DEACTIVATION_REASON_SELECT_OPTIONS } from "@shared/domain/customers";
import { PricingSection } from "./customer-pricing-section";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { customerKeys } from "@/features/customers";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { invalidateRelated } from "@/lib/query-invalidation";
import { iconSize, componentStyles } from "@/design-system";
import {
  FileText,
  ClipboardList,
  CreditCard,
  Car,
  Pencil,
  Save,
  X,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  UserX,
  Calendar,
  Euro,
  ShieldAlert,
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

interface DeactivationCheck {
  key: string;
  label: string;
  met: boolean;
  detail: string;
  /**
   * Darf die Geschäftsführung diese Prüfung bewusst übergehen? Kommt vom
   * Server, damit die Oberfläche die Gate-Liste nicht ein zweites Mal von Hand
   * führt — die Doppelung wäre beim Aufnehmen des Dokumentations-Gates still
   * auseinandergelaufen.
   */
  overridable: boolean;
}

interface DeactivationReadiness {
  ready: boolean;
  hasContractEnd: boolean;
  contractEnd: string | null;
  checks: DeactivationCheck[];
  futureAppointmentsCount: number;
  futureAppointments: Array<{ id: number; date: string; status: string }>;
  undocumentedCount: number;
  undocumentedAppointments: Array<{ id: number; date: string; status: string }>;
  message?: string;
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
  const [personenbefoerderungGewuenscht, setPersonenbefoerderungGewuenscht] = useState(false);
  const [acceptsPrivatePayment, setAcceptsPrivatePayment] = useState(false);
  const [beihilfeBerechtigt, setBeihilfeBerechtigt] = useState(false);
  const [rechnungAnKunde, setRechnungAnKunde] = useState(false);

  const [creatingContract, setCreatingContract] = useState(false);
  const [newContractStart, setNewContractStart] = useState("");

  const [deactivationReason, setDeactivationReason] = useState("");
  const [deactivationNote, setDeactivationNote] = useState("");

  const { user } = useAuth();
  const isSuperAdmin = user?.isSuperAdmin ?? false;
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const contract = customer.currentContract;

  const computedContractStatus = (() => {
    if (!contract) return null;
    if (contract.status === "terminated") return "terminated";
    if (contract.status === "paused") return "paused";
    if (contract.contractEnd) {
      const today = todayISO();
      if (contract.contractEnd < today) return "auslaufend";
    }
    return "active";
  })();

  const hasContractEnd = !!contract?.contractEnd;

  const { data: deactivationReadiness, isLoading: readinessLoading } = useQuery<DeactivationReadiness>({
    queryKey: ["deactivation-readiness", customerId],
    queryFn: async () => {
      const result = await api.get<DeactivationReadiness>(`/admin/customers/${customerId}/deactivation-readiness`);
      return unwrapResult(result);
    },
    enabled: hasContractEnd && customer.status === "aktiv",
    staleTime: 15000,
  });

  const startEditing = (section: string) => {
    if (section === "vertragsdaten" && contract) {
      setContractStart(contract.contractStart || "");
      setContractDate(contract.contractDate || "");
      setContractEnd(contract.contractEnd || "");
      setHoursPerPeriod(contract.hoursPerPeriod || 0);
      setPeriodType(contract.periodType || "week");
    } else if (section === "leistungen") {
      setVereinbarteLeistungen(contract?.vereinbarteLeistungen || "");
      setPersonenbefoerderungGewuenscht(customer.personenbefoerderungGewuenscht ?? false);
    } else if (section === "abrechnung") {
      setAcceptsPrivatePayment(customer.acceptsPrivatePayment ?? false);
      setBeihilfeBerechtigt(customer.beihilfeBerechtigt ?? false);
      setRechnungAnKunde(customer.rechnungAnKunde ?? false);
    }
    setEditingSection(section);
  };

  const cancelEditing = () => {
    setEditingSection(null);
  };

  const hasVertragsdatenChanges = useMemo(() => {
    if (editingSection !== "vertragsdaten" || !contract) return false;
    if ((contractStart || "") !== (contract.contractStart || "")) return true;
    if ((contractDate || "") !== (contract.contractDate || "")) return true;
    if ((contractEnd || "") !== (contract.contractEnd || "")) return true;
    if ((hoursPerPeriod || 0) !== (contract.hoursPerPeriod || 0)) return true;
    if ((periodType || "week") !== (contract.periodType || "week")) return true;
    return false;
  }, [editingSection, contract, contractStart, contractDate, contractEnd, hoursPerPeriod, periodType]);

  const hasLeistungenChanges = useMemo(() => {
    if (editingSection !== "leistungen") return false;
    const initialText = contract?.vereinbarteLeistungen || "";
    if ((vereinbarteLeistungen.trim() || "") !== initialText) return true;
    if (personenbefoerderungGewuenscht !== (customer.personenbefoerderungGewuenscht ?? false)) return true;
    return false;
  }, [editingSection, contract?.vereinbarteLeistungen, vereinbarteLeistungen, personenbefoerderungGewuenscht, customer.personenbefoerderungGewuenscht]);

  const hasAbrechnungChanges = useMemo(() => {
    if (editingSection !== "abrechnung") return false;
    if (acceptsPrivatePayment !== (customer.acceptsPrivatePayment ?? false)) return true;
    if (customer.billingType === "pflegekasse_privat" && beihilfeBerechtigt !== (customer.beihilfeBerechtigt ?? false)) return true;
    if (customer.billingType === "pflegekasse_gesetzlich" && rechnungAnKunde !== (customer.rechnungAnKunde ?? false)) return true;
    return false;
  }, [editingSection, acceptsPrivatePayment, beihilfeBerechtigt, rechnungAnKunde, customer.acceptsPrivatePayment, customer.beihilfeBerechtigt, customer.rechnungAnKunde, customer.billingType]);

  const invalidateCustomer = () => {
    invalidateRelated(queryClient, "customers");
    // invalidate-direct-allowed: customer-scoped readiness key not covered by a domain
    // eslint-disable-next-line no-restricted-syntax
    queryClient.invalidateQueries({ queryKey: ["deactivation-readiness", customerId] });
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
    } catch (error: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: error instanceof Error ? error.message : "Vertrag konnte nicht angelegt werden." });
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
    } catch (error: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: error instanceof Error ? error.message : "Speichern fehlgeschlagen." });
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
      const customerPatch = await api.patch(`/admin/customers/${customerId}`, {
        personenbefoerderungGewuenscht,
      });
      unwrapResult(customerPatch);
      toast({ title: "Vereinbarte Leistungen gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: error instanceof Error ? error.message : "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const handleReactivateContract = async () => {
    setSaving(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}/contract`, {
        status: "active",
        contractEnd: null,
      });
      unwrapResult(result);
      toast({ title: "Vertrag reaktiviert" });
      invalidateCustomer();
    } catch (error: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: error instanceof Error ? error.message : "Vertrag konnte nicht reaktiviert werden." });
    } finally {
      setSaving(false);
    }
  };

  const completeDeactivation = useMutation({
    mutationFn: async (override?: { overrideBillingGates: true; overrideReason: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/complete-deactivation`, {
        deactivationReason,
        deactivationNote: deactivationNote.trim() || undefined,
        ...(override ? { overrideBillingGates: true, overrideReason: override.overrideReason } : {}),
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateCustomer();
      toast({ title: "Vertrag beendet & Kunde deaktiviert", description: "Der Kunde wurde erfolgreich deaktiviert." });
      setDeactivationReason("");
      setDeactivationNote("");
      setOverrideReason("");
      setOverrideDialogOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Fehler", description: err.message, variant: "destructive" });
    },
  });

  const saveAbrechnung = useMutation({
    mutationFn: async (data: { acceptsPrivatePayment: boolean; beihilfeBerechtigt: boolean; rechnungAnKunde: boolean }) => {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        acceptsPrivatePayment: data.acceptsPrivatePayment,
        beihilfeBerechtigt: data.beihilfeBerechtigt,
        rechnungAnKunde: data.rechnungAnKunde,
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

  const saveCancel = (
    onSave: () => void,
    isSaving: boolean,
    testIdPrefix: string,
    extraDisabled = false,
    hasChanges = true,
  ) => (
    <div className="flex items-center gap-2 pt-3">
      <Button
        className={componentStyles.btnPrimary}
        onClick={onSave}
        disabled={isSaving || extraDisabled || !hasChanges}
        title={!isSaving && !extraDisabled && !hasChanges ? "Keine Änderungen zu speichern" : undefined}
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
                <p className="text-sm text-gray-500" data-testid="text-no-contract">Kein aktiver Vertrag vorhanden</p>
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
                <p className="text-xs text-muted-foreground">
                  Das Vertragsende steuert den gesamten Deaktivierungsprozess.
                </p>
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
            {saveCancel(handleSaveVertragsdaten, saving, "vertragsdaten", false, hasVertragsdatenChanges)}
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
                    : "Kein Ende festgelegt (unbefristet)"}
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
                <StatusBadge type="contract" value={computedContractStatus || contract.status} />
              </div>
            </div>
            {contract.status === "terminated" && (
              <div className="pt-3 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReactivateContract}
                  disabled={saving}
                  data-testid="button-reactivate-contract"
                >
                  Vertrag reaktivieren
                </Button>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {contract && hasContractEnd && customer.status === "aktiv" && (
        <SectionCard
          title="Vertragsende & Deaktivierung"
          icon={<Calendar className={iconSize.sm} />}
        >
          <div className="space-y-4">
            {deactivationReadiness?.futureAppointmentsCount && deactivationReadiness.futureAppointmentsCount > 0 ? (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                <div className="flex items-start gap-2">
                  <AlertTriangle className={`${iconSize.sm} text-amber-600 mt-0.5 shrink-0`} />
                  <div>
                    <p className="text-sm font-medium text-amber-900">
                      {deactivationReadiness.futureAppointmentsCount} Termin(e) nach Vertragsende
                    </p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      Es gibt Termine nach dem {formatDateForDisplay(contract.contractEnd!)}. Diese sollten storniert oder verschoben werden.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {readinessLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className={`${iconSize.sm} animate-spin`} />
                <span>Deaktivierungsstatus wird geprüft...</span>
              </div>
            ) : deactivationReadiness?.checks && deactivationReadiness.checks.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-700">Checkliste vor Deaktivierung:</p>
                {deactivationReadiness.checks.map((check) => (
                  <div
                    key={check.key}
                    className={`flex items-start gap-2 text-sm ${check.met ? "text-green-700" : "text-gray-600"}`}
                    data-testid={`check-${check.key}`}
                  >
                    {check.met ? (
                      <CheckCircle2 className={`${iconSize.sm} text-green-600 shrink-0 mt-0.5`} />
                    ) : (
                      <XCircle className={`${iconSize.sm} text-gray-500 shrink-0 mt-0.5`} />
                    )}
                    <div>
                      <span className="font-medium">{check.label}</span>
                      <p className="text-xs text-gray-500">{check.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {deactivationReadiness?.ready ? (
              <div className="pt-3 border-t space-y-3">
                <p className="text-sm text-green-700 font-medium">
                  Alle Bedingungen erfüllt — der Kunde kann deaktiviert werden.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="deact-reason">Deaktivierungsgrund *</Label>
                  <Select value={deactivationReason} onValueChange={setDeactivationReason}>
                    <SelectTrigger id="deact-reason" data-testid="select-deactivation-reason">
                      <SelectValue placeholder="Grund auswählen..." />
                    </SelectTrigger>
                    <SelectContent>
                      {DEACTIVATION_REASON_SELECT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} data-testid={`option-reason-${opt.value}`}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="deact-note">
                    {deactivationReason === "sonstiges" ? "Beschreibung *" : "Anmerkung (optional)"}
                  </Label>
                  <Textarea
                    id="deact-note"
                    value={deactivationNote}
                    onChange={(e) => setDeactivationNote(e.target.value)}
                    placeholder={deactivationReason === "sonstiges" ? "Bitte beschreiben Sie den Grund..." : "Optionale Anmerkung..."}
                    maxLength={1000}
                    rows={2}
                    data-testid="textarea-deactivation-note"
                  />
                </div>
                <Button
                  variant="destructive"
                  onClick={() => completeDeactivation.mutate(undefined)}
                  disabled={
                    !deactivationReason ||
                    (deactivationReason === "sonstiges" && !deactivationNote.trim()) ||
                    completeDeactivation.isPending
                  }
                  data-testid="button-complete-deactivation"
                >
                  {completeDeactivation.isPending ? (
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  ) : (
                    <UserX className={`${iconSize.sm} mr-2`} />
                  )}
                  Vertrag beenden & Kunden deaktivieren
                </Button>
              </div>
            ) : deactivationReadiness && !deactivationReadiness.ready ? (
              (() => {
                const checkMet = (key: string) =>
                  deactivationReadiness.checks.find((c) => c.key === key)?.met ?? false;
                // Was offen ist, entscheidet der SERVER über `overridable` —
                // hier wird die Liste nicht mehr von Hand nachgebaut. Vorher
                // stand hier eine zweite Aufzählung der Gates; sie hätte beim
                // Aufnehmen des Dokumentations-Gates still danebengelegen und
                // den Override weiterhin verweigert.
                const offeneNichtUebergehbare = deactivationReadiness.checks.filter(
                  (c) => !c.met && !c.overridable,
                );
                const offeneUebergehbare = deactivationReadiness.checks.filter(
                  (c) => !c.met && c.overridable,
                );
                const canOverride =
                  isSuperAdmin && offeneNichtUebergehbare.length === 0 && offeneUebergehbare.length > 0;
                return (
                  <div className="pt-3 border-t space-y-3">
                    <p className="text-sm text-gray-500">
                      Bitte schließen Sie alle offenen Punkte ab, bevor der Kunde deaktiviert werden kann.
                    </p>
                    {canOverride && (
                      <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 space-y-2">
                        <div className="flex items-start gap-2">
                          <ShieldAlert className={`${iconSize.sm} text-amber-600 mt-0.5 shrink-0`} />
                          <div>
                            <p className="text-sm font-medium text-amber-900">
                              Superadmin-Override verfügbar
                            </p>
                            <p className="text-xs text-amber-700 mt-0.5">
                              Das Vertragsende ist erreicht. Sie können die offenen Abrechnungs-Prüfungen
                              ({offeneUebergehbare.map((c) => c.label).join(", ")}) mit Begründung
                              überspringen — z. B. wenn die Monate extern abgerechnet wurden oder eine
                              Dokumentation nicht mehr nachzuholen ist.
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setOverrideDialogOpen(true)}
                          data-testid="button-open-override-deactivation"
                        >
                          <ShieldAlert className={`${iconSize.sm} mr-2`} />
                          Abrechnungs-Prüfungen überspringen
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })()
            ) : null}
          </div>

          <Dialog open={overrideDialogOpen} onOpenChange={(open) => { if (!completeDeactivation.isPending) setOverrideDialogOpen(open); }}>
            <DialogContent data-testid="dialog-override-deactivation">
              <DialogHeader>
                <DialogTitle>Abrechnungs-Prüfungen überspringen</DialogTitle>
                <DialogDescription>
                  Sie überspringen als Hauptadministrator die Abrechnungs-Prüfungen — Dokumentation, Leistungsnachweise und Rechnungen. Das Vertragsende bleibt verpflichtend. Der Vorgang wird vollständig protokolliert.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {/*
                  Muster #1883: den Eingriff AUSWEISEN, nicht verbieten. Wer
                  hier klickt, soll wissen, welche Leistung unabgerechnet
                  stehen bleibt — mit Zahl und Beispielen, nicht abstrakt.

                  Ausdrücklich KEINE Verlust-Warnung: die Termine verschwinden
                  nicht. Sie bleiben offen, sichtbar und abrechenbar; weder die
                  Nachweis-Übersicht noch der Abrechnungspfad filtern auf den
                  Kundenstatus. Was wegfällt, ist die Erinnerung daran — der
                  Kunde taucht in keiner Tagesarbeit mehr auf. Genau das muss
                  hier stehen und nicht mehr.
                */}
                {(deactivationReadiness?.undocumentedCount ?? 0) > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid="warning-undocumented-override">
                    <p className="text-sm font-medium text-amber-800">
                      {deactivationReadiness!.undocumentedCount}{" "}
                      {deactivationReadiness!.undocumentedCount === 1 ? "Termin bleibt" : "Termine bleiben"} unabgerechnet — bitte bestätigen
                    </p>
                    <p className="mt-1 text-sm text-amber-700">
                      {deactivationReadiness!.undocumentedCount === 1 ? "Dieser Termin ist" : "Diese Termine sind"} noch nicht dokumentiert.
                      {" "}Sie {deactivationReadiness!.undocumentedCount === 1 ? "bleibt" : "bleiben"} nach der Deaktivierung bestehen und {deactivationReadiness!.undocumentedCount === 1 ? "kann" : "können"} weiterhin
                      dokumentiert und abgerechnet werden — der Kunde erscheint danach aber in keiner
                      Tagesübersicht mehr, es erinnert also niemand daran.
                    </p>
                    {deactivationReadiness!.undocumentedAppointments.length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-sm text-amber-700">
                        {deactivationReadiness!.undocumentedAppointments.map((a) => (
                          <li key={a.id} data-testid={`undocumented-appt-${a.id}`}>{a.date}</li>
                        ))}
                      </ul>
                    )}
                    {deactivationReadiness!.undocumentedCount > deactivationReadiness!.undocumentedAppointments.length && (
                      <p className="mt-1 text-sm text-amber-700">
                        … und {deactivationReadiness!.undocumentedCount - deactivationReadiness!.undocumentedAppointments.length} weitere
                      </p>
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="override-deact-reason">Deaktivierungsgrund *</Label>
                  <Select value={deactivationReason} onValueChange={setDeactivationReason}>
                    <SelectTrigger id="override-deact-reason" data-testid="select-override-deactivation-reason">
                      <SelectValue placeholder="Grund auswählen..." />
                    </SelectTrigger>
                    <SelectContent>
                      {DEACTIVATION_REASON_SELECT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} data-testid={`option-override-reason-${opt.value}`}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="override-reason">Begründung für den Override * (mind. 10 Zeichen)</Label>
                  <Textarea
                    id="override-reason"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="z. B. Monate 01–03/2026 wurden vor der Migration extern über DMRZ abgerechnet."
                    maxLength={1000}
                    rows={3}
                    data-testid="textarea-override-reason"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setOverrideDialogOpen(false)}
                  disabled={completeDeactivation.isPending}
                  data-testid="button-cancel-override"
                >
                  Abbrechen
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => completeDeactivation.mutate({ overrideBillingGates: true, overrideReason: overrideReason.trim() })}
                  disabled={
                    !deactivationReason ||
                    overrideReason.trim().length < 10 ||
                    completeDeactivation.isPending
                  }
                  data-testid="button-confirm-override-deactivation"
                >
                  {completeDeactivation.isPending ? (
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  ) : (
                    <UserX className={`${iconSize.sm} mr-2`} />
                  )}
                  Override & Kunden deaktivieren
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </SectionCard>
      )}

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
            <div className="flex items-center justify-between">
              <Label htmlFor="personenbefoerderung" className="cursor-pointer flex items-center gap-2">
                <Car className={`${iconSize.sm} text-gray-500`} />
                Personenbeförderung gewünscht
              </Label>
              <Switch
                id="personenbefoerderung"
                checked={personenbefoerderungGewuenscht}
                onCheckedChange={(checked) => setPersonenbefoerderungGewuenscht(checked)}
                data-testid="switch-personenbefoerderung"
              />
            </div>
            {saveCancel(handleSaveLeistungen, saving, "leistungen", false, hasLeistungenChanges)}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-gray-700 whitespace-pre-wrap" data-testid="text-vereinbarte-leistungen">
              {contract?.vereinbarteLeistungen || "Keine Angabe"}
            </p>
            <div className="flex items-center gap-2 text-gray-700" data-testid="text-personenbefoerderung">
              <Car className={`${iconSize.sm} text-gray-500`} />
              Personenbeförderung: {customer.personenbefoerderungGewuenscht ? "Ja" : "Nein"}
            </div>
          </div>
        )}
      </SectionCard>

      {customer.billingType === "selbstzahler" && (
        <SectionCard
          title="Abrechnung"
          icon={<CreditCard className={iconSize.sm} />}
        >
          <div className="space-y-2 text-sm" data-testid="text-selbstzahler-hinweis">
            <p className="text-gray-700">
              Selbstzahler — Rechnungen gehen immer direkt an den Kunden. Keine Verrechnung mit der Pflegekasse, jeder dokumentierte Termin wird in voller Höhe privat verbucht.
            </p>
          </div>
        </SectionCard>
      )}

      {customer.billingType !== "selbstzahler" && <SectionCard
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
            {customer.billingType === "pflegekasse_privat" && (
              <div className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
                <div className="space-y-0.5">
                  <Label htmlFor="beihilfeBerechtigt" className="cursor-pointer">Beihilfeberechtigt</Label>
                  <p className="text-xs text-gray-500">Rechnungen und Leistungsnachweise werden in doppelter Ausfertigung erstellt</p>
                </div>
                <Switch
                  id="beihilfeBerechtigt"
                  checked={beihilfeBerechtigt}
                  onCheckedChange={setBeihilfeBerechtigt}
                  data-testid="switch-beihilfe-berechtigt"
                />
              </div>
            )}
            {customer.billingType === "pflegekasse_gesetzlich" && (
              <div className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
                <div className="space-y-0.5">
                  <Label htmlFor="rechnungAnKunde" className="cursor-pointer">Kostenerstattungsverfahren</Label>
                  <p className="text-xs text-gray-500">Rechnung an den Kunden adressieren — Kunde zahlt selbst und reicht bei seiner gesetzlichen Pflegekasse zur Erstattung ein.</p>
                </div>
                <Switch
                  id="rechnungAnKunde"
                  checked={rechnungAnKunde}
                  onCheckedChange={setRechnungAnKunde}
                  data-testid="switch-rechnung-an-kunde"
                />
              </div>
            )}
            <div className="flex items-center gap-2 pt-3">
              <Button
                className={componentStyles.btnPrimary}
                onClick={() => saveAbrechnung.mutate({ acceptsPrivatePayment, beihilfeBerechtigt, rechnungAnKunde })}
                disabled={saveAbrechnung.isPending || !hasAbrechnungChanges}
                title={!saveAbrechnung.isPending && !hasAbrechnungChanges ? "Keine Änderungen zu speichern" : undefined}
                data-testid="button-save-abrechnung"
              >
                {saveAbrechnung.isPending ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Save className={`${iconSize.sm} mr-2`} />
                )}
                Speichern
              </Button>
              <Button
                variant="outline"
                onClick={cancelEditing}
                disabled={saveAbrechnung.isPending}
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
            {customer.billingType === "pflegekasse_privat" && (
              <div className="flex items-center gap-2" data-testid="text-beihilfe-berechtigt">
                <p className="text-sm text-gray-700">Beihilfeberechtigt:</p>
                <StatusBadge
                  type={customer.beihilfeBerechtigt ? "activity" : "info"}
                  value={customer.beihilfeBerechtigt ? "Ja" : "Nein"}
                />
              </div>
            )}
            {customer.billingType === "pflegekasse_gesetzlich" && (
              <div className="flex items-center gap-2" data-testid="text-rechnung-an-kunde">
                <p className="text-sm text-gray-700">Kostenerstattungsverfahren:</p>
                <StatusBadge
                  type={customer.rechnungAnKunde ? "activity" : "info"}
                  value={customer.rechnungAnKunde ? "Ja" : "Nein"}
                />
              </div>
            )}
          </div>
        )}
      </SectionCard>}

      {customer.billingType === "selbstzahler" && (
        <SectionCard
          title="Preisvereinbarung"
          icon={<Euro className={iconSize.sm} />}
        >
          <PricingSection
            customerId={customerId}
            customerName={`${customer.vorname ?? ""} ${customer.nachname ?? ""}`.trim() || customer.name}
            billingType={customer.billingType ?? undefined}
            onRefresh={() => {
              invalidateRelated(queryClient, "customers");
            }}
          />
        </SectionCard>
      )}
    </div>
  );
}
