import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { iconSize, componentStyles } from "@/design-system";
import { formatVacationDays } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
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
import { useAuth } from "@/hooks/use-auth";
import {
  ArrowLeft,
  Plus,
  Loader2,
  UserCheck,
  UserX,
  Pencil,
  Key,
  Trash2,
  Search,
  ShieldOff,
  Mail,
  Shield,
  Save,
  ArrowRightLeft,
  Users,
  Calendar,
  AlertTriangle,
  Palmtree,
  Info,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, unwrapResult } from "@/lib/api/client";
import {
  UserData,
  UserFormData,
  ROLE_LABELS,
  AVAILABLE_ROLES,
  formatPhoneForDisplay,
} from "./components/user-types";
import { useEmployeeWorkload } from "@/features/customers/hooks/use-employee-workload";
import { useAllVacationSummaries } from "@/features/time-tracking/hooks/use-vacation-summaries";
import { UserForm } from "./components/user-form";
import { EmployeeDocumentsSection } from "./components/employee-documents-section";
import { EmployeeServiceRates } from "./components/employee-service-rates";
import { EmployeeDocumentRequirementsSection } from "./components/employee-document-requirements-section";
import { ResetPasswordForm } from "./components/reset-password-form";
import { ADMIN_PERMISSION_KEYS, ADMIN_PERMISSION_LABELS } from "@shared/schema";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type StatusFilter = "aktiv" | "inaktiv" | "alle";

