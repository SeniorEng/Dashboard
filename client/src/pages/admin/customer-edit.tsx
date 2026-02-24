import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useCustomer, useEmployees, customerKeys } from "@/features/customers";
import { api, unwrapResult } from "@/lib/api";
import { validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import { todayISO, formatDateForDisplay } from "@shared/utils/datetime";
import { iconSize, componentStyles } from "@/design-system";
import { PFLEGEGRAD_SELECT_OPTIONS, BILLING_TYPE_SELECT_OPTIONS, isPflegekasseCustomer } from "@shared/domain/customers";
import { AddressFields } from "./components/address-fields";
import { EmployeeMatching } from "./components/employee-matching";
import { CustomerContactsTab } from "./components/customer-contacts-tab";
import { CustomerInsuranceTab } from "./components/customer-insurance-tab";
import {
  Loader2,
  User2,
  Users,
  Save,
  Heart,
  Shield,
  FileText,
  ChevronRight,
  Mail,
  Truck,
  Wallet,
} from "lucide-react";

export default function AdminCustomerEdit() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: customer, isLoading } = useCustomer(customerId);
  const { data: employees } = useEmployees();

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

  const [vorerkrankungen, setVorerkrankungen] = useState("");
  const [newPflegegrad, setNewPflegegrad] = useState<string>("");
  const [pflegegradSeit, setPflegegradSeit] = useState<string>(todayISO());

  const [vertragData, setVertragData] = useState({
    vereinbarteLeistungen: "",
    acceptsPrivatePayment: false,
    documentDeliveryMethod: "email" as "email" | "post",
  });

  const [employeeData, setEmployeeData] = useState({
    primaryEmployeeId: "",
    backupEmployeeId: "",
  });

  const [besonderheiten, setBesonderheiten] = useState({
    haustierVorhanden: false,
    haustierDetails: "",
    personenbefoerderungGewuenscht: false,
    inaktivAb: "",
  });

  useEffect(() => {
    if (customer) {
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
      setVorerkrankungen(customer.vorerkrankungen || "");
      setVertragData({
        vereinbarteLeistungen: customer.currentContract?.vereinbarteLeistungen || "",
        acceptsPrivatePayment: customer.acceptsPrivatePayment ?? false,
        documentDeliveryMethod: (customer.documentDeliveryMethod as "email" | "post") || "email",
      });
      setEmployeeData({
        primaryEmployeeId: customer.primaryEmployee?.id?.toString() || "",
        backupEmployeeId: customer.backupEmployee?.id?.toString() || "",
      });
      setBesonderheiten({
        haustierVorhanden: customer.haustierVorhanden ?? false,
        haustierDetails: customer.haustierDetails || "",
        personenbefoerderungGewuenscht: customer.personenbefoerderungGewuenscht ?? false,
        inaktivAb: (customer as any).inaktivAb || "",
      });
    }
  }, [customer]);

  const employeeOptions = useMemo(() => [
    { value: "", label: "Nicht zugewiesen" },
    ...(employees?.map((emp) => ({
      value: emp.id.toString(),
      label: emp.displayName,
    })) || []),
  ], [employees]);

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

  const changeCareLevelMutation = useMutation({
    mutationFn: async (data: { pflegegrad: number; validFrom: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/care-level`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Pflegegrad aktualisiert", description: "Der Pflegegrad wurde mit Historisierung gespeichert." });
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
      queryClient.invalidateQueries({ queryKey: customerKeys.lists() });
      setNewPflegegrad("");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const [savingStammdaten, setSavingStammdaten] = useState(false);
  const handleSaveStammdaten = async () => {
    if (!stammdaten.vorname.trim() || !stammdaten.nachname.trim()) {
      toast({ title: "Pflichtfelder fehlen", description: "Vorname und Nachname sind erforderlich.", variant: "destructive" });
      return;
    }
    if (phoneErrors.telefon || phoneErrors.festnetz) {
      toast({ title: "Ungültige Telefonnummer", description: "Bitte korrigieren Sie die Telefonnummer(n).", variant: "destructive" });
      return;
    }
    setSavingStammdaten(true);
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
      toast({ title: "Stammdaten gespeichert" });
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
      queryClient.invalidateQueries({ queryKey: customerKeys.lists() });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSavingStammdaten(false);
    }
  };

  const [savingVorerkrankungen, setSavingVorerkrankungen] = useState(false);
  const handleSaveVorerkrankungen = async () => {
    setSavingVorerkrankungen(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        vorerkrankungen: vorerkrankungen.trim() || null,
      });
      unwrapResult(result);
      toast({ title: "Vorerkrankungen gespeichert" });
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSavingVorerkrankungen(false);
    }
  };

  const [savingVertrag, setSavingVertrag] = useState(false);
  const handleSaveVertrag = async () => {
    setSavingVertrag(true);
    try {
      const customerPatch = await api.patch(`/admin/customers/${customerId}`, {
        acceptsPrivatePayment: vertragData.acceptsPrivatePayment,
        documentDeliveryMethod: vertragData.documentDeliveryMethod,
      });
      unwrapResult(customerPatch);

      if (customer?.currentContract?.id && vertragData.vereinbarteLeistungen !== (customer.currentContract.vereinbarteLeistungen || "")) {
        const contractPatch = await api.patch(`/admin/customers/${customerId}/contract`, {
          vereinbarteLeistungen: vertragData.vereinbarteLeistungen.trim() || null,
        });
        unwrapResult(contractPatch);
      }

      toast({ title: "Vertrag & Leistungen gespeichert" });
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSavingVertrag(false);
    }
  };

  const [savingEmployees, setSavingEmployees] = useState(false);
  const handleSaveEmployees = async () => {
    const primaryId = employeeData.primaryEmployeeId ? parseInt(employeeData.primaryEmployeeId) : null;
    const backupId = employeeData.backupEmployeeId ? parseInt(employeeData.backupEmployeeId) : null;
    if (primaryId && backupId && primaryId === backupId) {
      toast({ title: "Ungültige Auswahl", description: "Haupt- und Vertretungsmitarbeiter dürfen nicht identisch sein.", variant: "destructive" });
      return;
    }
    setSavingEmployees(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        primaryEmployeeId: primaryId,
        backupEmployeeId: backupId,
      });
      unwrapResult(result);
      toast({ title: "Mitarbeiterzuordnung gespeichert" });
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSavingEmployees(false);
    }
  };

  const [savingBesonderheiten, setSavingBesonderheiten] = useState(false);
  const handleSaveBesonderheiten = async () => {
    setSavingBesonderheiten(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        haustierVorhanden: besonderheiten.haustierVorhanden,
        haustierDetails: besonderheiten.haustierVorhanden ? (besonderheiten.haustierDetails?.trim() || null) : null,
        personenbefoerderungGewuenscht: besonderheiten.personenbefoerderungGewuenscht,
        inaktivAb: besonderheiten.inaktivAb?.trim() || null,
      });
      unwrapResult(result);
      toast({ title: "Besonderheiten gespeichert" });
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Fehler", description: error.message || "Speichern fehlgeschlagen." });
    } finally {
      setSavingBesonderheiten(false);
    }
  };

  if (isLoading) {
    return (
      <Layout variant="admin">
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
        </div>
      </Layout>
    );
  }

  if (!customer) {
    return (
      <Layout variant="admin">
        <PageHeader title="Kunde nicht gefunden" backHref="/admin/customers" />
      </Layout>
    );
  }

  const showInsurance = isPflegekasseCustomer(stammdaten.billingType as any);

  return (
    <Layout variant="admin">
      <PageHeader
        title="Kunde bearbeiten"
        backHref={`/admin/customers/${customerId}`}
      />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <User2 className={iconSize.sm} />
              Stammdaten & Kontakt
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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

            <Button
              className={`w-full ${componentStyles.btnPrimary}`}
              onClick={handleSaveStammdaten}
              disabled={savingStammdaten}
              data-testid="button-save-stammdaten"
            >
              {savingStammdaten ? (
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
              ) : (
                <Save className={`${iconSize.sm} mr-2`} />
              )}
              Speichern
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Heart className={iconSize.sm} />
              Pflege & Versicherung
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
              <span className="text-sm text-gray-600">Aktueller Pflegegrad:</span>
              {customer.pflegegrad && customer.pflegegrad > 0 ? (
                <>
                  <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
                  {(() => {
                    const current = customer.careLevelHistory?.find((h: any) => !h.validTo);
                    return current ? (
                      <span className="text-xs text-gray-500">
                        seit {formatDateForDisplay(current.validFrom)}
                      </span>
                    ) : null;
                  })()}
                </>
              ) : (
                <span className="text-sm text-gray-400">Nicht festgelegt</span>
              )}
            </div>

            <div className="border-t pt-4">
              <p className="text-sm font-medium mb-3">Pflegegrad ändern</p>
              <p className="text-xs text-gray-500 mb-3">
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
              {newPflegegrad && (
                <Button
                  className={`mt-3 w-full ${componentStyles.btnPrimary}`}
                  onClick={() => {
                    changeCareLevelMutation.mutate({
                      pflegegrad: parseInt(newPflegegrad),
                      validFrom: pflegegradSeit,
                    });
                  }}
                  disabled={changeCareLevelMutation.isPending}
                  data-testid="button-save-pflegegrad"
                >
                  {changeCareLevelMutation.isPending ? (
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  ) : (
                    <Save className={`${iconSize.sm} mr-2`} />
                  )}
                  Pflegegrad ändern
                </Button>
              )}
            </div>

            <div className="border-t pt-4 space-y-2">
              <Label htmlFor="vorerkrankungen">Vorerkrankungen</Label>
              <Textarea
                id="vorerkrankungen"
                value={vorerkrankungen}
                onChange={(e) => setVorerkrankungen(e.target.value)}
                placeholder="Vorerkrankungen des Kunden..."
                rows={3}
                data-testid="input-vorerkrankungen"
              />
              <Button
                className={`w-full ${componentStyles.btnPrimary}`}
                onClick={handleSaveVorerkrankungen}
                disabled={savingVorerkrankungen}
                data-testid="button-save-vorerkrankungen"
              >
                {savingVorerkrankungen ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Save className={`${iconSize.sm} mr-2`} />
                )}
                Speichern
              </Button>
            </div>

            {showInsurance && (
              <div className="border-t pt-4">
                <CustomerInsuranceTab
                  customerId={customerId}
                  currentInsurance={customer.currentInsurance}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileText className={iconSize.sm} />
              Vertrag & Leistungen
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="vereinbarteLeistungen">Vereinbarte Leistungen</Label>
              <Textarea
                id="vereinbarteLeistungen"
                value={vertragData.vereinbarteLeistungen}
                onChange={(e) => setVertragData((prev) => ({ ...prev, vereinbarteLeistungen: e.target.value }))}
                placeholder="Beschreibung der vereinbarten Leistungen..."
                rows={4}
                data-testid="input-vereinbarte-leistungen"
              />
              {!customer.currentContract && (
                <p className="text-xs text-gray-500">Kein aktiver Vertrag vorhanden. Leistungstext wird erst nach Vertragsanlage gespeichert.</p>
              )}
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
              <div className="space-y-0.5">
                <Label htmlFor="acceptsPrivatePayment" className="cursor-pointer">Private Zuzahlung</Label>
                <p className="text-xs text-gray-500">Kunde akzeptiert private Zuzahlungen</p>
              </div>
              <Switch
                id="acceptsPrivatePayment"
                checked={vertragData.acceptsPrivatePayment}
                onCheckedChange={(checked) => setVertragData((prev) => ({ ...prev, acceptsPrivatePayment: checked }))}
                data-testid="switch-accepts-private-payment"
              />
            </div>

            <div className="space-y-2">
              <Label>Dokumentenzustellung</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setVertragData((prev) => ({ ...prev, documentDeliveryMethod: "email" }))}
                  className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all cursor-pointer text-center ${
                    vertragData.documentDeliveryMethod === "email"
                      ? "border-teal-500 bg-teal-50 ring-2 ring-teal-200"
                      : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                  data-testid="button-delivery-email"
                >
                  <div className={`p-2 rounded-full ${
                    vertragData.documentDeliveryMethod === "email" ? "bg-teal-100 text-teal-600" : "bg-gray-100 text-gray-500"
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
                  onClick={() => setVertragData((prev) => ({ ...prev, documentDeliveryMethod: "post" }))}
                  className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all cursor-pointer text-center ${
                    vertragData.documentDeliveryMethod === "post"
                      ? "border-amber-500 bg-amber-50 ring-2 ring-amber-200"
                      : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                  data-testid="button-delivery-post"
                >
                  <div className={`p-2 rounded-full ${
                    vertragData.documentDeliveryMethod === "post" ? "bg-amber-100 text-amber-600" : "bg-gray-100 text-gray-500"
                  }`}>
                    <Truck className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="font-semibold text-sm text-gray-900">Per Post</p>
                    <p className="text-xs text-gray-500 mt-0.5">Ausgedruckt per Post</p>
                  </div>
                </button>
              </div>
            </div>

            <Button
              className={`w-full ${componentStyles.btnPrimary}`}
              onClick={handleSaveVertrag}
              disabled={savingVertrag}
              data-testid="button-save-vertrag"
            >
              {savingVertrag ? (
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
              ) : (
                <Save className={`${iconSize.sm} mr-2`} />
              )}
              Speichern
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Users className={iconSize.sm} />
              Mitarbeiterzuordnung
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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

            <div className="border-t pt-3 mt-3">
              <EmployeeMatching
                customerId={customerId}
                onSelect={(employeeId) => {
                  if (!employeeData.primaryEmployeeId) {
                    setEmployeeData((prev) => ({ ...prev, primaryEmployeeId: employeeId.toString() }));
                  } else if (!employeeData.backupEmployeeId && employeeData.primaryEmployeeId !== employeeId.toString()) {
                    setEmployeeData((prev) => ({ ...prev, backupEmployeeId: employeeId.toString() }));
                  }
                }}
              />
            </div>

            <Button
              className={`w-full ${componentStyles.btnPrimary}`}
              onClick={handleSaveEmployees}
              disabled={savingEmployees}
              data-testid="button-save-employees"
            >
              {savingEmployees ? (
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
              ) : (
                <Save className={`${iconSize.sm} mr-2`} />
              )}
              Speichern
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Shield className={iconSize.sm} />
              Besonderheiten
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
              <div className="space-y-0.5">
                <Label htmlFor="haustierVorhanden" className="cursor-pointer">Haustier vorhanden</Label>
              </div>
              <Switch
                id="haustierVorhanden"
                checked={besonderheiten.haustierVorhanden}
                onCheckedChange={(checked) => setBesonderheiten((prev) => ({ ...prev, haustierVorhanden: checked }))}
                data-testid="switch-haustier"
              />
            </div>

            {besonderheiten.haustierVorhanden && (
              <div className="space-y-2">
                <Label htmlFor="haustierDetails">Haustierdetails</Label>
                <Input
                  id="haustierDetails"
                  value={besonderheiten.haustierDetails}
                  onChange={(e) => setBesonderheiten((prev) => ({ ...prev, haustierDetails: e.target.value }))}
                  placeholder="z.B. Katze, verträglich"
                  data-testid="input-haustier-details"
                />
              </div>
            )}

            <div className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
              <div className="space-y-0.5">
                <Label htmlFor="personenbefoerderung" className="cursor-pointer">Personenbeförderung gewünscht</Label>
              </div>
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
              <p className="text-xs text-muted-foreground">
                Ab diesem Datum können keine neuen Termine erstellt werden. Bestehende Termine bleiben bearbeitbar.
              </p>
            </div>

            <Button
              className={`w-full ${componentStyles.btnPrimary}`}
              onClick={handleSaveBesonderheiten}
              disabled={savingBesonderheiten}
              data-testid="button-save-besonderheiten"
            >
              {savingBesonderheiten ? (
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
              ) : (
                <Save className={`${iconSize.sm} mr-2`} />
              )}
              Speichern
            </Button>
          </CardContent>
        </Card>

        <CustomerContactsTab customerId={customerId} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Wallet className={iconSize.sm} />
              Weitere Verwaltung
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <button
              type="button"
              onClick={() => setLocation(`/admin/customers/${customerId}?tab=budgets`)}
              className="w-full flex items-center justify-between p-3 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors text-left"
              data-testid="link-budgets"
            >
              <span className="text-sm font-medium text-gray-700">Budgets</span>
              <ChevronRight className={`${iconSize.sm} text-gray-400`} />
            </button>
            <button
              type="button"
              onClick={() => setLocation(`/admin/customers/${customerId}?tab=documents`)}
              className="w-full flex items-center justify-between p-3 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors text-left"
              data-testid="link-documents"
            >
              <span className="text-sm font-medium text-gray-700">Dokumente</span>
              <ChevronRight className={`${iconSize.sm} text-gray-400`} />
            </button>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
