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
  MoreHorizontal,
  ArrowDownUp,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
type WorkloadFilter = "alle" | "ueberlastet" | "kapazitaet";
type SortBy = "name" | "auslastung-desc" | "auslastung-asc";

interface WorkloadMetrics {
  totalCustomers: number;
  istHours: number;
  sollHours: number | null;
  hasSoll: boolean;
  hasIstBasis: boolean;
  auslastungPct: number | null;
  freieStunden: number | null;
  freieKunden: number | null;
  isOverloaded: boolean;
  hasFreeCapacity: boolean;
}

function computeWorkloadMetrics(
  wl: { primaryCount: number; backupCount: number; backup2Count: number; avgMonthlyHwMinutes: number; avgMonthlyAllMinutes: number; monthsConsidered: number; monthlyWorkHours: number | null } | undefined,
  globalAvg: number,
): WorkloadMetrics | null {
  if (!wl) return null;
  const totalCustomers = wl.primaryCount + wl.backupCount + wl.backup2Count;
  const hwHours = wl.avgMonthlyHwMinutes / 60;
  const allHours = wl.avgMonthlyAllMinutes / 60;
  const istHours = Math.round((hwHours + allHours) * 10) / 10;
  const sollHours = wl.monthlyWorkHours;
  const hasSoll = sollHours !== null && sollHours > 0;
  const hasIstBasis = hasSoll && wl.monthsConsidered > 0;
  const auslastungPct = hasIstBasis ? Math.round((istHours / sollHours!) * 100) : null;
  const freieStunden = hasSoll
    ? hasIstBasis
      ? Math.max(0, sollHours! - istHours)
      : sollHours!
    : null;
  const freieKunden =
    hasIstBasis && globalAvg > 0 ? Math.floor(freieStunden! / globalAvg) : null;
  return {
    totalCustomers,
    istHours,
    sollHours,
    hasSoll,
    hasIstBasis,
    auslastungPct,
    freieStunden,
    freieKunden,
    isOverloaded: auslastungPct !== null && auslastungPct > 100,
    hasFreeCapacity: auslastungPct !== null && auslastungPct < 85,
  };
}

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
  const [workloadFilter, setWorkloadFilter] = useState<WorkloadFilter>("alle");
  const [sortBy, setSortBy] = useState<SortBy>("name");
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

  const globalAvg = workloadData?.globalAvgHoursPerCustomerPerMonth ?? 0;

  const userMetrics = useMemo(() => {
    const map = new Map<number, WorkloadMetrics | null>();
    if (!users || !workloadData) return map;
    for (const u of users) {
      map.set(u.id, computeWorkloadMetrics(workloadData.workload[u.id], globalAvg));
    }
    return map;
  }, [users, workloadData, globalAvg]);

  const counts = useMemo(() => {
    if (!users) return { alle: 0, ueberlastet: 0, kapazitaet: 0 };
    let ueberlastet = 0;
    let kapazitaet = 0;
    for (const u of users) {
      if (!u.isActive || u.isAnonymized) continue;
      const m = userMetrics.get(u.id);
      if (m?.isOverloaded) ueberlastet++;
      if (m?.hasFreeCapacity) kapazitaet++;
    }
    return {
      alle: users.filter((u) => u.isActive && !u.isAnonymized).length,
      ueberlastet,
      kapazitaet,
    };
  }, [users, userMetrics]);

  const filteredUsers = useMemo(() => {
    if (!users) return [];
    const filtered = users.filter((user) => {
      if (statusFilter === "aktiv" && !user.isActive) return false;
      if (statusFilter === "inaktiv" && user.isActive) return false;
      if (roleFilter !== "alle" && !user.roles.includes(roleFilter)) return false;
      if (workloadFilter !== "alle") {
        if (user.isAnonymized || !user.isActive) return false;
        const m = userMetrics.get(user.id);
        if (workloadFilter === "ueberlastet" && !m?.isOverloaded) return false;
        if (workloadFilter === "kapazitaet" && !m?.hasFreeCapacity) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const nameMatch = user.displayName.toLowerCase().includes(q);
        const emailMatch = user.email.toLowerCase().includes(q);
        if (!nameMatch && !emailMatch) return false;
      }
      return true;
    });

    const sorted = [...filtered];
    if (sortBy === "name") {
      sorted.sort((a, b) => a.displayName.localeCompare(b.displayName, "de"));
    } else {
      const dir = sortBy === "auslastung-desc" ? -1 : 1;
      sorted.sort((a, b) => {
        const av = userMetrics.get(a.id)?.auslastungPct;
        const bv = userMetrics.get(b.id)?.auslastungPct;
        if (av == null && bv == null) return a.displayName.localeCompare(b.displayName, "de");
        if (av == null) return 1;
        if (bv == null) return -1;
        return (av - bv) * dir;
      });
    }
    return sorted;
  }, [users, statusFilter, roleFilter, workloadFilter, searchQuery, sortBy, userMetrics]);

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
              {([
                { key: "alle" as WorkloadFilter, label: "Alle", count: counts.alle, icon: null, activeClass: "bg-gray-900 text-white", countClass: "bg-gray-700 text-white" },
                { key: "ueberlastet" as WorkloadFilter, label: "Überlastet", count: counts.ueberlastet, icon: <AlertTriangle className="h-3.5 w-3.5" />, activeClass: "bg-red-50 text-red-700 border-red-200", countClass: "bg-red-100 text-red-700" },
                { key: "kapazitaet" as WorkloadFilter, label: "Kapazität frei", count: counts.kapazitaet, icon: null, activeClass: "bg-emerald-50 text-emerald-700 border-emerald-200", countClass: "bg-emerald-100 text-emerald-700" },
              ]).map((p) => {
                const active = workloadFilter === p.key;
                return (
                  <button
                    key={p.key}
                    onClick={() => setWorkloadFilter(p.key)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                      active ? p.activeClass : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
                    }`}
                    data-testid={`pill-workload-${p.key}`}
                  >
                    {p.icon}
                    <span>{p.label}</span>
                    <span className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-semibold ${
                      active ? p.countClass : "bg-gray-100 text-gray-700"
                    }`}>
                      {p.count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex gap-2 flex-wrap items-center justify-between">
              <div className="flex gap-2 flex-wrap">
                <div className="flex rounded-full border border-gray-200 bg-white overflow-hidden text-sm">
                  {(["aktiv", "inaktiv", "alle"] as StatusFilter[]).map((status) => (
                    <button
                      key={status}
                      onClick={() => setStatusFilter(status)}
                      className={`px-3 py-1.5 font-medium transition-colors ${
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
                <Select value={roleFilter} onValueChange={setRoleFilter}>
                  <SelectTrigger className="h-9 rounded-full bg-white text-sm w-auto gap-1" data-testid="filter-role">
                    <SelectValue placeholder="Alle Bereiche" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="alle">Alle Bereiche</SelectItem>
                    {AVAILABLE_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
                <SelectTrigger className="h-9 rounded-full bg-white text-sm w-auto gap-1" data-testid="filter-sort">
                  <ArrowDownUp className="h-3.5 w-3.5" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name">Name (A–Z)</SelectItem>
                  <SelectItem value="auslastung-desc">Auslastung (hoch → niedrig)</SelectItem>
                  <SelectItem value="auslastung-asc">Auslastung (niedrig → hoch)</SelectItem>
                </SelectContent>
              </Select>
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
              {filteredUsers.map((user) => {
                const m = userMetrics.get(user.id);
                const roleTag = user.isAdmin
                  ? { label: "ADMIN", cls: "text-teal-700" }
                  : user.isTeamLead
                  ? { label: "TEAMLEITUNG", cls: "text-indigo-700" }
                  : { label: "MITARBEITER", cls: "text-gray-500" };
                const visibleRoles = user.roles.slice(0, 2);
                const moreRoles = user.roles.length - visibleRoles.length;
                const barWidth = m?.auslastungPct != null ? Math.min(m.auslastungPct, 150) / 1.5 : 0;
                const barColor =
                  m?.auslastungPct == null
                    ? "bg-gray-300"
                    : m.auslastungPct > 100
                    ? "bg-red-500"
                    : m.auslastungPct >= 85
                    ? "bg-amber-500"
                    : "bg-emerald-500";
                const pctColor =
                  m?.auslastungPct == null
                    ? "text-gray-400"
                    : m.auslastungPct > 100
                    ? "text-red-600"
                    : m.auslastungPct >= 85
                    ? "text-amber-600"
                    : "text-emerald-600";

                return (
                  <Card
                    key={user.id}
                    data-testid={`card-user-${user.id}`}
                    className={`rounded-2xl border-gray-200 ${user.isAnonymized ? "opacity-60" : !user.isActive ? "opacity-80" : ""}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="min-w-0 flex-1">
                          <div className={`text-base font-bold leading-tight ${user.isAnonymized ? "text-gray-500 italic" : "text-gray-900"}`}>
                            {user.displayName}
                          </div>
                          {!user.isAnonymized && (
                            <div className="mt-0.5 flex items-center gap-2 text-xs">
                              <span className={`font-semibold tracking-wide ${roleTag.cls}`}>{roleTag.label}</span>
                              <span className="text-gray-400">·</span>
                              {user.telefon ? (
                                <a href={`tel:${user.telefon}`} className="text-gray-600 hover:text-primary">
                                  {formatPhoneForDisplay(user.telefon)}
                                </a>
                              ) : (
                                <span className="text-gray-400">–</span>
                              )}
                              {!user.isActive && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 font-semibold uppercase tracking-wide">
                                  Inaktiv
                                </span>
                              )}
                            </div>
                          )}
                          {user.isAnonymized && (
                            <div className="mt-0.5 text-xs">
                              <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-600 text-[10px] font-semibold uppercase tracking-wide">
                                Anonymisiert
                              </span>
                            </div>
                          )}
                        </div>

                        {!user.isAnonymized && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 rounded-full border border-gray-200 text-gray-500 shrink-0"
                                data-testid={`button-actions-${user.id}`}
                                aria-label="Aktionen"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              <DropdownMenuLabel>Aktionen</DropdownMenuLabel>
                              <DropdownMenuItem
                                onClick={() => setEditingUserId(user.id)}
                                data-testid={`button-edit-user-${user.id}`}
                              >
                                <Pencil className="h-4 w-4 mr-2 text-gray-600" />
                                Bearbeiten
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setResetPasswordUser(user)}
                                data-testid={`button-reset-password-${user.id}`}
                              >
                                <Key className="h-4 w-4 mr-2 text-gray-600" />
                                Passwort zurücksetzen
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => resendWelcomeMutation.mutate(user.id)}
                                disabled={resendWelcomeMutation.isPending}
                                data-testid={`button-resend-welcome-${user.id}`}
                              >
                                <Mail className="h-4 w-4 mr-2 text-gray-600" />
                                Willkommens-E-Mail senden
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setHandoverUser(user)}
                                data-testid={`button-handover-${user.id}`}
                              >
                                <ArrowRightLeft className="h-4 w-4 mr-2 text-teal-600" />
                                Kunden &amp; Termine übergeben
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() =>
                                  toggleActiveMutation.mutate({ id: user.id, activate: !user.isActive })
                                }
                                data-testid={`button-toggle-active-${user.id}`}
                              >
                                {user.isActive ? (
                                  <>
                                    <UserX className="h-4 w-4 mr-2 text-red-500" />
                                    Deaktivieren
                                  </>
                                ) : (
                                  <>
                                    <UserCheck className="h-4 w-4 mr-2 text-green-500" />
                                    Aktivieren
                                  </>
                                )}
                              </DropdownMenuItem>
                              {!user.isActive && (
                                <DropdownMenuItem
                                  onClick={() => setAnonymizingUser(user)}
                                  data-testid={`button-anonymize-user-${user.id}`}
                                  className="text-purple-600 focus:text-purple-700"
                                >
                                  <ShieldOff className="h-4 w-4 mr-2" />
                                  DSGVO-Anonymisierung
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>

                      {!user.isAnonymized && m && m.hasSoll && (
                        <div className="mt-3" data-testid={`workload-stats-${user.id}`}>
                          <div className="relative h-2 rounded-full bg-gray-100 overflow-hidden">
                            <div
                              className={`h-full ${barColor} transition-all`}
                              style={{ width: `${barWidth}%` }}
                              data-testid={`workload-bar-${user.id}`}
                            />
                            <div
                              className="absolute top-0 bottom-0 w-px bg-gray-300"
                              style={{ left: `${100 / 1.5}%` }}
                            />
                          </div>
                          <div className="mt-1.5 flex items-center justify-between text-sm">
                            <div className="flex items-center gap-1.5 text-gray-700 flex-wrap">
                              <span className="font-semibold" data-testid={`workload-total-${user.id}`}>
                                {m.totalCustomers} Kunden
                              </span>
                              <span className="text-gray-400">·</span>
                              <span className="text-gray-500">Soll</span>
                              <span className="font-semibold" data-testid={`workload-soll-${user.id}`}>
                                {m.sollHours}h
                              </span>
                              {m.hasIstBasis && m.auslastungPct !== null && m.auslastungPct > 100 && (
                                <>
                                  <span className="text-gray-400">·</span>
                                  <span className="text-red-600 font-semibold" data-testid={`workload-over-${user.id}`}>
                                    +{(m.istHours - m.sollHours!).toLocaleString("de-DE", { maximumFractionDigits: 1 })} h über
                                  </span>
                                </>
                              )}
                              {m.freieKunden !== null && m.freieKunden > 0 && (
                                <>
                                  <span className="text-gray-400">·</span>
                                  <span className="text-emerald-600 font-semibold" data-testid={`workload-zusatzkunden-${user.id}`}>
                                    +{m.freieKunden} mögliche Kunden
                                  </span>
                                </>
                              )}
                            </div>
                            <span
                              className={`font-bold ${pctColor}`}
                              data-testid={`workload-auslastung-${user.id}`}
                            >
                              {m.auslastungPct !== null ? `${m.auslastungPct}%` : "—"}
                            </span>
                          </div>
                        </div>
                      )}

                      {!user.isAnonymized && !user.isAdmin && workloadData && m && !m.hasSoll && (
                        <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-amber-700" data-testid={`workload-soll-missing-${user.id}`}>
                          <Info className="h-3.5 w-3.5" />
                          <span>Vertragsstunden fehlen</span>
                        </div>
                      )}

                      {!user.isAnonymized && user.roles.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {visibleRoles.map((role) => (
                            <span
                              key={role}
                              className="inline-flex items-center px-2.5 py-1 rounded-md bg-gray-100 text-gray-700 text-xs font-medium"
                            >
                              {ROLE_LABELS[role] || role}
                            </span>
                          ))}
                          {moreRoles > 0 && (
                            <span
                              className="inline-flex items-center px-2.5 py-1 rounded-md border border-dashed border-gray-300 text-gray-500 text-xs"
                              title={user.roles.slice(2).map((r) => ROLE_LABELS[r] || r).join(", ")}
                            >
                              +{moreRoles} mehr
                            </span>
                          )}
                        </div>
                      )}

                      {!user.isAnonymized && vacationData && vacationData[user.id] && (() => {
                        const vac = vacationData[user.id];
                        return (
                          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-500" data-testid={`vacation-stats-${user.id}`}>
                            <Palmtree className="h-3 w-3" />
                            <span className={`font-medium ${vac.remainingDays <= 0 ? 'text-red-600' : vac.remainingDays <= 3 ? 'text-amber-600' : 'text-emerald-700'}`} data-testid={`vacation-remaining-${user.id}`}>
                              {formatVacationDays(vac.remainingDays)} Tage übrig
                            </span>
                            <span>· {vac.usedDays} genommen{vac.plannedDays > 0 ? ` · ${vac.plannedDays} geplant` : ''}{vac.sickDays > 0 ? ` · ${vac.sickDays} krank` : ''}</span>
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>
                );
              })}
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
