import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SectionCard } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { formatPhoneForDisplay, validateDachPhone } from "@shared/utils/phone";
import { formatAddress } from "@shared/utils/format";
import { User as UserIcon, Phone, MapPin, Mail, Loader2, Save } from "lucide-react";
import { iconSize } from "@/design-system";
import { InfoRow } from "./info-row";
import type { ProfileData } from "../types";

export function PersonalDataSection({ profile }: { profile: ProfileData }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState({
    telefon: profile.telefon || "",
    email: profile.email || "",
    strasse: profile.strasse || "",
    hausnummer: profile.hausnummer || "",
    plz: profile.plz || "",
    stadt: profile.stadt || "",
  });

  const updateMutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const updates: Record<string, string> = {};
      if (data.telefon !== (profile.telefon || "")) {
        if (data.telefon) {
          const phoneResult = validateDachPhone(data.telefon);
          if (!phoneResult.valid) {
            throw new Error(!phoneResult.valid ? phoneResult.error : "Ungültige Telefonnummer");
          }
          updates.telefon = phoneResult.normalized;
        } else {
          updates.telefon = "";
        }
      }
      if (data.email !== profile.email) updates.email = data.email;
      if (data.strasse !== (profile.strasse || "")) updates.strasse = data.strasse;
      if (data.hausnummer !== (profile.hausnummer || "")) updates.hausnummer = data.hausnummer;
      if (data.plz !== (profile.plz || "")) updates.plz = data.plz;
      if (data.stadt !== (profile.stadt || "")) updates.stadt = data.stadt;

      if (Object.keys(updates).length === 0) return profile;
      const result = await api.patch("/profile", updates);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["user"] });
      setIsEditing(false);
      toast({ title: "Profil aktualisiert", description: "Ihre Daten wurden gespeichert." });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleCancel = () => {
    setForm({
      telefon: profile.telefon || "",
      email: profile.email || "",
      strasse: profile.strasse || "",
      hausnummer: profile.hausnummer || "",
      plz: profile.plz || "",
      stadt: profile.stadt || "",
    });
    setIsEditing(false);
  };

  return (
    <SectionCard
      title="Kontaktdaten"
      icon={<UserIcon className={iconSize.sm} />}
      actions={
        !isEditing ? (
          <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} data-testid="button-edit-contact">
            Bearbeiten
          </Button>
        ) : undefined
      }
    >
      {isEditing ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="profile-email">E-Mail</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="profile-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                className="pl-10 text-base"
                data-testid="input-profile-email"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-telefon">Telefon</Label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="profile-telefon"
                type="tel"
                value={form.telefon}
                onChange={(e) => setForm((f) => ({ ...f, telefon: e.target.value }))}
                placeholder="z.B. 0171 1234567"
                className="pl-10 text-base"
                data-testid="input-profile-telefon"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="profile-strasse">Straße</Label>
              <AddressAutocomplete
                id="profile-strasse"
                value={form.strasse}
                onChange={(val) => setForm((f) => ({ ...f, strasse: val }))}
                onAddressSelect={(addr) => {
                  setForm((f) => ({
                    ...f,
                    strasse: addr.strasse,
                    hausnummer: addr.hausnummer,
                    plz: addr.plz,
                    stadt: addr.stadt,
                  }));
                }}
                data-testid="input-profile-strasse"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-hausnummer">Nr.</Label>
              <Input
                id="profile-hausnummer"
                value={form.hausnummer}
                onChange={(e) => setForm((f) => ({ ...f, hausnummer: e.target.value }))}
                className="text-base"
                data-testid="input-profile-hausnummer"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-2">
              <Label htmlFor="profile-plz">PLZ</Label>
              <Input
                id="profile-plz"
                value={form.plz}
                onChange={(e) => setForm((f) => ({ ...f, plz: e.target.value.replace(/\D/g, "").slice(0, 5) }))}
                maxLength={5}
                inputMode="numeric"
                className="text-base"
                data-testid="input-profile-plz"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="profile-stadt">Stadt</Label>
              <Input
                id="profile-stadt"
                value={form.stadt}
                onChange={(e) => setForm((f) => ({ ...f, stadt: e.target.value }))}
                className="text-base"
                data-testid="input-profile-stadt"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              onClick={() => updateMutation.mutate(form)}
              disabled={updateMutation.isPending}
              className="flex-1"
              data-testid="button-save-contact"
            >
              {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
              Speichern
            </Button>
            <Button variant="outline" onClick={handleCancel} disabled={updateMutation.isPending} data-testid="button-cancel-contact">
              Abbrechen
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <InfoRow icon={<Mail className="h-4 w-4" />} label="E-Mail" value={profile.email} testId="text-profile-email" />
          <InfoRow
            icon={<Phone className="h-4 w-4" />}
            label="Telefon"
            value={profile.telefon ? <a href={`tel:${profile.telefon}`} className="text-primary hover:underline">{formatPhoneForDisplay(profile.telefon)}</a> : "—"}
            testId="text-profile-telefon"
          />
          <InfoRow
            icon={<MapPin className="h-4 w-4" />}
            label="Adresse"
            value={
              formatAddress(profile) !== "Keine Adresse hinterlegt"
                ? formatAddress(profile)
                : "—"
            }
            testId="text-profile-adresse"
          />
        </div>
      )}
    </SectionCard>
  );
}
