import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { iconSize } from "@/design-system";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import {
  UserData,
  UserFormData,
  ROLE_LABELS,
  AVAILABLE_ROLES,
  formatPhoneForDisplay,
  validateGermanPhone,
} from "./user-types";
import { calculateVacationEntitlementByWorkDays } from "@shared/domain/vacation";

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
  const [telefon, setTelefon] = useState(user?.telefon ? formatPhoneForDisplay(user.telefon) : "");
  const [telefonError, setTelefonError] = useState("");
  const [strasse, setStrasse] = useState(user?.strasse ?? "");
  const [hausnummer, setHausnummer] = useState(user?.hausnummer ?? "");
  const [plz, setPlz] = useState(user?.plz ?? "");
  const [stadt, setStadt] = useState(user?.stadt ?? "");
  const [geburtsdatum, setGeburtsdatum] = useState(user?.geburtsdatum ?? "");
  const [eintrittsdatum, setEintrittsdatum] = useState(user?.eintrittsdatum ?? "");
  const [austrittsDatum, setAustrittsDatum] = useState(user?.austrittsDatum ?? "");
  const [vacationDaysPerYear, setVacationDaysPerYear] = useState(
    user?.vacationDaysPerYear?.toString() ?? "30"
  );
  const [isAdmin, setIsAdmin] = useState(user?.isAdmin ?? false);
  const [haustierAkzeptiert, setHaustierAkzeptiert] = useState(user?.haustierAkzeptiert ?? true);
  const [isEuRentner, setIsEuRentner] = useState(user?.isEuRentner ?? false);
  const [employmentType, setEmploymentType] = useState(user?.employmentType ?? "sozialversicherungspflichtig");
  const [weeklyWorkDays, setWeeklyWorkDays] = useState(user?.weeklyWorkDays?.toString() ?? "5");
  const [monthlyWorkHours, setMonthlyWorkHours] = useState(user?.monthlyWorkHours?.toString() ?? "");
  const [lbnr, setLbnr] = useState(user?.lbnr ?? "");
  const [personalnummer, setPersonalnummer] = useState(user?.personalnummer ?? "");
  const [roles, setRoles] = useState<string[]>(user?.roles ?? []);

  const updateVacationFromWorkDays = (days: number) => {
    const vacation = calculateVacationEntitlementByWorkDays(days);
    setVacationDaysPerYear(vacation.toString());
  };

  const handleEmploymentTypeChange = (value: string) => {
    setEmploymentType(value);
    if (value === "minijobber") {
      setWeeklyWorkDays("2");
      updateVacationFromWorkDays(2);
    } else {
      setWeeklyWorkDays("5");
      updateVacationFromWorkDays(5);
    }
  };

  const handleWeeklyWorkDaysChange = (value: string) => {
    setWeeklyWorkDays(value);
    const days = parseInt(value);
    if (!isNaN(days) && days >= 1 && days <= 7) {
      updateVacationFromWorkDays(days);
    }
  };

  const handleTelefonBlur = () => {
    if (!telefon.trim()) {
      setTelefonError("");
      return;
    }
    const result = validateGermanPhone(telefon);
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
      const result = validateGermanPhone(telefon);
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
      eintrittsdatum: eintrittsdatum || undefined,
      austrittsDatum: austrittsDatum || null,
      vacationDaysPerYear: vacationDaysPerYear ? parseInt(vacationDaysPerYear) : undefined,
      isAdmin,
      haustierAkzeptiert,
      isEuRentner,
      employmentType,
      weeklyWorkDays: weeklyWorkDays ? parseInt(weeklyWorkDays) : 5,
      monthlyWorkHours: monthlyWorkHours ? parseFloat(monthlyWorkHours) : null,
      lbnr: lbnr || null,
      personalnummer: personalnummer || null,
      roles,
    };
    
    if (mode === "create" && password) {
      data.password = password;
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
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Eintrittsdatum</Label>
              <DatePicker
                value={eintrittsdatum || null}
                onChange={(val) => setEintrittsdatum(val || "")}
                data-testid="input-user-eintrittsdatum"
              />
            </div>
            <div className="space-y-2">
              <Label>Austrittsdatum</Label>
              <DatePicker
                value={austrittsDatum || null}
                onChange={(val) => setAustrittsDatum(val || "")}
                data-testid="input-user-austrittsdatum"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="vacationDaysPerYear">Jahresurlaub (Tage)</Label>
              <Input
                id="vacationDaysPerYear"
                type="number"
                min="0"
                max="365"
                value={vacationDaysPerYear}
                onChange={(e) => setVacationDaysPerYear(e.target.value)}
                placeholder="30"
                data-testid="input-user-vacation-days"
              />
              <p className="text-xs text-gray-500">Urlaubsanspruch auf 12 Monate</p>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">Beschäftigungsverhältnis</h3>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Beschäftigungsart</Label>
              <Select value={employmentType} onValueChange={handleEmploymentTypeChange}>
                <SelectTrigger data-testid="select-employment-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sozialversicherungspflichtig">Sozialversicherungspflichtig</SelectItem>
                  <SelectItem value="minijobber">Minijobber</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="weeklyWorkDays">Arbeitstage pro Woche</Label>
              <Input
                id="weeklyWorkDays"
                type="number"
                min="1"
                max="7"
                value={weeklyWorkDays}
                onChange={(e) => handleWeeklyWorkDaysChange(e.target.value)}
                data-testid="input-weekly-work-days"
              />
              <p className="text-xs text-gray-500">Beeinflusst Urlaubs- und Krankheitsberechnung</p>
            </div>
          </div>

          {employmentType !== "minijobber" && (
            <div className="space-y-2">
              <Label htmlFor="monthlyWorkHours">Monatsarbeitszeit (Stunden)</Label>
              <Input
                id="monthlyWorkHours"
                type="number"
                min="1"
                max="300"
                step="0.5"
                value={monthlyWorkHours}
                onChange={(e) => setMonthlyWorkHours(e.target.value)}
                placeholder="z.B. 120"
                data-testid="input-monthly-work-hours"
              />
              <p className="text-xs text-gray-500">Vertraglich vereinbarte monatliche Arbeitszeit (für Feiertagsberechnung)</p>
            </div>
          )}

          <div className="flex items-center space-x-2">
            <Checkbox
              id="isEuRentner"
              checked={isEuRentner}
              onCheckedChange={(checked) => setIsEuRentner(!!checked)}
              data-testid="checkbox-eu-rentner"
            />
            <div>
              <Label htmlFor="isEuRentner">EU-Rentner (Erwerbsminderungsrente)</Label>
              <p className="text-xs text-gray-500">Max. unter 3h/Tag, unter 15h/Woche (§43 SGB VI)</p>
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
              <Label htmlFor="password">Passwort</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                placeholder="Mindestens 8 Zeichen"
                data-testid="input-user-password"
              />
              <p className="text-xs text-gray-500">
                Leer lassen, um automatisch ein Passwort zu generieren. Der Mitarbeiter erhält eine Willkommens-E-Mail mit einem Link zur Passwort-Einrichtung.
              </p>
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
          
          <div className="flex items-center space-x-2">
            <Checkbox
              id="haustierAkzeptiert"
              checked={haustierAkzeptiert}
              onCheckedChange={(checked) => setHaustierAkzeptiert(!!checked)}
              data-testid="checkbox-haustier-akzeptiert"
            />
            <Label htmlFor="haustierAkzeptiert">Akzeptiert Haustiere im Haushalt</Label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="personalnummer">Personalnummer (Lexware)</Label>
              <Input
                id="personalnummer"
                value={personalnummer}
                onChange={(e) => setPersonalnummer(e.target.value)}
                placeholder="z.B. 0001"
                data-testid="input-personalnummer"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lbnr">LBNR (Beschäftigtennummer)</Label>
              <Input
                id="lbnr"
                value={lbnr}
                onChange={(e) => setLbnr(e.target.value)}
                placeholder="Lebenslange Beschäftigtennummer"
                data-testid="input-lbnr"
              />
            </div>
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
