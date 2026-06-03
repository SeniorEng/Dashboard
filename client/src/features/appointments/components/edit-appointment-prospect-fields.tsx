import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Home, Users, UserCheck } from "lucide-react";
import { iconSize } from "@/design-system";
import { PFLEGEGRAD_OPTIONS } from "@shared/types";
import { formatPhoneAsYouType } from "@shared/utils/phone";

interface EditAppointmentProspectFieldsProps {
  ebVorname: string;
  setEbVorname: (value: string) => void;
  ebNachname: string;
  setEbNachname: (value: string) => void;
  ebTelefon: string;
  setEbTelefon: (value: string) => void;
  ebEmail: string;
  setEbEmail: (value: string) => void;
  ebStrasse: string;
  setEbStrasse: (value: string) => void;
  ebNr: string;
  setEbNr: (value: string) => void;
  ebPlz: string;
  setEbPlz: (value: string) => void;
  ebStadt: string;
  setEbStadt: (value: string) => void;
  ebPflegegrad: string;
  setEbPflegegrad: (value: string) => void;
  ebAssignedEmployeeId: string;
  setEbAssignedEmployeeId: (value: string) => void;
  ebEmployeeOptions: Array<{ value: string; label: string }>;
  errors: Record<string, string>;
  canEditProspectFields: boolean;
  canChangeKtAssignment: boolean;
  ebFullyLocked: boolean;
  ebLockHint: string | null;
}

export function EditAppointmentProspectFields({
  ebVorname,
  setEbVorname,
  ebNachname,
  setEbNachname,
  ebTelefon,
  setEbTelefon,
  ebEmail,
  setEbEmail,
  ebStrasse,
  setEbStrasse,
  ebNr,
  setEbNr,
  ebPlz,
  setEbPlz,
  ebStadt,
  setEbStadt,
  ebPflegegrad,
  setEbPflegegrad,
  ebAssignedEmployeeId,
  setEbAssignedEmployeeId,
  ebEmployeeOptions,
  errors,
  canEditProspectFields,
  canChangeKtAssignment,
  ebFullyLocked,
  ebLockHint,
}: EditAppointmentProspectFieldsProps) {
  return (
    <>
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-1">
        <UserCheck className="h-4 w-4" />
        <span>Kontaktdaten des Interessenten</span>
      </div>
      {!canEditProspectFields && (
        <p
          className="text-xs text-muted-foreground -mt-2"
          data-testid="text-prospect-readonly-hint"
        >
          Stammdaten des Interessenten können nur Admins oder Mitarbeiter mit
          Erstberatungs-Berechtigung ändern. Datum, Uhrzeit, Dauer und Notizen
          können Sie weiterhin anpassen.
        </p>
      )}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="eb-vorname">Vorname *</Label>
          <Input
            id="eb-vorname"
            value={ebVorname}
            onChange={(e) => setEbVorname(e.target.value)}
            placeholder="Max"
            disabled={!canEditProspectFields}
            data-testid="input-eb-vorname"
          />
          {errors.ebVorname && <p className="text-destructive text-sm">{errors.ebVorname}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="eb-nachname">Nachname *</Label>
          <Input
            id="eb-nachname"
            value={ebNachname}
            onChange={(e) => setEbNachname(e.target.value)}
            placeholder="Mustermann"
            disabled={!canEditProspectFields}
            data-testid="input-eb-nachname"
          />
          {errors.ebNachname && <p className="text-destructive text-sm">{errors.ebNachname}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="eb-telefon">Telefon *</Label>
        <Input
          id="eb-telefon"
          type="tel"
          value={ebTelefon}
          onChange={(e) => setEbTelefon(formatPhoneAsYouType(e.target.value))}
          placeholder="0171 1234567"
          disabled={!canEditProspectFields}
          data-testid="input-eb-telefon"
        />
        <p className="text-xs text-muted-foreground">Mobil (0171...) oder Festnetz (030...)</p>
        {errors.ebTelefon && <p className="text-destructive text-sm">{errors.ebTelefon}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="eb-email">E-Mail</Label>
        <Input
          id="eb-email"
          type="email"
          value={ebEmail}
          onChange={(e) => setEbEmail(e.target.value)}
          placeholder="beispiel@email.de"
          disabled={!canEditProspectFields}
          data-testid="input-eb-email"
        />
      </div>

      <div className="space-y-4">
        <Label className="flex items-center gap-2">
          <Home className={iconSize.sm} /> Adresse
        </Label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="col-span-2 space-y-2">
            <Label htmlFor="eb-strasse">Straße *</Label>
            <Input
              id="eb-strasse"
              value={ebStrasse}
              onChange={(e) => setEbStrasse(e.target.value)}
              placeholder="Musterstraße"
              disabled={!canEditProspectFields}
              data-testid="input-eb-strasse"
            />
            {errors.ebStrasse && <p className="text-destructive text-sm">{errors.ebStrasse}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="eb-nr">Nr. *</Label>
            <Input
              id="eb-nr"
              value={ebNr}
              onChange={(e) => setEbNr(e.target.value)}
              placeholder="42"
              disabled={!canEditProspectFields}
              data-testid="input-eb-nr"
            />
            {errors.ebNr && <p className="text-destructive text-sm">{errors.ebNr}</p>}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="eb-plz">PLZ *</Label>
            <Input
              id="eb-plz"
              value={ebPlz}
              onChange={(e) => setEbPlz(e.target.value)}
              placeholder="10969"
              maxLength={5}
              disabled={!canEditProspectFields}
              data-testid="input-eb-plz"
            />
            {errors.ebPlz && <p className="text-destructive text-sm">{errors.ebPlz}</p>}
          </div>
          <div className="col-span-2 space-y-2">
            <Label htmlFor="eb-stadt">Stadt *</Label>
            <Input
              id="eb-stadt"
              value={ebStadt}
              onChange={(e) => setEbStadt(e.target.value)}
              placeholder="Berlin"
              disabled={!canEditProspectFields}
              data-testid="input-eb-stadt"
            />
            {errors.ebStadt && <p className="text-destructive text-sm">{errors.ebStadt}</p>}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Pflegegrad *</Label>
        <Select
          value={ebPflegegrad}
          onValueChange={setEbPflegegrad}
          disabled={!canEditProspectFields}
        >
          <SelectTrigger data-testid="select-pflegegrad">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PFLEGEGRAD_OPTIONS.map((p) => (
              <SelectItem key={p} value={p.toString()}>
                Pflegegrad {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {canChangeKtAssignment && (
        <div className="space-y-2">
          <Label>
            <Users className={`${iconSize.sm} inline mr-1`} /> Mitarbeiter zuweisen *
          </Label>
          <SearchableSelect
            options={ebEmployeeOptions}
            value={ebAssignedEmployeeId}
            onValueChange={setEbAssignedEmployeeId}
            placeholder="Mitarbeiter auswählen..."
            searchPlaceholder="Mitarbeiter suchen..."
            emptyText="Kein Mitarbeiter mit Erstberatungs-Berechtigung gefunden."
            className={errors.ebAssignedEmployeeId ? "border-destructive" : ""}
            disabled={ebFullyLocked}
            data-testid="select-eb-employee"
          />
          {errors.ebAssignedEmployeeId && <p className="text-destructive text-sm">{errors.ebAssignedEmployeeId}</p>}
        </div>
      )}

      {ebLockHint && (
        <p
          className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2"
          data-testid="text-eb-lock-hint"
        >
          {ebLockHint}
        </p>
      )}
    </>
  );
}
