import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { iconSize } from "@/design-system";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Euro } from "lucide-react";
import { todayISO } from "@shared/utils/datetime";
import {
  UserData,
  UserFormData,
  ROLE_LABELS,
  AVAILABLE_ROLES,
  formatPhoneDisplay,
  validateGermanPhoneNumber,
} from "./user-types";

export function UserForm({
  mode,
  user,
  onSubmit,
  isLoading,
}: {
  mode: "create" | "edit";
  user?: UserData;
  onSubmit: (data: UserFormData & { password?: string }) => void;
  isLoading: boolean;
}) {
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [vorname, setVorname] = useState(user?.vorname ?? "");
  const [nachname, setNachname] = useState(user?.nachname ?? "");
  const [telefon, setTelefon] = useState(user?.telefon ? formatPhoneDisplay(user.telefon) : "");
  const [telefonError, setTelefonError] = useState("");
  const [strasse, setStrasse] = useState(user?.strasse ?? "");
  const [hausnummer, setHausnummer] = useState(user?.hausnummer ?? "");
  const [plz, setPlz] = useState(user?.plz ?? "");
  const [stadt, setStadt] = useState(user?.stadt ?? "");
  const [geburtsdatum, setGeburtsdatum] = useState(user?.geburtsdatum ?? "");
  const [isAdmin, setIsAdmin] = useState(user?.isAdmin ?? false);
  const [roles, setRoles] = useState<string[]>(user?.roles ?? []);
  
  const [hourlyRateHauswirtschaft, setHourlyRateHauswirtschaft] = useState("");
  const [hourlyRateAlltagsbegleitung, setHourlyRateAlltagsbegleitung] = useState("");
  const [travelCostType, setTravelCostType] = useState<"kilometergeld" | "pauschale" | "">("");
  const [kilometerRate, setKilometerRate] = useState("");
  const [monthlyTravelAllowance, setMonthlyTravelAllowance] = useState("");
  const [compensationValidFrom, setCompensationValidFrom] = useState(
    todayISO()
  );

  const hasCompensationData = 
    hourlyRateHauswirtschaft || 
    hourlyRateAlltagsbegleitung || 
    travelCostType;

  const handleTelefonBlur = () => {
    if (!telefon.trim()) {
      setTelefonError("");
      return;
    }
    const result = validateGermanPhoneNumber(telefon);
    if (result.valid) {
      setTelefon(result.formatted);
      setTelefonError("");
    } else {
      setTelefonError(result.error);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    let normalizedTelefon: string | undefined = undefined;
    if (telefon.trim()) {
      const result = validateGermanPhoneNumber(telefon);
      if (!result.valid) {
        setTelefonError(result.error);
        return;
      }
      normalizedTelefon = result.normalized;
    }
    
    const data: UserFormData & { password?: string } = {
      email,
      vorname,
      nachname,
      telefon: normalizedTelefon,
      strasse: strasse || undefined,
      hausnummer: hausnummer || undefined,
      plz: plz || undefined,
      stadt: stadt || undefined,
      geburtsdatum: geburtsdatum || undefined,
      isAdmin,
      roles,
    };
    
    if (mode === "create") {
      data.password = password;
    }
    
    if (mode === "create" && hasCompensationData) {
      data.compensation = {
        hourlyRateHauswirtschaftCents: hourlyRateHauswirtschaft ? Math.round(parseFloat(hourlyRateHauswirtschaft) * 100) : undefined,
        hourlyRateAlltagsbegleitungCents: hourlyRateAlltagsbegleitung ? Math.round(parseFloat(hourlyRateAlltagsbegleitung) * 100) : undefined,
        travelCostType: travelCostType || undefined,
        kilometerRateCents: travelCostType === "kilometergeld" && kilometerRate ? Math.round(parseFloat(kilometerRate) * 100) : undefined,
        monthlyTravelAllowanceCents: travelCostType === "pauschale" && monthlyTravelAllowance ? Math.round(parseFloat(monthlyTravelAllowance) * 100) : undefined,
        validFrom: compensationValidFrom,
      };
    }
    
    onSubmit(data);
  };

  const isCreate = mode === "create";

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>
          {isCreate ? "Neuen Benutzer erstellen" : "Benutzer bearbeiten"}
        </DialogTitle>
        <DialogDescription>
          {isCreate
            ? "Erstellen Sie ein neues Benutzerkonto für einen Mitarbeiter."
            : `Bearbeiten Sie die Daten von ${user?.displayName}.`}
        </DialogDescription>
      </DialogHeader>
      
      <div className="space-y-6 py-4">
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">Persönliche Daten</h3>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="vorname">Vorname *</Label>
              <Input
                id="vorname"
                value={vorname}
                onChange={(e) => setVorname(e.target.value)}
                required
                data-testid="input-user-vorname"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nachname">Nachname *</Label>
              <Input
                id="nachname"
                value={nachname}
                onChange={(e) => setNachname(e.target.value)}
                required
                data-testid="input-user-nachname"
              />
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Geburtsdatum</Label>
              <DatePicker
                value={geburtsdatum || null}
                onChange={(val) => setGeburtsdatum(val || "")}
                data-testid="input-user-geburtsdatum"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="telefon">Telefon</Label>
              <Input
                id="telefon"
                type="tel"
                value={telefon}
                onChange={(e) => setTelefon(e.target.value)}
                onBlur={handleTelefonBlur}
                placeholder="0170 1234567"
                className={telefonError ? "border-red-500" : ""}
                data-testid="input-user-telefon"
              />
              {telefonError && (
                <p className="text-xs text-red-500">{telefonError}</p>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">Adresse</h3>
          
          <div className="grid grid-cols-4 gap-4">
            <div className="col-span-3 space-y-2">
              <Label htmlFor="strasse">Straße</Label>
              <Input
                id="strasse"
                value={strasse}
                onChange={(e) => setStrasse(e.target.value)}
                data-testid="input-user-strasse"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hausnummer">Hausnr.</Label>
              <Input
                id="hausnummer"
                value={hausnummer}
                onChange={(e) => setHausnummer(e.target.value)}
                data-testid="input-user-hausnummer"
              />
            </div>
          </div>
          
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="plz">PLZ</Label>
              <Input
                id="plz"
                value={plz}
                onChange={(e) => setPlz(e.target.value)}
                data-testid="input-user-plz"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="stadt">Stadt</Label>
              <Input
                id="stadt"
                value={stadt}
                onChange={(e) => setStadt(e.target.value)}
                data-testid="input-user-stadt"
              />
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">Zugangsdaten</h3>
          
          <div className="space-y-2">
            <Label htmlFor="email">E-Mail *</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-testid="input-user-email"
            />
          </div>
          
          {isCreate && (
            <div className="space-y-2">
              <Label htmlFor="password">Passwort *</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                placeholder="Mindestens 8 Zeichen"
                data-testid="input-user-password"
              />
            </div>
          )}
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">Berechtigungen</h3>
          
          <div className="flex items-center space-x-2">
            <Checkbox
              id="isAdmin"
              checked={isAdmin}
              onCheckedChange={(checked) => setIsAdmin(!!checked)}
              data-testid="checkbox-is-admin"
            />
            <Label htmlFor="isAdmin">Administrator-Rechte</Label>
          </div>
          
          <div className="space-y-2">
            <Label>Tätigkeitsbereiche</Label>
            <div className="grid grid-cols-2 gap-2">
              {AVAILABLE_ROLES.map((role) => (
                <div key={role} className="flex items-center space-x-2">
                  <Checkbox
                    id={`role-${role}`}
                    checked={roles.includes(role)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setRoles([...roles, role]);
                      } else {
                        setRoles(roles.filter((r) => r !== role));
                      }
                    }}
                    data-testid={`checkbox-role-${role}`}
                  />
                  <Label htmlFor={`role-${role}`}>{ROLE_LABELS[role]}</Label>
                </div>
              ))}
            </div>
          </div>
        </div>

        {isCreate && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-700 border-b pb-2 flex items-center gap-2">
              <Euro className={iconSize.sm} />
              Vergütung (optional)
            </h3>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="hourlyRateHauswirtschaft">Stundenlohn Hauswirtschaft</Label>
                <div className="relative">
                  <Input
                    id="hourlyRateHauswirtschaft"
                    type="number"
                    step="0.01"
                    min="0"
                    value={hourlyRateHauswirtschaft}
                    onChange={(e) => setHourlyRateHauswirtschaft(e.target.value)}
                    placeholder="z.B. 15.50"
                    className="pr-8"
                    data-testid="input-hourly-rate-hauswirtschaft"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/h</span>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="hourlyRateAlltagsbegleitung">Stundenlohn Alltagsbegleitung</Label>
                <div className="relative">
                  <Input
                    id="hourlyRateAlltagsbegleitung"
                    type="number"
                    step="0.01"
                    min="0"
                    value={hourlyRateAlltagsbegleitung}
                    onChange={(e) => setHourlyRateAlltagsbegleitung(e.target.value)}
                    placeholder="z.B. 16.00"
                    className="pr-8"
                    data-testid="input-hourly-rate-alltagsbegleitung"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/h</span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="travelCostType">Fahrtkostenmodell</Label>
              <Select
                value={travelCostType}
                onValueChange={(value: "kilometergeld" | "pauschale" | "") => {
                  setTravelCostType(value);
                  if (value === "kilometergeld") {
                    setMonthlyTravelAllowance("");
                  } else if (value === "pauschale") {
                    setKilometerRate("");
                  }
                }}
              >
                <SelectTrigger data-testid="select-travel-cost-type">
                  <SelectValue placeholder="Bitte wählen..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kilometergeld">Kilometergeld</SelectItem>
                  <SelectItem value="pauschale">Monatliche Pauschale</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {travelCostType === "kilometergeld" && (
              <div className="space-y-2">
                <Label htmlFor="kilometerRate">Kilometergeld</Label>
                <div className="relative">
                  <Input
                    id="kilometerRate"
                    type="number"
                    step="0.01"
                    min="0"
                    value={kilometerRate}
                    onChange={(e) => setKilometerRate(e.target.value)}
                    placeholder="z.B. 0.30"
                    className="pr-12"
                    data-testid="input-kilometer-rate"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/km</span>
                </div>
              </div>
            )}

            {travelCostType === "pauschale" && (
              <div className="space-y-2">
                <Label htmlFor="monthlyTravelAllowance">Monatliche Pauschale</Label>
                <div className="relative">
                  <Input
                    id="monthlyTravelAllowance"
                    type="number"
                    step="0.01"
                    min="0"
                    value={monthlyTravelAllowance}
                    onChange={(e) => setMonthlyTravelAllowance(e.target.value)}
                    placeholder="z.B. 150.00"
                    className="pr-14"
                    data-testid="input-monthly-travel-allowance"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/Monat</span>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>Gültig ab</Label>
              <DatePicker
                value={compensationValidFrom || null}
                onChange={(val) => setCompensationValidFrom(val || "")}
                minDate={new Date()}
                data-testid="input-compensation-valid-from"
              />
              <p className="text-xs text-gray-500">Nur ab heute oder in der Zukunft möglich</p>
            </div>
          </div>
        )}
      </div>
      
      <DialogFooter>
        <Button type="submit" disabled={isLoading} data-testid="button-submit-user">
          {isLoading ? (
            <>
              <Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />
              {isCreate ? "Erstellen..." : "Speichern..."}
            </>
          ) : (
            isCreate ? "Erstellen" : "Speichern"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}
