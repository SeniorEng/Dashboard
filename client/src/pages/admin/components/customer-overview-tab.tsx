import { useState, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import { formatAddress } from "@shared/utils/format";
import { formatPhoneForDisplay, validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import { PFLEGEGRAD_SELECT_OPTIONS, BILLING_TYPE_SELECT_OPTIONS, isPflegekasseCustomer } from "@shared/domain/customers";
import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { useEmployees, customerKeys } from "@/features/customers";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { iconSize, componentStyles } from "@/design-system";
import { AddressFields } from "./address-fields";
import { EmployeeMatching } from "./employee-matching";
import {
  User2, MapPin, Phone, Mail, Shield, Users, Calendar, FileText,
  PawPrint, Stethoscope, History, Send, Pencil, Save, X,
  Loader2, Car, Truck,
} from "lucide-react";
import type { CustomerDetail } from "@/lib/api/types";

interface CustomerOverviewTabProps {
  customer: CustomerDetail;
  customerId: number;
}

export function CustomerOverviewTab({ customer, customerId }: CustomerOverviewTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: employees } = useEmployees();

  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [stammdaten, setStammdaten] = useState({
    vorname: "",
    nachname: "",
    billingType: "pflegekasse_gesetzlich" as string,
    geburtsdatum: "",
    email: "",
    telefon: "",
    festnetz: "",
    strasse: "",
    nr: "",
    plz: "",
    stadt: "",
  });
  const [phoneErrors, setPhoneErrors] = useState<Record<string, string | null>>({});

  const [employeeData, setEmployeeData] = useState({
    primaryEmployeeId: "",
    backupEmployeeId: "",
  });

  const [newPflegegrad, setNewPflegegrad] = useState<string>("");
  const [pflegegradSeit, setPflegegradSeit] = useState<string>(todayISO());

  const [vorerkrankungen, setVorerkrankungen] = useState("");

  const [besonderheiten, setBesonderheiten] = useState({
    haustierVorhanden: false,
    haustierDetails: "",
    personenbefoerderungGewuenscht: false,
    inaktivAb: "",
  });

  const [documentDeliveryMethod, setDocumentDeliveryMethod] = useState<"email" | "post">("email");

  const currentCareLevel = customer.careLevelHistory?.find((e) => !e.validTo);

  const employeeOptions = useMemo(() => [
    { value: "", label: "Nicht zugewiesen" },
    ...(employees?.map((emp) => ({
      value: emp.id.toString(),
      label: emp.displayName,
    })) || []),
  ], [employees]);

  const initStammdaten = () => {
    setStammdaten({
      vorname: customer.vorname || "",
      nachname: customer.nachname || "",
      billingType: customer.billingType || "pflegekasse_gesetzlich",
      geburtsdatum: customer.geburtsdatum || "",
      email: customer.email || "",
      telefon: customer.telefon || "",
      festnetz: customer.festnetz || "",
      strasse: customer.strasse || "",
      nr: customer.nr || "",
      plz: customer.plz || "",
      stadt: customer.stadt || "",
    });
    setPhoneErrors({});
  };

  const initEmployeeData = () => {
    setEmployeeData({
      primaryEmployeeId: customer.primaryEmployee?.id?.toString() || "",
      backupEmployeeId: customer.backupEmployee?.id?.toString() || "",
    });
  };

  const initPflegegrad = () => {
    setNewPflegegrad("");
    setPflegegradSeit(todayISO());
  };

  const initVorerkrankungen = () => {
    setVorerkrankungen(customer.vorerkrankungen || "");
  };

  const initBesonderheiten = () => {
    setBesonderheiten({
      haustierVorhanden: customer.haustierVorhanden ?? false,
      haustierDetails: customer.haustierDetails || "",
      personenbefoerderungGewuenscht: customer.personenbefoerderungGewuenscht ?? false,
      inaktivAb: customer.inaktivAb || "",
    });
  };

  const initDocumentDelivery = () => {
    setDocumentDeliveryMethod((customer.documentDeliveryMethod as "email" | "post") || "email");
  };

  const startEditing = (section: string) => {
    switch (section) {
      case "kontakt": initStammdaten(); break;
      case "mitarbeiter": initEmployeeData(); break;
      case "pflegegrad": initPflegegrad(); break;
      case "vorerkrankungen": initVorerkrankungen(); break;
      case "besonderheiten": initBesonderheiten(); break;
      case "versandart": initDocumentDelivery(); break;
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

  const handlePhoneChange = (field: "telefon" | "festnetz", value: string) => {
    const formatted = formatPhoneAsYouType(value);
    setStammdaten((prev) => ({ ...prev, [field]: formatted }));
    if (formatted.length > 3) {
      const validation = validateGermanPhone(formatted);
      setPhoneErrors((prev) => ({
        ...prev,
        [field]: validation.valid ? null : "Ungültige Telefonnummer",
      }));
    } else {
      setPhoneErrors((prev) => ({ ...prev, [field]: null }));
    }
  };

  const handleSaveStammdaten = async () => {
    if (!stammdaten.vorname.trim() || !stammdaten.nachname.trim()) {
      toast({ title: "Pflichtfelder fehlen", description: "Vorname und Nachname sind erforderlich.", variant: "destructive" });
      return;
    }
    if (phoneErrors.telefon || phoneErrors.festnetz) {
      toast({ title: "Ungültige Telefonnummer", description: "Bitte korrigieren Sie die Telefonnummer(n).", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const data: Record<string, unknown> = {
        vorname: stammdaten.vorname.trim(),
        nachname: stammdaten.nachname.trim(),
        billingType: stammdaten.billingType,
        geburtsdatum: stammdaten.geburtsdatum?.trim() || null,
        email: stammdaten.email.trim() || null,
        telefon: stammdaten.telefon.trim() ? normalizePhone(stammdaten.telefon) : null,
        festnetz: stammdaten.festnetz.trim() ? normalizePhone(stammdaten.festnetz) : null,
        strasse: stammdaten.strasse.trim() || null,
        nr: stammdaten.nr.trim() || null,
        plz: stammdaten.plz.trim() || null,
        stadt: stammdaten.stadt.trim() || null,
      };
      const result = await api.patch(`/admin/customers/${customerId}`, data);
      unwrapResult(result);
      toast({ title: "Kontaktdaten gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEmployees = async () => {
    const primaryId = employeeData.primaryEmployeeId ? parseInt(employeeData.primaryEmployeeId) : null;
    const backupId = employeeData.backupEmployeeId ? parseInt(employeeData.backupEmployeeId) : null;
    if (primaryId && backupId && primaryId === backupId) {
      toast({ title: "Ungültige Auswahl", description: "Haupt- und Vertretungsmitarbeiter dürfen nicht identisch sein.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        primaryEmployeeId: primaryId,
        backupEmployeeId: backupId,
      });
      unwrapResult(result);
      toast({ title: "Mitarbeiterzuordnung gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const changeCareLevelMutation = useMutation({
    mutationFn: async (data: { pflegegrad: number; validFrom: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/care-level`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Pflegegrad aktualisiert", description: "Der Pflegegrad wurde mit Historisierung gespeichert." });
      invalidateCustomer();
      setEditingSection(null);
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const handleSaveVorerkrankungen = async () => {
    setSaving(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        vorerkrankungen: vorerkrankungen.trim() || null,
      });
      unwrapResult(result);
      toast({ title: "Vorerkrankungen gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBesonderheiten = async () => {
    setSaving(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        haustierVorhanden: besonderheiten.haustierVorhanden,
        haustierDetails: besonderheiten.haustierVorhanden ? (besonderheiten.haustierDetails?.trim() || null) : null,
        personenbefoerderungGewuenscht: besonderheiten.personenbefoerderungGewuenscht,
        inaktivAb: besonderheiten.inaktivAb?.trim() || null,
      });
      unwrapResult(result);
      toast({ title: "Besonderheiten gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDocumentDelivery = async () => {
    setSaving(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        documentDeliveryMethod,
      });
      unwrapResult(result);
      toast({ title: "Versandart gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

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

  const saveCancel = (onSave: () => void, testIdPrefix: string) => (
    <div className="flex items-center gap-2 pt-3">
      <Button
        className={componentStyles.btnPrimary}
        onClick={onSave}
        disabled={saving || changeCareLevelMutation.isPending}
        data-testid={`button-save-${testIdPrefix}`}
      >
        {saving || changeCareLevelMutation.isPending ? (
          <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
        ) : (
          <Save className={`${iconSize.sm} mr-2`} />
        )}
        Speichern
      </Button>
      <Button
        variant="outline"
        onClick={cancelEditing}
        disabled={saving || changeCareLevelMutation.isPending}
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
        title="Kontaktdaten"
        icon={<User2 className={iconSize.sm} />}
        actions={editingSection !== "kontakt" ? editButton("kontakt") : undefined}
      >
        {editingSection === "kontakt" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="vorname">Vorname *</Label>
                <Input
                  id="vorname"
                  value={stammdaten.vorname}
                  onChange={(e) => setStammdaten((prev) => ({ ...prev, vorname: e.target.value }))}
                  placeholder="Vorname"
                  data-testid="input-vorname"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="nachname">Nachname *</Label>
                <Input
                  id="nachname"
                  value={stammdaten.nachname}
                  onChange={(e) => setStammdaten((prev) => ({ ...prev, nachname: e.target.value }))}
                  placeholder="Nachname"
                  data-testid="input-nachname"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Kundentyp</Label>
              <Select
                value={stammdaten.billingType}
                onValueChange={(value) => setStammdaten((prev) => ({ ...prev, billingType: value }))}
              >
                <SelectTrigger data-testid="select-billingtype">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BILLING_TYPE_SELECT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Geburtsdatum</Label>
              <DatePicker
                value={stammdaten.geburtsdatum || null}
                onChange={(val) => setStammdaten((prev) => ({ ...prev, geburtsdatum: val || "" }))}
                data-testid="input-geburtsdatum"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">E-Mail</Label>
              <Input
                id="email"
                type="email"
                value={stammdaten.email}
                onChange={(e) => setStammdaten((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="email@beispiel.de"
                data-testid="input-email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="telefon">Mobiltelefon</Label>
              <Input
                id="telefon"
                value={stammdaten.telefon}
                onChange={(e) => handlePhoneChange("telefon", e.target.value)}
                placeholder="+49 170 1234567"
                className={phoneErrors.telefon ? "border-red-500" : ""}
                data-testid="input-telefon"
              />
              {phoneErrors.telefon && (
                <p className="text-sm text-red-500">{phoneErrors.telefon}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="festnetz">Festnetz</Label>
              <Input
                id="festnetz"
                value={stammdaten.festnetz}
                onChange={(e) => handlePhoneChange("festnetz", e.target.value)}
                placeholder="+49 30 1234567"
                className={phoneErrors.festnetz ? "border-red-500" : ""}
                data-testid="input-festnetz"
              />
              {phoneErrors.festnetz && (
                <p className="text-sm text-red-500">{phoneErrors.festnetz}</p>
              )}
            </div>

            <AddressFields
              strasse={stammdaten.strasse}
              nr={stammdaten.nr}
              plz={stammdaten.plz}
              stadt={stammdaten.stadt}
              onChange={(field, value) => setStammdaten((prev) => ({ ...prev, [field]: value }))}
            />

            {saveCancel(handleSaveStammdaten, "kontakt")}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-gray-700">
              <Calendar className={`${iconSize.sm} text-gray-500`} />
              Geb.: {customer.geburtsdatum ? formatDateForDisplay(customer.geburtsdatum) : "Nicht angegeben"}
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <MapPin className={`${iconSize.sm} text-gray-500`} />
              {formatAddress(customer) || "Keine Adresse"}
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <Phone className={`${iconSize.sm} text-gray-500`} />
              Mobil: {customer.telefon ? formatPhoneForDisplay(customer.telefon) : "Nicht angegeben"}
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <Phone className={`${iconSize.sm} text-gray-500`} />
              Festnetz: {customer.festnetz ? formatPhoneForDisplay(customer.festnetz) : "Kein Festnetz"}
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <Mail className={`${iconSize.sm} text-gray-500`} />
              {customer.email || "Keine E-Mail"}
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Zuständige Mitarbeiter"
        icon={<Users className={iconSize.sm} />}
        actions={editingSection !== "mitarbeiter" ? editButton("mitarbeiter") : undefined}
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
              <Label>Vertretung</Label>
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

            <EmployeeMatching
              customerId={customerId}
              onSelect={(employeeId, displayName) => {
                setEmployeeData((prev) => ({ ...prev, primaryEmployeeId: employeeId.toString() }));
              }}
              selectedLabel="Vorschläge für Hauptzuständig"
            />

            {saveCancel(handleSaveEmployees, "mitarbeiter")}
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
              <p className="text-sm text-gray-500">Vertretung</p>
              <p className="font-medium" data-testid="text-backup-employee">
                {customer.backupEmployee?.displayName || "Nicht zugewiesen"}
              </p>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Pflegegrad"
        icon={<Shield className={iconSize.sm} />}
        actions={editingSection !== "pflegegrad" ? editButton("pflegegrad") : undefined}
      >
        {editingSection === "pflegegrad" ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
              <span className="text-sm text-gray-600">Aktueller Pflegegrad:</span>
              {customer.pflegegrad != null && customer.pflegegrad > 0 ? (
                <>
                  <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
                  {currentCareLevel?.validFrom && (
                    <span className="text-xs text-gray-500">
                      seit {formatDateForDisplay(currentCareLevel.validFrom)}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-sm text-gray-500">Nicht festgelegt</span>
              )}
            </div>

            <p className="text-xs text-gray-500">
              Der bisherige Pflegegrad wird mit Enddatum gespeichert und bleibt für Budgets und Rechnungen nachvollziehbar.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Neuer Pflegegrad</Label>
                <Select value={newPflegegrad} onValueChange={setNewPflegegrad}>
                  <SelectTrigger data-testid="select-new-pflegegrad">
                    <SelectValue placeholder="Auswählen" />
                  </SelectTrigger>
                  <SelectContent>
                    {PFLEGEGRAD_SELECT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Gültig ab</Label>
                <DatePicker
                  value={pflegegradSeit}
                  onChange={(val) => setPflegegradSeit(val || todayISO())}
                  data-testid="input-pflegegrad-seit"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 pt-3">
              <Button
                className={componentStyles.btnPrimary}
                onClick={() => {
                  if (!newPflegegrad) {
                    toast({ title: "Bitte Pflegegrad auswählen", variant: "destructive" });
                    return;
                  }
                  changeCareLevelMutation.mutate({
                    pflegegrad: parseInt(newPflegegrad),
                    validFrom: pflegegradSeit,
                  });
                }}
                disabled={changeCareLevelMutation.isPending || !newPflegegrad}
                data-testid="button-save-pflegegrad"
              >
                {changeCareLevelMutation.isPending ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Save className={`${iconSize.sm} mr-2`} />
                )}
                Speichern
              </Button>
              <Button
                variant="outline"
                onClick={cancelEditing}
                disabled={changeCareLevelMutation.isPending}
                data-testid="button-cancel-pflegegrad"
              >
                <X className={`${iconSize.sm} mr-2`} />
                Abbrechen
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {customer.pflegegrad != null && customer.pflegegrad > 0 ? (
              <>
                <div className="flex items-center gap-3">
                  <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
                </div>
                {currentCareLevel?.validFrom && (
                  <p className="text-sm text-gray-500">
                    Seit {formatDateForDisplay(currentCareLevel.validFrom)}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500" data-testid="text-pflegegrad-empty">Nicht festgelegt</p>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Pflegegrad-Verlauf"
        icon={<History className={iconSize.sm} />}
      >
        {customer.careLevelHistory && customer.careLevelHistory.length > 0 ? (
          <div className="relative">
            <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />
            <div className="space-y-3">
              {customer.careLevelHistory.map((entry, index) => (
                <div key={entry.id} className="relative pl-10">
                  <div
                    className={`absolute left-2.5 w-3 h-3 rounded-full ${
                      index === 0 ? "bg-teal-500" : "bg-gray-300"
                    }`}
                  />
                  <div className="p-3 rounded-lg bg-gray-50">
                    <div className="flex items-center justify-between">
                      <StatusBadge type="pflegegrad" value={entry.pflegegrad} />
                      <span className="text-xs text-gray-500">
                        {formatDateForDisplay(entry.validFrom)}
                        {entry.validTo && ` - ${formatDateForDisplay(entry.validTo)}`}
                      </span>
                    </div>
                    {entry.notes && (
                      <p className="text-sm text-gray-600 mt-2">{entry.notes}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500" data-testid="text-care-history-empty">Kein Verlauf vorhanden</p>
        )}
      </SectionCard>

      <SectionCard
        title="Vorerkrankungen"
        icon={<Stethoscope className={iconSize.sm} />}
        actions={editingSection !== "vorerkrankungen" ? editButton("vorerkrankungen") : undefined}
      >
        {editingSection === "vorerkrankungen" ? (
          <div className="space-y-4">
            <Textarea
              value={vorerkrankungen}
              onChange={(e) => setVorerkrankungen(e.target.value)}
              placeholder="Vorerkrankungen des Kunden..."
              rows={3}
              data-testid="input-vorerkrankungen"
            />
            {saveCancel(handleSaveVorerkrankungen, "vorerkrankungen")}
          </div>
        ) : (
          <p className="text-gray-700 whitespace-pre-wrap" data-testid="text-vorerkrankungen">
            {customer.vorerkrankungen || "Keine Angabe"}
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Besonderheiten"
        icon={<PawPrint className={iconSize.sm} />}
        actions={editingSection !== "besonderheiten" ? editButton("besonderheiten") : undefined}
      >
        {editingSection === "besonderheiten" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="haustierVorhanden" className="cursor-pointer">Haustier vorhanden</Label>
              <Switch
                id="haustierVorhanden"
                checked={besonderheiten.haustierVorhanden}
                onCheckedChange={(checked) => setBesonderheiten((prev) => ({ ...prev, haustierVorhanden: checked }))}
                data-testid="switch-haustier"
              />
            </div>
            {besonderheiten.haustierVorhanden && (
              <div className="space-y-2">
                <Label htmlFor="haustierDetails">Details zum Haustier</Label>
                <Input
                  id="haustierDetails"
                  value={besonderheiten.haustierDetails}
                  onChange={(e) => setBesonderheiten((prev) => ({ ...prev, haustierDetails: e.target.value }))}
                  placeholder="z.B. Hund, Katze..."
                  data-testid="input-haustier-details"
                />
              </div>
            )}
            <div className="flex items-center justify-between">
              <Label htmlFor="personenbefoerderung" className="cursor-pointer">Personenbeförderung gewünscht</Label>
              <Switch
                id="personenbefoerderung"
                checked={besonderheiten.personenbefoerderungGewuenscht}
                onCheckedChange={(checked) => setBesonderheiten((prev) => ({ ...prev, personenbefoerderungGewuenscht: checked }))}
                data-testid="switch-personenbefoerderung"
              />
            </div>
            <div className="space-y-2">
              <Label>Inaktiv ab</Label>
              <DatePicker
                value={besonderheiten.inaktivAb || null}
                onChange={(val) => setBesonderheiten((prev) => ({ ...prev, inaktivAb: val || "" }))}
                data-testid="input-inaktiv-ab"
              />
            </div>
            {saveCancel(handleSaveBesonderheiten, "besonderheiten")}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-gray-700" data-testid="text-haustier">
              <PawPrint className={`${iconSize.sm} text-gray-500`} />
              Haustier: {customer.haustierVorhanden ? "Ja" : "Nein"}
              {customer.haustierVorhanden && customer.haustierDetails && (
                <span className="text-gray-500">({customer.haustierDetails})</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-gray-700" data-testid="text-personenbefoerderung">
              <Car className={`${iconSize.sm} text-gray-500`} />
              Personenbeförderung: {customer.personenbefoerderungGewuenscht ? "Ja" : "Nein"}
            </div>
            <div className="flex items-center gap-2 text-gray-700" data-testid="text-inaktiv-ab">
              <Calendar className={`${iconSize.sm} text-gray-500`} />
              Inaktiv ab: {customer.inaktivAb ? formatDateForDisplay(customer.inaktivAb) : "Nicht festgelegt"}
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Versandart Unterlagen"
        icon={<Send className={iconSize.sm} />}
        actions={editingSection !== "versandart" ? editButton("versandart") : undefined}
      >
        {editingSection === "versandart" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setDocumentDeliveryMethod("email")}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all cursor-pointer text-center ${
                  documentDeliveryMethod === "email"
                    ? "border-teal-500 bg-teal-50 ring-2 ring-teal-200"
                    : "border-gray-200 bg-white hover:border-gray-300"
                }`}
                data-testid="button-delivery-email"
              >
                <div className={`p-2 rounded-full ${
                  documentDeliveryMethod === "email" ? "bg-teal-100 text-teal-600" : "bg-gray-100 text-gray-500"
                }`}>
                  <Mail className="h-6 w-6" />
                </div>
                <div>
                  <p className="font-semibold text-sm text-gray-900">Per E-Mail</p>
                  <p className="text-xs text-gray-500 mt-0.5">Digital per E-Mail</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setDocumentDeliveryMethod("post")}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all cursor-pointer text-center ${
                  documentDeliveryMethod === "post"
                    ? "border-amber-500 bg-amber-50 ring-2 ring-amber-200"
                    : "border-gray-200 bg-white hover:border-gray-300"
                }`}
                data-testid="button-delivery-post"
              >
                <div className={`p-2 rounded-full ${
                  documentDeliveryMethod === "post" ? "bg-amber-100 text-amber-600" : "bg-gray-100 text-gray-500"
                }`}>
                  <Truck className="h-6 w-6" />
                </div>
                <div>
                  <p className="font-semibold text-sm text-gray-900">Per Post</p>
                  <p className="text-xs text-gray-500 mt-0.5">Ausgedruckt per Post</p>
                </div>
              </button>
            </div>
            {saveCancel(handleSaveDocumentDelivery, "versandart")}
          </div>
        ) : (
          <p className="text-gray-700" data-testid="text-delivery-method">
            {customer.documentDeliveryMethod === "post" ? "Per Deutsche Post (gedruckt)" : "Per E-Mail (digital)"}
          </p>
        )}
      </SectionCard>

    </div>
  );
}
