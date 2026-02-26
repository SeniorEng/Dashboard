import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { iconSize, componentStyles } from "@/design-system";
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
} from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import {
  UserData,
  UserFormData,
  ROLE_LABELS,
  AVAILABLE_ROLES,
  formatPhoneForDisplay,
} from "./components/user-types";
import { UserForm } from "./components/user-form";
import { EmployeeDocumentsSection } from "./components/employee-documents-section";
import { EmployeeServiceRates } from "./components/employee-service-rates";
import { EmployeeQualificationsSection } from "./components/employee-qualifications-section";
import { ResetPasswordForm } from "./components/reset-password-form";

type StatusFilter = "aktiv" | "inaktiv" | "alle";

export default function AdminUsers() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserData | null>(null);
  const [resetPasswordUser, setResetPasswordUser] = useState<UserData | null>(null);
  const [anonymizingUser, setAnonymizingUser] = useState<UserData | null>(null);

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
    if (!editingUser) return;
    updateMutation.mutate({ id: editingUser.id, ...data });
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
              <Search className={`absolute left-3 top-1/2 -translate-y-1/2 ${iconSize.sm} text-gray-400`} />
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
                              <span className={`font-semibold ${user.isAnonymized ? "text-gray-400 italic" : "text-gray-900"}`}>
                                {user.displayName}
                              </span>
                              {!user.isAnonymized && (
                                <>
                                  <span className="text-gray-400">·</span>
                                  <span className="text-sm text-gray-500">
                                    {user.telefon ? formatPhoneForDisplay(user.telefon) : '–'}
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
                            {user.lbnr && (
                              <div className="mt-1 text-xs text-gray-500" data-testid={`text-lbnr-${user.id}`}>
                                LBNR: {user.lbnr}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      
                      {!user.isAnonymized && (
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
              <EmployeeServiceRates />
              <EmployeeQualificationsSection employeeId={editingUser.id} />
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
