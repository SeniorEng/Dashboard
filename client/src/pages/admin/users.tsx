import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { iconSize } from "@/design-system";
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
} from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import {
  UserData,
  UserFormData,
  ROLE_LABELS,
  formatPhoneForDisplay,
} from "./components/user-types";
import { UserForm } from "./components/user-form";
import { EmployeeDocumentsSection } from "./components/employee-documents-section";
import { EmployeeServiceRates } from "./components/employee-service-rates";
import { ResetPasswordForm } from "./components/reset-password-form";

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
                                {user.telefon ? formatPhoneForDisplay(user.telefon) : '–'}
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
              <EmployeeServiceRates />
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
    </Layout>
  );
}
