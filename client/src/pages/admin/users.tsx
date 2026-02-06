import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { iconSize } from "@/design-system";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Plus,
  Loader2,
  UserCheck,
  UserX,
  Pencil,
  Key,
  Trash2,
  Shield,
  User,
  Euro,
} from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { formatDateDisplay } from "@shared/utils/format";

interface UserData {
  id: number;
  email: string;
  displayName: string;
  vorname: string | null;
  nachname: string | null;
  telefon: string | null;
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
  stadt: string | null;
  geburtsdatum: string | null;
  isActive: boolean;
  isAdmin: boolean;
  roles: string[];
  createdAt: string;
}

interface UserFormData {
  email: string;
  password?: string;
  vorname: string;
  nachname: string;
  telefon?: string;
  strasse?: string;
  hausnummer?: string;
  plz?: string;
  stadt?: string;
  geburtsdatum?: string;
  isAdmin: boolean;
  roles: string[];
  compensation?: {
    hourlyRateHauswirtschaft?: string;
    hourlyRateAlltagsbegleitung?: string;
    travelCostType?: "kilometergeld" | "pauschale";
    kilometerRate?: string;
    monthlyTravelAllowance?: string;
    validFrom: string;
  };
}

const ROLE_LABELS: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
  erstberatung: "Erstberatung",
  personenbefoerderung: "Personenbeförderung",
  kinderbetreuung: "Kinderbetreuung",
};

const AVAILABLE_ROLES = [
  "hauswirtschaft",
  "alltagsbegleitung",
  "erstberatung",
  "personenbefoerderung",
  "kinderbetreuung",
];

// Format phone number for display (E.164 to national format)
function formatPhoneDisplay(phone: string): string {
  if (!phone) return '';
  // Convert +49... to 0... format for display
  if (phone.startsWith('+49')) {
    return '0' + phone.slice(3).replace(/(\d{3})(\d+)/, '$1 $2');
  }
  return phone;
}

// Validate German phone number
function validateGermanPhoneNumber(input: string): 
  | { valid: true; normalized: string; formatted: string }
  | { valid: false; error: string } {
  if (!input || input.trim() === "") {
    return { valid: false, error: "Telefonnummer ist erforderlich" };
  }
  
  const cleaned = input.trim().replace(/\s+/g, '');
  
  // Basic German phone pattern check
  const germanPattern = /^(\+49|0049|0)[1-9]\d{6,13}$/;
  if (!germanPattern.test(cleaned)) {
    return { valid: false, error: "Ungültige deutsche Telefonnummer" };
  }
  
  // Normalize to E.164
  let normalized: string;
  if (cleaned.startsWith('+49')) {
    normalized = cleaned;
  } else if (cleaned.startsWith('0049')) {
    normalized = '+49' + cleaned.slice(4);
  } else if (cleaned.startsWith('0')) {
    normalized = '+49' + cleaned.slice(1);
  } else {
    normalized = '+49' + cleaned;
  }
  
  // Format for display
  const nationalNumber = normalized.slice(3);
  const formatted = '0' + nationalNumber.slice(0, 3) + ' ' + nationalNumber.slice(3);
  
  return { valid: true, normalized, formatted };
}