function AdminPermissionsSection({ userId }: { userId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);

  const { data: permissionsData, isLoading: permissionsLoading } = useQuery<{ permissions: string[] }>({
    queryKey: ["admin", "users", userId, "permissions"],
    queryFn: async () => {
      const result = await api.get<{ permissions: string[] }>(`/admin/users/${userId}/permissions`);
      return unwrapResult(result);
    },
  });

  if (permissionsData && !hasLoaded) {
    setSelectedPermissions(permissionsData.permissions);
    setHasLoaded(true);
  }

  const saveMutation = useMutation({
    mutationFn: async (permissions: string[]) => {
      const result = await api.put(`/admin/users/${userId}/permissions`, { permissions });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users", userId, "permissions"] });
      toast({ title: "Berechtigungen gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const allSelected = ADMIN_PERMISSION_KEYS.every((key) => selectedPermissions.includes(key));

  const toggleAll = () => {
    if (allSelected) {
      setSelectedPermissions([]);
    } else {
      setSelectedPermissions([...ADMIN_PERMISSION_KEYS]);
    }
  };

  const togglePermission = (key: string, checked: boolean) => {
    if (checked) {
      setSelectedPermissions((prev) => [...prev, key]);
    } else {
      setSelectedPermissions((prev) => prev.filter((k) => k !== key));
    }
  };

  if (permissionsLoading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
      </div>
    );
  }

  return (
    <div className="space-y-4 border-t pt-4 mt-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className={`${iconSize.sm} text-teal-600`} />
          <h3 className="text-sm font-semibold text-gray-700">Admin-Berechtigungen</h3>
        </div>
        <Button
          variant="link"
          size="sm"
          onClick={toggleAll}
          className="text-xs"
          data-testid="button-toggle-all-permissions"
        >
          {allSelected ? "Keine auswählen" : "Alle auswählen"}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {ADMIN_PERMISSION_KEYS.map((key) => (
          <div key={key} className="flex items-center space-x-2">
            <Checkbox
              id={`perm-${key}`}
              checked={selectedPermissions.includes(key)}
              onCheckedChange={(checked) => togglePermission(key, !!checked)}
              data-testid={`checkbox-permission-${key}`}
            />
            <Label htmlFor={`perm-${key}`} className="text-sm">
              {ADMIN_PERMISSION_LABELS[key as keyof typeof ADMIN_PERMISSION_LABELS]}
            </Label>
          </div>
        ))}
      </div>
      <Button
        size="sm"
        onClick={() => saveMutation.mutate(selectedPermissions)}
        disabled={saveMutation.isPending}
        className="bg-teal-600 hover:bg-teal-700"
        data-testid="button-save-permissions"
      >
        {saveMutation.isPending ? (
          <>
            <Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />
            Speichern...
          </>
        ) : (
          <>
            <Save className={`mr-2 ${iconSize.sm}`} />
            Berechtigungen speichern
          </>
        )}
      </Button>
    </div>
  );
}

interface HandoverPreview {
  sourceEmployee: { id: number; displayName: string };
  targetEmployee: { id: number; displayName: string };
  primaryCustomers: { id: number; name: string; vorname: string; nachname: string }[];
  backupCustomers: { id: number; name: string; vorname: string; nachname: string }[];
  backup2Customers: { id: number; name: string; vorname: string; nachname: string }[];
  futureAppointments: { id: number; date: string; startTime: string; endTime: string; customerName: string; customerVorname: string; customerNachname: string }[];
  summary: { primaryCount: number; backupCount: number; backup2Count: number; appointmentCount: number };
}

function HandoverDialog({ user, allUsers, onClose }: { user: UserData; allUsers: UserData[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [targetEmployeeId, setTargetEmployeeId] = useState<string>("");

  const activeEmployees = useMemo(
    () => allUsers.filter((u) => u.isActive && u.id !== user.id && !u.isAnonymized),
    [allUsers, user.id]
  );

  const { data: preview, isLoading: previewLoading } = useQuery<HandoverPreview>({
    queryKey: ["admin", "handover-preview", user.id, targetEmployeeId],
    queryFn: async () => {
      const result = await api.get<HandoverPreview>(`/admin/employees/${user.id}/handover-preview?targetEmployeeId=${targetEmployeeId}`);
      return unwrapResult(result);
    },
    enabled: !!targetEmployeeId,
  });

  interface HandoverResult {
    primaryCount?: number;
    backupCount?: number;
    backup2Count?: number;
    appointmentCount?: number;
  }

  const handoverMutation = useMutation({
    mutationFn: async (): Promise<HandoverResult> => {
      const result = await api.post<HandoverResult>(`/admin/employees/${user.id}/handover`, {
        targetEmployeeId: parseInt(targetEmployeeId),
      });
      return unwrapResult(result);
    },
    onSuccess: (data: HandoverResult) => {
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      const total = (data.primaryCount || 0) + (data.backupCount || 0) + (data.backup2Count || 0);
      toast({
        title: "Übergabe erfolgreich",
        description: `${total} Kundenzuordnung(en) und ${data.appointmentCount || 0} Termin(e) übertragen.`,
      });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Fehler bei der Übergabe", description: error.message, variant: "destructive" });
    },
  });

  const totalCustomers = preview ? preview.summary.primaryCount + preview.summary.backupCount + preview.summary.backup2Count : 0;
  const totalAffected = totalCustomers + (preview?.summary.appointmentCount || 0);

  return (
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-handover">
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900" data-testid="text-handover-title">
            Kunden & Termine übergeben
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Alle Kundenzuordnungen und zukünftigen Termine von <strong>{user.displayName}</strong> an eine andere Mitarbeiterin übergeben.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Übergeben an</Label>
          <Select value={targetEmployeeId} onValueChange={setTargetEmployeeId}>
            <SelectTrigger data-testid="select-handover-target">
              <SelectValue placeholder="Mitarbeiter/in auswählen..." />
            </SelectTrigger>
            <SelectContent>
              {activeEmployees.map((emp) => (
                <SelectItem key={emp.id} value={String(emp.id)} data-testid={`select-handover-target-${emp.id}`}>
                  {emp.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {previewLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
          </div>
        )}

        {preview && (
          <div className="space-y-4">
            {totalAffected === 0 ? (
              <div className="text-center py-6 text-gray-500" data-testid="text-handover-empty">
                <Users className={`${iconSize.lg} mx-auto mb-2 text-gray-500`} />
                <p>Keine Kunden oder Termine zum Übergeben gefunden.</p>
              </div>
            ) : (
              <>
                {preview.summary.primaryCount > 0 && (
                  <div className="border rounded-lg p-3" data-testid="section-handover-primary">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                      <Users className={iconSize.sm} />
                      Hauptansprechpartner ({preview.summary.primaryCount})
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {preview.primaryCustomers.map((c) => (
                        <span key={c.id} className="text-xs bg-teal-50 text-teal-700 px-2 py-1 rounded" data-testid={`text-handover-primary-${c.id}`}>
                          {c.vorname} {c.nachname}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {preview.summary.backupCount > 0 && (
                  <div className="border rounded-lg p-3" data-testid="section-handover-backup">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                      <Users className={iconSize.sm} />
                      1. Vertretung ({preview.summary.backupCount})
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {preview.backupCustomers.map((c) => (
                        <span key={c.id} className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded" data-testid={`text-handover-backup-${c.id}`}>
                          {c.vorname} {c.nachname}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {preview.summary.backup2Count > 0 && (
                  <div className="border rounded-lg p-3" data-testid="section-handover-backup2">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                      <Users className={iconSize.sm} />
                      2. Vertretung ({preview.summary.backup2Count})
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {preview.backup2Customers.map((c) => (
                        <span key={c.id} className="text-xs bg-purple-50 text-purple-700 px-2 py-1 rounded" data-testid={`text-handover-backup2-${c.id}`}>
                          {c.vorname} {c.nachname}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {preview.summary.appointmentCount > 0 && (
                  <div className="border rounded-lg p-3" data-testid="section-handover-appointments">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                      <Calendar className={iconSize.sm} />
                      Zukünftige Termine ({preview.summary.appointmentCount})
                    </h3>
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {preview.futureAppointments.map((apt) => (
                        <div key={apt.id} className="text-xs text-gray-600 flex justify-between" data-testid={`text-handover-appointment-${apt.id}`}>
                          <span>{apt.customerVorname} {apt.customerNachname}</span>
                          <span className="text-gray-500">
                            {new Date(apt.date + "T00:00:00").toLocaleDateString("de-DE")} {apt.startTime}–{apt.endTime}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2" data-testid="warning-handover">
                  <AlertTriangle className={`${iconSize.sm} text-amber-600 mt-0.5 shrink-0`} />
                  <div className="text-sm text-amber-800">
                    <strong>{totalCustomers} Kundenzuordnung(en)</strong> und <strong>{preview.summary.appointmentCount} zukünftige Termin(e)</strong> werden
                    von <strong>{user.displayName}</strong> an <strong>{preview.targetEmployee.displayName}</strong> übertragen.
                    Diese Aktion kann nicht automatisch rückgängig gemacht werden.
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} data-testid="button-handover-cancel">
            Abbrechen
          </Button>
          <Button
            onClick={() => handoverMutation.mutate()}
            disabled={!targetEmployeeId || !preview || totalAffected === 0 || handoverMutation.isPending}
            className="bg-teal-600 hover:bg-teal-700"
            data-testid="button-handover-confirm"
          >
            {handoverMutation.isPending ? (
              <>
                <Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />
                Übergabe läuft...
              </>
            ) : (
              <>
                <ArrowRightLeft className={`mr-2 ${iconSize.sm}`} />
                Übergeben
              </>
            )}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

export default function AdminUsers() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const isSuperAdmin = currentUser?.isSuperAdmin ?? false;
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [resetPasswordUser, setResetPasswordUser] = useState<UserData | null>(null);
  const [anonymizingUser, setAnonymizingUser] = useState<UserData | null>(null);
  const [handoverUser, setHandoverUser] = useState<UserData | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("aktiv");
  const [roleFilter, setRoleFilter] = useState<string>("alle");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: users, isLoading } = useQuery<UserData[]>({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const result = await api.get<UserData[]>("/admin/users");
      return unwrapResult(result);
    },
  });

  const { data: editingUser, isLoading: isLoadingEditUser } = useQuery<UserData>({
    queryKey: ["admin", "users", editingUserId],
    queryFn: async () => {
      const result = await api.get<UserData>(`/admin/users/${editingUserId}`);
      return unwrapResult(result);
    },
    enabled: !!editingUserId,
  });

  const { data: workloadData } = useEmployeeWorkload();
  const { data: vacationData } = useAllVacationSummaries();

  const createMutation = useMutation({
    mutationFn: async (data: UserFormData & { password?: string }) => {
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
      queryClient.invalidateQueries({ queryKey: ["admin", "vacation-summaries"] });
      setEditingUserId(null);
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

  const resendWelcomeMutation = useMutation({
    mutationFn: async (id: number) => {
      const result = await api.post(`/admin/users/${id}/resend-welcome`, {});
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Willkommens-E-Mail wurde erneut gesendet" });
    },
    onError: (error: Error) => {
      toast({ title: "E-Mail konnte nicht gesendet werden", description: error.message, variant: "destructive" });
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

  const anonymizeMutation = useMutation({
    mutationFn: async (id: number) => {
      const result = await api.post(`/admin/users/${id}/anonymize`, {});
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      setAnonymizingUser(null);
      toast({ title: "Mitarbeiter anonymisiert", description: "Persönliche Daten wurden DSGVO-konform entfernt." });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const filteredUsers = useMemo(() => {
    if (!users) return [];
    return users.filter((user) => {
      if (statusFilter === "aktiv" && !user.isActive) return false;
      if (statusFilter === "inaktiv" && user.isActive) return false;
      if (roleFilter !== "alle" && !user.roles.includes(roleFilter)) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const nameMatch = user.displayName.toLowerCase().includes(q);
        const emailMatch = user.email.toLowerCase().includes(q);
        if (!nameMatch && !emailMatch) return false;
      }
      return true;
    });
  }, [users, statusFilter, roleFilter, searchQuery]);

  const handleCreateSubmit = (data: UserFormData & { password?: string }) => {
    createMutation.mutate(data as UserFormData & { password: string });
  };

  const handleEditSubmit = (data: UserFormData) => {
    if (!editingUserId) return;
    updateMutation.mutate({ id: editingUserId, ...data });
  };

  return (
    <Layout variant="admin">
          <div className="flex items-center justify-between gap-2 mb-6">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              <Link href="/admin">
                <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back" className="shrink-0">
                  <ArrowLeft className={iconSize.md} />
                </Button>
              </Link>
              <h1 className={componentStyles.pageTitle}>Benutzerverwaltung</h1>
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

          <div className="space-y-3 mb-4">
            <div className="relative">
              <Search className={`absolute left-3 top-1/2 -translate-y-1/2 ${iconSize.sm} text-gray-500`} />
              <Input
                placeholder="Name oder E-Mail suchen..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-white"
                data-testid="input-search-users"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              <div className="flex rounded-lg border border-gray-200 bg-white overflow-hidden">
                {(["aktiv", "inaktiv", "alle"] as StatusFilter[]).map((status) => (
                  <button
                    key={status}
                    onClick={() => setStatusFilter(status)}
                    className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                      statusFilter === status
                        ? "bg-teal-600 text-white"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                    data-testid={`filter-status-${status}`}
                  >
                    {status === "aktiv" ? "Aktiv" : status === "inaktiv" ? "Inaktiv" : "Alle"}
                  </button>
                ))}
              </div>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-white text-gray-700"
                data-testid="filter-role"
              >
                <option value="alle">Alle Bereiche</option>
                {AVAILABLE_ROLES.map((role) => (
                  <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                ))}
              </select>
            </div>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              Keine Mitarbeiter gefunden
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredUsers.map((user) => (
                <Card
                  key={user.id}
                  data-testid={`card-user-${user.id}`}
                  className={user.isAnonymized ? "opacity-60" : !user.isActive ? "opacity-80" : ""}
                >
                  <CardContent className="p-0">
                    <div className="flex">
                      <div className="flex-1 p-4">
                        <div className="flex items-center gap-3 mb-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`font-semibold ${user.isAnonymized ? "text-gray-500 italic" : "text-gray-900"}`}>
                                {user.displayName}
                              </span>
                              {!user.isAnonymized && (
                                <>
                                  <span className="text-gray-500">·</span>
                                  <span className="text-sm text-gray-500">
                                    {user.telefon ? <a href={`tel:${user.telefon}`} className="text-primary hover:underline">{formatPhoneForDisplay(user.telefon)}</a> : '–'}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {user.isAnonymized && (
                              <span className="text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-600">
                                Anonymisiert
                              </span>
                            )}
                            {!user.isActive && !user.isAnonymized && (
                              <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-600">
                                Inaktiv
                              </span>
                            )}
                            <span className={`text-xs px-2 py-0.5 rounded ${user.isAdmin ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-600'}`}>
                              {user.isAdmin ? 'Admin' : 'Mitarbeiter'}
                            </span>
                            {user.isTeamLead && !user.isAdmin && (
                              <span
                                className="text-xs px-2 py-0.5 rounded bg-indigo-100 text-indigo-700"
                                data-testid={`badge-team-lead-${user.id}`}
                              >
                                Teamleiter
                              </span>
                            )}
                          </div>
                        </div>
                        {!user.isAnonymized && (
                          <div>
                            <div className="text-xs text-gray-500 mb-1">Tätigkeitsbereiche</div>
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                              {user.roles.map((role) => (
                                <span key={role} className="text-sm text-gray-700">
                                  {ROLE_LABELS[role] || role}
                                </span>
                              ))}
                              {user.roles.length === 0 && (
                                <span className="text-sm text-gray-500 italic">Keine zugewiesen</span>
                              )}
                            </div>
                            {workloadData && workloadData[user.id] && (() => {
                              const wl = workloadData[user.id];
                              const totalCustomers = wl.primaryCount + wl.backupCount + wl.backup2Count;
                              const hwHours = Math.round(wl.avgMonthlyHwMinutes / 60 * 10) / 10;
                              const allHours = Math.round(wl.avgMonthlyAllMinutes / 60 * 10) / 10;
                              const monthsConsidered = Math.round(wl.monthsConsidered * 10) / 10;
                              const monthsLabel = `Ø über ${monthsConsidered.toLocaleString("de-DE", { maximumFractionDigits: 1 })} von 3 Monaten`;
                              return (
                                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600" data-testid={`workload-stats-${user.id}`}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex items-center gap-1 cursor-help" data-testid={`workload-customers-trigger-${user.id}`}>
                                        <Users className="h-3 w-3" />
                                        <span className="font-medium" data-testid={`workload-total-${user.id}`}>{totalCustomers} Kunden</span>
                                        <span className="text-gray-500">
                                          (<span className="text-teal-700" data-testid={`workload-hv-${user.id}`}>{wl.primaryCount} HV</span>
                                          {" · "}
                                          <span className="text-blue-600" data-testid={`workload-v1-${user.id}`}>{wl.backupCount} V1</span>
                                          {" · "}
                                          <span className="text-purple-600" data-testid={`workload-v2-${user.id}`}>{wl.backup2Count} V2</span>)
                                        </span>
                                        <Info className="h-3 w-3 text-gray-400 ml-0.5" />
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs">
                                      <div className="space-y-0.5">
                                        <div><strong>HV</strong> = Hauptverantwortliche</div>
                                        <div><strong>V1</strong> = Vertretung 1</div>
                                        <div><strong>V2</strong> = Vertretung 2</div>
                                      </div>
                                    </TooltipContent>
                                  </Tooltip>
                                  <span className="text-gray-300">|</span>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex items-center gap-1 cursor-help" data-testid={`workload-hours-trigger-${user.id}`}>
                                        <Calendar className="h-3 w-3" />
                                        <span>Ø</span>
                                        <span className="font-medium" data-testid={`workload-hw-hours-${user.id}`}>{hwHours}h</span>
                                        <span className="text-gray-500">HW</span>
                                        <span className="text-gray-500">·</span>
                                        <span className="font-medium" data-testid={`workload-all-hours-${user.id}`}>{allHours}h</span>
                                        <span className="text-gray-500">ALL</span>
                                        <span className="text-gray-400" data-testid={`workload-months-${user.id}`}>({monthsLabel})</span>
                                        <Info className="h-3 w-3 text-gray-400 ml-0.5" />
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs">
                                      <div className="space-y-0.5">
                                        <div><strong>HW</strong> = Hauswirtschaft</div>
                                        <div><strong>ALL</strong> = Alltagsbegleitung</div>
                                        <div className="text-[10px] opacity-80 mt-1">
                                          Ø der letzten 3 abgeschlossenen Monate, normalisiert auf
                                          tatsächlich verfügbare Arbeitstage. Tage mit Urlaub oder
                                          Krankheit sowie Tage vor dem Eintrittsdatum werden
                                          herausgerechnet, damit Abwesenheiten die Auslastung nicht
                                          künstlich senken.
                                        </div>
                                      </div>
                                    </TooltipContent>
                                  </Tooltip>
                                </div>
                              );
                            })()}
                            {vacationData && vacationData[user.id] && (() => {
                              const vac = vacationData[user.id];
                              const totalAvailable = vac.totalDays + vac.carryOverDays;
                              return (
                                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600" data-testid={`vacation-stats-${user.id}`}>
                                  <span className="inline-flex items-center gap-1 cursor-default">
                                    <Palmtree className="h-3 w-3" />
                                    <span className={`font-medium ${vac.remainingDays <= 0 ? 'text-red-600' : vac.remainingDays <= 3 ? 'text-amber-600' : 'text-teal-700'}`} data-testid={`vacation-remaining-${user.id}`}>
                                      {formatVacationDays(vac.remainingDays)} Tage übrig
                                    </span>
                                    <span className="text-gray-500">
                                      (von {formatVacationDays(totalAvailable)}{vac.carryOverDays > 0 ? ` inkl. ${formatVacationDays(vac.carryOverDays)} Übertrag` : ''})
                                    </span>
                                  </span>
                                  <span className="text-gray-300">|</span>
                                  <span className="text-gray-500" data-testid={`vacation-used-${user.id}`}>
                                    {vac.usedDays} genommen{vac.plannedDays > 0 ? ` · ${vac.plannedDays} geplant` : ''}
                                  </span>
                                  {vac.sickDays > 0 && (
                                    <>
                                      <span className="text-gray-300">|</span>
                                      <span className="text-red-500" data-testid={`vacation-sick-${user.id}`}>
                                        {vac.sickDays} krank
                                      </span>
                                    </>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                      
                      {!user.isAnonymized && (
                        <div className="flex flex-col justify-center gap-1 px-3 bg-gray-50 border-l border-gray-100">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => setEditingUserId(user.id)}
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
                            title="Passwort zurücksetzen"
                          >
                            <Key className={`${iconSize.sm} text-gray-600`} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => resendWelcomeMutation.mutate(user.id)}
                            disabled={resendWelcomeMutation.isPending}
                            data-testid={`button-resend-welcome-${user.id}`}
                            title="Willkommens-E-Mail erneut senden"
                          >
                            <Mail className={`${iconSize.sm} text-gray-600`} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => setHandoverUser(user)}
                            data-testid={`button-handover-${user.id}`}
                            title="Kunden & Termine übergeben"
                          >
                            <ArrowRightLeft className={`${iconSize.sm} text-teal-600`} />
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
                          {!user.isActive && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              onClick={() => setAnonymizingUser(user)}
                              data-testid={`button-anonymize-user-${user.id}`}
                              title="DSGVO-Anonymisierung"
                            >
                              <ShieldOff className={`${iconSize.sm} text-purple-500`} />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

      <Dialog open={!!editingUserId} onOpenChange={() => setEditingUserId(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
          {editingUserId && editingUser && !isLoadingEditUser && (
            <>
              <UserForm
                mode="edit"
                user={editingUser}
                onSubmit={handleEditSubmit}
                isLoading={updateMutation.isPending}
                allUsers={users ?? []}
              />
              {isSuperAdmin && editingUser.isAdmin && (
                <AdminPermissionsSection userId={editingUser.id} />
              )}
              <EmployeeServiceRates />
              <EmployeeDocumentRequirementsSection employeeId={editingUser.id} />
              <EmployeeDocumentsSection employeeId={editingUser.id} userName={editingUser.displayName} isAdmin={true} />
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

      <Dialog open={!!handoverUser} onOpenChange={() => setHandoverUser(null)}>
        {handoverUser && users && (
          <HandoverDialog
            user={handoverUser}
            allUsers={users}
            onClose={() => setHandoverUser(null)}
          />
        )}
      </Dialog>

      <AlertDialog open={!!anonymizingUser} onOpenChange={() => setAnonymizingUser(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mitarbeiter anonymisieren?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                Möchten Sie die persönlichen Daten von <strong>{anonymizingUser?.displayName}</strong> unwiderruflich anonymisieren?
              </p>
              <p>
                Dies entfernt Name, Telefon, Adresse, E-Mail und Notfallkontakt. Historische Leistungsnachweise mit Unterschriften bleiben erhalten.
              </p>
              <p className="font-semibold text-red-600">
                Diese Aktion kann nicht rückgängig gemacht werden.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => anonymizingUser && anonymizeMutation.mutate(anonymizingUser.id)}
              className="bg-purple-600 hover:bg-purple-700"
              disabled={anonymizeMutation.isPending}
            >
              {anonymizeMutation.isPending ? "Anonymisiere..." : "Unwiderruflich anonymisieren"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
