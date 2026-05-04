import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { Loader2 } from "lucide-react";
import { formatPhoneAsYouType } from "@shared/utils/phone";
import type { CompanyFormData } from "./types";

interface CompanyDetailsFormProps {
  companyForm: CompanyFormData;
  updateField: (field: keyof CompanyFormData, value: string | boolean) => void;
  onSubmit: () => void;
  isSaving: boolean;
}

export function CompanyDetailsForm({ companyForm, updateField, onSubmit, isSaving }: CompanyDetailsFormProps) {
  return (
    <Card data-testid="card-company-settings">
      <CardHeader>
        <CardTitle>Firmenstammdaten</CardTitle>
        <CardDescription>
          Diese Daten werden auf Rechnungen und Leistungsnachweisen verwendet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex flex-col gap-6"
        >
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-gray-700">Firma</h3>
            <div className="flex flex-col gap-3">
              <div>
                <Label htmlFor="companyName">Firmenname</Label>
                <Input
                  id="companyName"
                  data-testid="input-company-companyName"
                  value={companyForm.companyName}
                  onChange={(e) => updateField("companyName", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="geschaeftsfuehrer">Geschäftsführer</Label>
                <Input
                  id="geschaeftsfuehrer"
                  data-testid="input-company-geschaeftsfuehrer"
                  value={companyForm.geschaeftsfuehrer}
                  onChange={(e) => updateField("geschaeftsfuehrer", e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-gray-700">Adresse</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="strasse">Straße</Label>
                <AddressAutocomplete
                  id="strasse"
                  data-testid="input-company-strasse"
                  value={companyForm.strasse}
                  onChange={(val) => updateField("strasse", val)}
                  onAddressSelect={(addr) => {
                    updateField("strasse", addr.strasse);
                    updateField("hausnummer", addr.hausnummer);
                    updateField("plz", addr.plz);
                    updateField("stadt", addr.stadt);
                  }}
                />
              </div>
              <div>
                <Label htmlFor="hausnummer">Hausnummer</Label>
                <Input
                  id="hausnummer"
                  data-testid="input-company-hausnummer"
                  value={companyForm.hausnummer}
                  onChange={(e) => updateField("hausnummer", e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="plz">PLZ</Label>
                <Input
                  id="plz"
                  data-testid="input-company-plz"
                  value={companyForm.plz}
                  onChange={(e) => updateField("plz", e.target.value.replace(/\D/g, "").slice(0, 5))}
                  maxLength={5}
                  inputMode="numeric"
                />
              </div>
              <div>
                <Label htmlFor="stadt">Stadt</Label>
                <Input
                  id="stadt"
                  data-testid="input-company-stadt"
                  value={companyForm.stadt}
                  onChange={(e) => updateField("stadt", e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-gray-700">Kontakt</h3>
            <div className="flex flex-col gap-3">
              <div>
                <Label htmlFor="telefon">Telefon</Label>
                <Input
                  id="telefon"
                  data-testid="input-company-telefon"
                  value={companyForm.telefon}
                  onChange={(e) => updateField("telefon", formatPhoneAsYouType(e.target.value))}
                />
              </div>
              <div>
                <Label htmlFor="email">E-Mail</Label>
                <Input
                  id="email"
                  data-testid="input-company-email"
                  value={companyForm.email}
                  onChange={(e) => updateField("email", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="website">Website</Label>
                <Input
                  id="website"
                  data-testid="input-company-website"
                  value={companyForm.website}
                  onChange={(e) => updateField("website", e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-gray-700">Steuerdaten</h3>
            <div className="flex flex-col gap-3">
              <div>
                <Label htmlFor="steuernummer">Steuernummer</Label>
                <Input
                  id="steuernummer"
                  data-testid="input-company-steuernummer"
                  value={companyForm.steuernummer}
                  onChange={(e) => updateField("steuernummer", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="ustId">USt-ID</Label>
                <Input
                  id="ustId"
                  data-testid="input-company-ustId"
                  value={companyForm.ustId}
                  onChange={(e) => updateField("ustId", e.target.value)}
                  placeholder="Optional"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Entfällt bei Steuerbefreiung nach §4 Nr. 16 UStG
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-gray-700">Bankverbindung</h3>
            <div className="flex flex-col gap-3">
              <div>
                <Label htmlFor="iban">IBAN</Label>
                <Input
                  id="iban"
                  data-testid="input-company-iban"
                  value={companyForm.iban}
                  onChange={(e) => updateField("iban", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="bic">BIC</Label>
                <Input
                  id="bic"
                  data-testid="input-company-bic"
                  value={companyForm.bic}
                  onChange={(e) => updateField("bic", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="bankName">Bank</Label>
                <Input
                  id="bankName"
                  data-testid="input-company-bankName"
                  value={companyForm.bankName}
                  onChange={(e) => updateField("bankName", e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-gray-700">Anerkennung</h3>
            <div className="flex flex-col gap-3">
              <div>
                <Label htmlFor="ikNummer">IK-Nummer</Label>
                <Input
                  id="ikNummer"
                  data-testid="input-company-ikNummer"
                  value={companyForm.ikNummer}
                  onChange={(e) => updateField("ikNummer", e.target.value)}
                  placeholder="9 Ziffern, Institutionskennzeichen"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              type="submit"
              data-testid="button-save-company"
              disabled={isSaving}
            >
              {isSaving && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Speichern
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
