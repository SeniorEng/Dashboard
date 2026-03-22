import { useState } from "react";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { formatAddress } from "@shared/utils/format";
import { formatPhoneForDisplay, validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import { BILLING_TYPE_SELECT_OPTIONS } from "@shared/domain/customers";
import { SectionCard } from "@/components/patterns/section-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { iconSize } from "@/design-system";
import { AddressFields } from "../address-fields";
import { EditButton, SaveCancelButtons } from "./section-helpers";
import { User2, MapPin, Phone, Mail, Calendar } from "lucide-react";
import type { SectionProps } from "./types";

export function ContactSection({ customer, customerId, editingSection, setEditingSection, saving, setSaving, invalidateCustomer }: SectionProps) {
  const { toast } = useToast();

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
    } catch (error: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: error instanceof Error ? error.message : "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const startEditing = () => {
    initStammdaten();
    setEditingSection("kontakt");
  };

  return (
    <SectionCard
      title="Kontaktdaten"
      icon={<User2 className={iconSize.sm} />}
      actions={editingSection !== "kontakt" ? <EditButton section="kontakt" editingSection={editingSection} startEditing={startEditing} /> : undefined}
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

          <SaveCancelButtons onSave={handleSaveStammdaten} testIdPrefix="kontakt" saving={saving} onCancel={() => setEditingSection(null)} />
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
  );
}
