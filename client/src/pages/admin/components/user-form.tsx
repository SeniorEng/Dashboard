import { useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddressAutocomplete } from "@/components/address-autocomplete";
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
import { Loader2, MessageCircle } from "lucide-react";
import {
  UserData,
  UserFormData,
  ROLE_LABELS,
  AVAILABLE_ROLES,
  formatPhoneForDisplay,
  validateDachPhone,
} from "./user-types";
import {
  calculateVacationEntitlementByWorkDays,
  simulateAnnualEntitlementWithPatch,
  summarizeMonthlyBreakdown,
} from "@shared/domain/vacation";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import type { VacationSummary } from "@/lib/api/types";
import { formatVacationDays } from "@/lib/utils";

const MONTH_SHORT = [
  "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
  "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
];

function formatSegment(from: number, to: number): string {
  if (from === to) return MONTH_SHORT[from - 1];
  return `${MONTH_SHORT[from - 1]}–${MONTH_SHORT[to - 1]}`;
}

export function UserForm({
  mode,
  user,
  onSubmit,
  isLoading,
  allUsers = [],
}: {
  mode: "create" | "edit";
  user?: UserData;
  onSubmit: (data: UserFormData & { password?: string }) => void;
  isLoading: boolean;
  allUsers?: UserData[];
}) {
  const { user: currentUser } = useAuth();
  const isSuperAdmin = currentUser?.isSuperAdmin ?? false;

  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
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
  const [isTeamLead, setIsTeamLead] = useState(user?.isTeamLead ?? false);
  const [haustierAkzeptiert, setHaustierAkzeptiert] = useState(user?.haustierAkzeptiert ?? true);
  const [isEuRentner, setIsEuRentner] = useState(user?.isEuRentner ?? false);
  const [employmentType, setEmploymentType] = useState(user?.employmentType ?? "sozialversicherungspflichtig");
  const [weeklyWorkDays, setWeeklyWorkDays] = useState(user?.weeklyWorkDays?.toString() ?? "5");
  const [monthlyWorkHours, setMonthlyWorkHours] = useState(user?.monthlyWorkHours?.toString() ?? "");
  const [carryOverDays, setCarryOverDays] = useState(
    user?.carryOverDays?.toString() ?? ""
  );
  const [carryOverDaysTouched, setCarryOverDaysTouched] = useState(false);
  const [roles, setRoles] = useState<string[]>(user?.roles ?? []);
  const [whatsappEnabled, setWhatsappEnabled] = useState(user?.whatsappEnabled ?? false);

  const { data: vacationSummary } = useQuery<VacationSummary | null>({
    queryKey: ["admin", "vacation-summary", user?.id, new Date().getFullYear()],
    queryFn: async ({ signal }) => {
      if (!user?.id) return null;
      const year = new Date().getFullYear();
      const result = await api.get<VacationSummary>(
        `/admin/time-entries/vacation-summary/${user.id}/${year}`,
        signal,
      );
      return unwrapResult(result);
    },
    enabled: mode === "edit" && !!user?.id,
    staleTime: 30_000,
  });

  const entitlementPreview = useMemo(() => {
    if (mode !== "edit" || !vacationSummary) return null;
    const parsed = parseInt(vacationDaysPerYear);
    const value = Number.isFinite(parsed) ? parsed : vacationSummary.configuredAnnualDays;
    const now = new Date();
    const year = vacationSummary.year;
    const isCurrentYear = year === now.getFullYear();
    const patchMonth = isCurrentYear ? now.getMonth() + 1 : 1;
    const sim = simulateAnnualEntitlementWithPatch(
      vacationSummary.entitlementHistory ?? [],
      vacationSummary.eintrittsdatum ?? eintrittsdatum ?? null,
      year,
      patchMonth,
      value,
      value,
    );
    const breakdown = summarizeMonthlyBreakdown(
      sim.history,
      vacationSummary.eintrittsdatum ?? eintrittsdatum ?? null,
      year,
      value,
    );
    return {
      year,
      entitlement: sim.entitlement,
      breakdown,
      carryOverDays: vacationSummary.carryOverDays ?? 0,
    };
  }, [mode, vacationSummary, vacationDaysPerYear, eintrittsdatum]);

  const updateVacationFromWorkDays = (days: number) => {
    const vacation = calculateVacationEntitlementByWorkDays(days);
    setVacationDaysPerYear(vacation.toString());
  };

  const handleEmploymentTypeChange = (value: string) => {
    setEmploymentType(value);
    if (value === "minijobber") {
      setWeeklyWorkDays("2");
      updateVacationFromWorkDays(2);
      if (!monthlyWorkHours) {
        setMonthlyWorkHours("40");
      }
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
    const result = validateDachPhone(telefon);
    if (result.valid) {
      setTelefon(result.formatted);
      setTelefonError("");
    } else {
      setTelefonError(result.error);
    }
  };

  const validatePassword = (value: string): string => {
    if (!value.trim()) return "Passwort ist erforderlich";
    if (value.length < 8) return "Passwort muss mindestens 8 Zeichen haben";
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(value))
      return "Passwort muss Groß-/Kleinbuchstaben und eine Zahl enthalten";
    return "";
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (mode === "create") {
      const pwError = validatePassword(password);
      if (pwError) {
        setPasswordError(pwError);
        return;
      }
    }
    
    let normalizedTelefon: string | undefined = undefined;
    if (telefon.trim()) {
      const result = validateDachPhone(telefon);
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
      ...(mode === "edit" && carryOverDaysTouched ? { carryOverDays: carryOverDays ? parseInt(carryOverDays) : 0 } : {}),
      isAdmin,
      isTeamLead,
      haustierAkzeptiert,
      isEuRentner,
      employmentType,
      weeklyWorkDays: weeklyWorkDays ? parseInt(weeklyWorkDays) : 5,
      monthlyWorkHours: monthlyWorkHours ? parseFloat(monthlyWorkHours) : null,
      roles,
      whatsappEnabled,
    };
    
    if (mode === "create") {
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
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              {mode === "edit" && (
                <p className="text-xs text-gray-500" data-testid="text-vacation-prorata-hint">
                  Neuer Jahreswert gilt ab dem laufenden Monat. Vormonate behalten ihren bisherigen Wert. Daraus ergibt sich der Anspruch unten.
                </p>
              )}
            </div>
            {mode === "edit" && (
              <div className="space-y-2">
                <Label htmlFor="carryOverDays">Resturlaub Vorjahr (Tage)</Label>
                <Input
                  id="carryOverDays"
                  type="number"
                  min="0"
                  max="365"
                  value={carryOverDays}
                  onChange={(e) => { setCarryOverDays(e.target.value); setCarryOverDaysTouched(true); }}
                  placeholder="0"
                  data-testid="input-user-carry-over-days"
                />
                <p className="text-xs text-gray-500">Übertrag aus dem Vorjahr (verfällt 31.03.)</p>
              </div>
            )}
          </div>
          {mode === "edit" && entitlementPreview && (
            <div className="p-3 rounded-lg border border-teal-200 bg-teal-50 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-gray-700">Anspruch {entitlementPreview.year}:</span>
                <span className="font-semibold text-teal-800" data-testid="text-user-vacation-entitlement-preview">
                  {formatVacationDays(entitlementPreview.entitlement)} Tage
                </span>
              </div>
              {entitlementPreview.breakdown.length > 0 && (
                <p className="text-xs text-gray-600" data-testid="text-user-vacation-breakdown">
                  {entitlementPreview.breakdown
                    .map((s) => `${formatSegment(s.fromMonth, s.toMonth)}: ${s.daysPerYear} Tage/Jahr`)
                    .join(" · ")}
                  {entitlementPreview.carryOverDays > 0 && (
                    <> · zzgl. Übertrag Vorjahr {formatVacationDays(entitlementPreview.carryOverDays)} Tage</>
                  )}
                </p>
              )}
              <p className="text-[11px] text-gray-500">anteilig aus Vormonaten und neuem Wert</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">Beschäftigungsverhältnis</h3>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              placeholder={employmentType === "minijobber" ? "z.B. 40" : "z.B. 120"}
              data-testid="input-monthly-work-hours"
            />
            <p className="text-xs text-gray-500">
              Vertraglich vereinbarte monatliche Arbeitszeit (für Feiertagsberechnung und Team-Auslastung)
            </p>
          </div>

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
          
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="sm:col-span-3 space-y-2">
              <Label htmlFor="strasse">Straße</Label>
              <AddressAutocomplete
                id="strasse"
                value={strasse}
                onChange={setStrasse}
                onAddressSelect={(addr) => {
                  setStrasse(addr.strasse);
                  setHausnummer(addr.hausnummer);
                  setPlz(addr.plz);
                  setStadt(addr.stadt);
                }}
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
          
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="plz">PLZ</Label>
              <Input
                id="plz"
                value={plz}
                onChange={(e) => setPlz(e.target.value.replace(/\D/g, "").slice(0, 5))}
                maxLength={5}
                inputMode="numeric"
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
                onChange={(e) => { setPassword(e.target.value); setPasswordError(""); }}
                required
                minLength={8}
                placeholder="Mindestens 8 Zeichen, Groß-/Kleinbuchstaben und Zahl"
                className={passwordError ? "border-red-500" : ""}
                data-testid="input-user-password"
              />
              {passwordError && (
                <p className="text-xs text-red-500">{passwordError}</p>
              )}
              <p className="text-xs text-gray-500">
                Mindestens 8 Zeichen, mit Groß- und Kleinbuchstaben sowie einer Zahl.
              </p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">Berechtigungen</h3>

          {isSuperAdmin && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="isAdmin"
                checked={isAdmin}
                onCheckedChange={(checked) => {
                  const next = !!checked;
                  setIsAdmin(next);
                  if (next) {
                    setIsTeamLead(false);
                  }
                }}
                data-testid="checkbox-is-admin"
              />
              <Label htmlFor="isAdmin">Administrator-Rechte</Label>
            </div>
          )}

          {isSuperAdmin && (
            <div className="flex items-start space-x-2">
              <Checkbox
                id="isTeamLead"
                checked={isTeamLead}
                disabled={isAdmin}
                onCheckedChange={(checked) => setIsTeamLead(!!checked)}
                data-testid="checkbox-is-team-lead"
              />
              <div className="space-y-1 leading-none">
                <Label htmlFor="isTeamLead">Teamleitung</Label>
                <p className="text-xs text-gray-500">
                  Teamleitungen haben die gleiche Sicht auf Termine und Kunden wie Administratoren (firmenweit, mit Mitarbeiter-Toggle).
                </p>
              </div>
            </div>
          )}

          <div className="flex items-start space-x-2">
            <Checkbox
              id="whatsappEnabled"
              checked={whatsappEnabled}
              onCheckedChange={(checked) => setWhatsappEnabled(!!checked)}
              data-testid="checkbox-whatsapp-enabled"
            />
            <div className="space-y-1 leading-none">
              <Label htmlFor="whatsappEnabled" className="flex items-center gap-1.5">
                <MessageCircle className="h-3.5 w-3.5 text-green-600" />
                WhatsApp-Benachrichtigungen
              </Label>
              <p className="text-xs text-gray-500">Mitarbeiter erhält Benachrichtigungen per WhatsApp</p>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">Tätigkeitsbereiche</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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

          <div className="flex items-start space-x-2 pt-2">
            <Checkbox
              id="haustierAkzeptiert"
              checked={haustierAkzeptiert}
              onCheckedChange={(checked) => setHaustierAkzeptiert(!!checked)}
              data-testid="checkbox-haustier-akzeptiert"
            />
            <div className="space-y-1 leading-none">
              <Label htmlFor="haustierAkzeptiert">Akzeptiert Haustiere</Label>
              <p className="text-xs text-gray-500">Bereit, bei Kunden mit Haustieren zu arbeiten</p>
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