export default function AdminUsers() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserData | null>(null);
  const [resetPasswordUser, setResetPasswordUser] = useState<UserData | null>(null);

  const { data: users, isLoading } = useQuery<UserData[]>({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (!res.ok) throw new Error("Benutzer konnten nicht geladen werden");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: UserFormData & { password: string }) => {
      const result = await api.post("/admin/users", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      setIsCreateOpen(false);
      toast({ title: "Benutzer erstellt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number } & Partial<UserFormData>) => {
      const result = await api.patch(`/admin/users/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      setEditingUser(null);
      toast({ title: "Benutzer aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, activate }: { id: number; activate: boolean }) => {
      const endpoint = activate ? "activate" : "deactivate";
      const result = await api.post(`/admin/users/${id}/${endpoint}`, {});
      return unwrapResult(result);
    },
    onSuccess: (_, { activate }) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      toast({ title: activate ? "Benutzer aktiviert" : "Benutzer deaktiviert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async ({ id, newPassword }: { id: number; newPassword: string }) => {
      const result = await api.post(`/admin/users/${id}/reset-password`, { newPassword });
      return unwrapResult(result);
    },
    onSuccess: () => {
      setResetPasswordUser(null);
      toast({ title: "Passwort zurückgesetzt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const result = await api.delete(`/admin/users/${id}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      toast({ title: "Benutzer gelöscht" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleCreateSubmit = (data: UserFormData & { password?: string }) => {
    if (!data.password) return;
    createMutation.mutate(data as UserFormData & { password: string });
  };

  const handleEditSubmit = (data: UserFormData) => {
    if (!editingUser) return;
    updateMutation.mutate({ id: editingUser.id, ...data });
  };

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex items-center justify-between gap-2 mb-6">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              <Link href="/admin">
                <Button variant="ghost" size="icon" data-testid="button-back" className="shrink-0">
                  <ArrowLeft className={iconSize.md} />
                </Button>
              </Link>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">Benutzerverwaltung</h1>
            </div>
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button className="bg-teal-600 hover:bg-teal-700 shrink-0" data-testid="button-create-user">
                  <Plus className={`${iconSize.sm} sm:mr-2`} />
                  <span className="hidden sm:inline">Neuer Benutzer</span>
                  <span className="sm:hidden">Neu</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <UserForm
                  mode="create"
                  onSubmit={handleCreateSubmit}
                  isLoading={createMutation.isPending}
                />
              </DialogContent>
            </Dialog>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {users?.map((user) => (
                <Card key={user.id} data-testid={`card-user-${user.id}`}>
                  <CardContent className="p-0">
                    <div className="flex">
                      {/* Left column - 80% */}
                      <div className="flex-1 p-4">
                        {/* Top: Name, Phone, Badges */}
                        <div className="flex items-center gap-3 mb-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-gray-900">{user.displayName}</span>
                              <span className="text-gray-400">·</span>
                              <span className="text-sm text-gray-500">
                                {user.telefon ? formatPhoneDisplay(user.telefon) : '–'}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {!user.isActive && (
                              <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-600">
                                Inaktiv
                              </span>
                            )}
                            <span className={`text-xs px-2 py-0.5 rounded ${user.isAdmin ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-600'}`}>
                              {user.isAdmin ? 'Admin' : 'Mitarbeiter'}
                            </span>
                          </div>
                        </div>
                        
                        {/* Bottom: Skills */}
                        <div>
                          <div className="text-xs text-gray-500 mb-1">Tätigkeitsbereiche</div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {user.roles.map((role) => (
                              <span key={role} className="text-sm text-gray-700">
                                {ROLE_LABELS[role] || role}
                              </span>
                            ))}
                            {user.roles.length === 0 && (
                              <span className="text-sm text-gray-400 italic">Keine zugewiesen</span>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      {/* Right column - Buttons spanning full height */}
                      <div className="flex flex-col justify-center gap-1 px-3 bg-gray-50 border-l border-gray-100">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setEditingUser(user)}
                          data-testid={`button-edit-user-${user.id}`}
                        >
                          <Pencil className={`${iconSize.sm} text-gray-600`} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setResetPasswordUser(user)}
                          data-testid={`button-reset-password-${user.id}`}
                        >
                          <Key className={`${iconSize.sm} text-gray-600`} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() =>
                            toggleActiveMutation.mutate({
                              id: user.id,
                              activate: !user.isActive,
                            })
                          }
                          data-testid={`button-toggle-active-${user.id}`}
                        >
                          {user.isActive ? (
                            <UserX className={`${iconSize.sm} text-red-500`} />
                          ) : (
                            <UserCheck className={`${iconSize.sm} text-green-500`} />
                          )}
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              data-testid={`button-delete-user-${user.id}`}
                            >
                              <Trash2 className={`${iconSize.sm} text-red-500`} />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Benutzer löschen?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Möchten Sie den Benutzer "{user.displayName}" wirklich löschen?
                                Diese Aktion kann nicht rückgängig gemacht werden.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => deleteMutation.mutate(user.id)}
                                className="bg-red-600 hover:bg-red-700"
                              >
                                Löschen
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!editingUser} onOpenChange={() => setEditingUser(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          {editingUser && (
            <>
              <UserForm
                mode="edit"
                user={editingUser}
                onSubmit={handleEditSubmit}
                isLoading={updateMutation.isPending}
              />
              <CompensationSection userId={editingUser.id} userName={editingUser.displayName} />
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!resetPasswordUser} onOpenChange={() => setResetPasswordUser(null)}>
        <DialogContent>
          {resetPasswordUser && (
            <ResetPasswordForm
              user={resetPasswordUser}
              onSubmit={(newPassword) =>
                resetPasswordMutation.mutate({ id: resetPasswordUser.id, newPassword })
              }
              isLoading={resetPasswordMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </Layout>
  );
}

function UserForm({
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
    new Date().toISOString().split("T")[0]
  );

  const hasCompensationData = 
    hourlyRateHauswirtschaft || 
    hourlyRateAlltagsbegleitung || 
    travelCostType;

  // Validate and normalize phone on blur
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
    
    // Validate phone before submit
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
        hourlyRateHauswirtschaft: hourlyRateHauswirtschaft || undefined,
        hourlyRateAlltagsbegleitung: hourlyRateAlltagsbegleitung || undefined,
        travelCostType: travelCostType || undefined,
        kilometerRate: travelCostType === "kilometergeld" ? kilometerRate : undefined,
        monthlyTravelAllowance: travelCostType === "pauschale" ? monthlyTravelAllowance : undefined,
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

interface CompensationData {
  id: number;
  userId: number;
  hourlyRateHauswirtschaft: string | null;
  hourlyRateAlltagsbegleitung: string | null;
  travelCostType: string | null;
  kilometerRate: string | null;
  monthlyTravelAllowance: string | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
}

function CompensationSection({ userId, userName }: { userId: number; userName: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newHourlyRateHauswirtschaft, setNewHourlyRateHauswirtschaft] = useState("");
  const [newHourlyRateAlltagsbegleitung, setNewHourlyRateAlltagsbegleitung] = useState("");
  const [newTravelCostType, setNewTravelCostType] = useState<"kilometergeld" | "pauschale" | "">("");
  const [newKilometerRate, setNewKilometerRate] = useState("");
  const [newMonthlyTravelAllowance, setNewMonthlyTravelAllowance] = useState("");
  const todayDate = new Date().toISOString().split("T")[0];
  const [newValidFrom, setNewValidFrom] = useState(todayDate);

  const { data: compensationHistory, isLoading } = useQuery<CompensationData[]>({
    queryKey: ["admin", "users", userId, "compensation"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/users/${userId}/compensation`, { credentials: "include" });
      if (!res.ok) throw new Error("Vergütungshistorie konnte nicht geladen werden");
      return res.json();
    },
  });

  const addCompensationMutation = useMutation({
    mutationFn: async (data: {
      hourlyRateHauswirtschaft?: string;
      hourlyRateAlltagsbegleitung?: string;
      travelCostType?: string;
      kilometerRate?: string;
      monthlyTravelAllowance?: string;
      validFrom: string;
    }) => {
      const result = await api.post(`/admin/users/${userId}/compensation`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users", userId, "compensation"] });
      setIsAddOpen(false);
      setNewHourlyRateHauswirtschaft("");
      setNewHourlyRateAlltagsbegleitung("");
      setNewTravelCostType("");
      setNewKilometerRate("");
      setNewMonthlyTravelAllowance("");
      setNewValidFrom(new Date().toISOString().split("T")[0]);
      toast({ title: "Vergütung hinzugefügt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addCompensationMutation.mutate({
      hourlyRateHauswirtschaft: newHourlyRateHauswirtschaft || undefined,
      hourlyRateAlltagsbegleitung: newHourlyRateAlltagsbegleitung || undefined,
      travelCostType: newTravelCostType || undefined,
      kilometerRate: newTravelCostType === "kilometergeld" ? newKilometerRate : undefined,
      monthlyTravelAllowance: newTravelCostType === "pauschale" ? newMonthlyTravelAllowance : undefined,
      validFrom: newValidFrom,
    });
  };

  const formatCompensationValue = (value: string | null) => {
    if (!value) return "-";
    return `${parseFloat(value).toFixed(2)} €`;
  };

  const currentCompensation = compensationHistory?.find(c => !c.validTo);

  return (
    <div className="mt-6 pt-6 border-t">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <Euro className={iconSize.sm} />
          Vergütung
        </h3>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => setIsAddOpen(!isAddOpen)}
          data-testid="button-add-compensation"
        >
          <Plus className={`${iconSize.sm} mr-1`} />
          Neue Vergütung
        </Button>
      </div>

      {isAddOpen && (
        <form onSubmit={handleAddSubmit} className="mb-4 p-4 bg-gray-50 rounded-lg space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="new-hourly-rate-hauswirtschaft">Stundenlohn Hauswirtschaft</Label>
              <div className="relative">
                <Input
                  id="new-hourly-rate-hauswirtschaft"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newHourlyRateHauswirtschaft}
                  onChange={(e) => setNewHourlyRateHauswirtschaft(e.target.value)}
                  placeholder="z.B. 15.50"
                  className="pr-8"
                  data-testid="input-new-hourly-rate-hauswirtschaft"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/h</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-hourly-rate-alltagsbegleitung">Stundenlohn Alltagsbegleitung</Label>
              <div className="relative">
                <Input
                  id="new-hourly-rate-alltagsbegleitung"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newHourlyRateAlltagsbegleitung}
                  onChange={(e) => setNewHourlyRateAlltagsbegleitung(e.target.value)}
                  placeholder="z.B. 16.00"
                  className="pr-8"
                  data-testid="input-new-hourly-rate-alltagsbegleitung"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/h</span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-travel-cost-type">Fahrtkostenmodell</Label>
            <Select
              value={newTravelCostType}
              onValueChange={(value: "kilometergeld" | "pauschale" | "") => {
                setNewTravelCostType(value);
                if (value === "kilometergeld") {
                  setNewMonthlyTravelAllowance("");
                } else if (value === "pauschale") {
                  setNewKilometerRate("");
                }
              }}
            >
              <SelectTrigger data-testid="select-new-travel-cost-type">
                <SelectValue placeholder="Bitte wählen..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="kilometergeld">Kilometergeld</SelectItem>
                <SelectItem value="pauschale">Monatliche Pauschale</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {newTravelCostType === "kilometergeld" && (
            <div className="space-y-2">
              <Label htmlFor="new-kilometer-rate">Kilometergeld</Label>
              <div className="relative">
                <Input
                  id="new-kilometer-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newKilometerRate}
                  onChange={(e) => setNewKilometerRate(e.target.value)}
                  placeholder="z.B. 0.30"
                  className="pr-12"
                  data-testid="input-new-kilometer-rate"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/km</span>
              </div>
            </div>
          )}

          {newTravelCostType === "pauschale" && (
            <div className="space-y-2">
              <Label htmlFor="new-monthly-travel-allowance">Monatliche Pauschale</Label>
              <div className="relative">
                <Input
                  id="new-monthly-travel-allowance"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newMonthlyTravelAllowance}
                  onChange={(e) => setNewMonthlyTravelAllowance(e.target.value)}
                  placeholder="z.B. 150.00"
                  className="pr-14"
                  data-testid="input-new-monthly-travel-allowance"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/Monat</span>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Gültig ab *</Label>
            <DatePicker
              value={newValidFrom || null}
              onChange={(val) => setNewValidFrom(val || "")}
              minDate={new Date(todayDate)}
              data-testid="input-new-valid-from"
            />
            <p className="text-xs text-gray-500">Nur ab heute oder in der Zukunft möglich</p>
          </div>

          <div className="flex gap-2">
            <Button 
              type="submit" 
              disabled={addCompensationMutation.isPending}
              data-testid="button-submit-compensation"
            >
              {addCompensationMutation.isPending ? (
                <><Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />Speichern...</>
              ) : "Speichern"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>
              Abbrechen
            </Button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : compensationHistory && compensationHistory.length > 0 ? (
        <div className="space-y-3">
          {currentCompensation && (
            <div className="p-3 bg-teal-50 border border-teal-200 rounded-lg">
              <div className="flex items-center gap-2 mb-3">
                <Badge variant="secondary" className="bg-teal-100 text-teal-800">Aktuell</Badge>
                <span className="text-sm text-gray-500">seit {formatDateDisplay(currentCompensation.validFrom)}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-gray-500 text-xs">Hauswirtschaft</div>
                  <div className="font-medium">{formatCompensationValue(currentCompensation.hourlyRateHauswirtschaft)}/h</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Alltagsbegleitung</div>
                  <div className="font-medium">{formatCompensationValue(currentCompensation.hourlyRateAlltagsbegleitung)}/h</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Fahrtkosten</div>
                  <div className="font-medium">
                    {currentCompensation.travelCostType === "kilometergeld" 
                      ? `${formatCompensationValue(currentCompensation.kilometerRate)}/km`
                      : currentCompensation.travelCostType === "pauschale"
                      ? `${formatCompensationValue(currentCompensation.monthlyTravelAllowance)}/Mo`
                      : "-"}
                  </div>
                </div>
              </div>
            </div>
          )}

          {compensationHistory.filter(c => c.validTo).length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-medium text-gray-500 mb-2">Vergangene Vergütungen</h4>
              <div className="space-y-2">
                {compensationHistory.filter(c => c.validTo).map((comp) => (
                  <div key={comp.id} className="p-2 bg-gray-50 rounded text-sm">
                    <div className="text-gray-500 text-xs mb-1">
                      {formatDateDisplay(comp.validFrom)} - {formatDateDisplay(comp.validTo!)}
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-xs">
                      <span>HW: {formatCompensationValue(comp.hourlyRateHauswirtschaft)}/h</span>
                      <span>AB: {formatCompensationValue(comp.hourlyRateAlltagsbegleitung)}/h</span>
                      <span>
                        {comp.travelCostType === "kilometergeld" 
                          ? `${formatCompensationValue(comp.kilometerRate)}/km`
                          : comp.travelCostType === "pauschale"
                          ? `${formatCompensationValue(comp.monthlyTravelAllowance)}/Mo`
                          : "-"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-500 py-4 text-center">Noch keine Vergütung hinterlegt</p>
      )}
    </div>
  );
}

function ResetPasswordForm({
  user,
  onSubmit,
  isLoading,
}: {
  user: UserData;
  onSubmit: (newPassword: string) => void;
  isLoading: boolean;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("Passwörter stimmen nicht überein");
      return;
    }
    setError("");
    onSubmit(newPassword);
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Passwort zurücksetzen</DialogTitle>
        <DialogDescription>
          Setzen Sie das Passwort für {user.displayName} zurück.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-4">
        <div className="space-y-2">
          <Label htmlFor="newPassword">Neues Passwort</Label>
          <Input
            id="newPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
            data-testid="input-new-password"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Passwort bestätigen</Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            data-testid="input-confirm-new-password"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
      <DialogFooter>
        <Button type="submit" disabled={isLoading} data-testid="button-submit-reset-password">
          {isLoading ? (
            <>
              <Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />
              Zurücksetzen...
            </>
          ) : (
            "Zurücksetzen"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}
