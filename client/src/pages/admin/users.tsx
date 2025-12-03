import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
} from "lucide-react";

interface UserData {
  id: number;
  email: string;
  displayName: string;
  isActive: boolean;
  isAdmin: boolean;
  roles: string[];
  createdAt: string;
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
    mutationFn: async (data: {
      email: string;
      password: string;
      displayName: string;
      isAdmin: boolean;
      roles: string[];
    }) => {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Benutzer konnte nicht erstellt werden");
      }
      return res.json();
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
    mutationFn: async ({
      id,
      ...data
    }: {
      id: number;
      displayName?: string;
      email?: string;
      isAdmin?: boolean;
      roles?: string[];
    }) => {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Benutzer konnte nicht aktualisiert werden");
      }
      return res.json();
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
      const res = await fetch(`/api/admin/users/${id}/${endpoint}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Status konnte nicht geändert werden");
      }
      return res.json();
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
      const res = await fetch(`/api/admin/users/${id}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Passwort konnte nicht zurückgesetzt werden");
      }
      return res.json();
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
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Benutzer konnte nicht gelöscht werden");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      toast({ title: "Benutzer gelöscht" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <Link href="/admin">
                <Button variant="ghost" size="icon" data-testid="button-back">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <h1 className="text-2xl font-bold text-gray-900">Benutzerverwaltung</h1>
            </div>
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button className="bg-teal-600 hover:bg-teal-700" data-testid="button-create-user">
                  <Plus className="h-4 w-4 mr-2" />
                  Neuer Benutzer
                </Button>
              </DialogTrigger>
              <DialogContent>
                <CreateUserForm
                  onSubmit={(data) => createMutation.mutate(data)}
                  isLoading={createMutation.isPending}
                />
              </DialogContent>
            </Dialog>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
            </div>
          ) : (
            <div className="space-y-4">
              {users?.map((user) => (
                <Card key={user.id} data-testid={`card-user-${user.id}`}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-4">
                      <div
                        className={`p-2 rounded-full ${
                          user.isActive ? "bg-teal-100" : "bg-gray-100"
                        }`}
                      >
                        {user.isAdmin ? (
                          <Shield
                            className={`h-5 w-5 ${
                              user.isActive ? "text-teal-600" : "text-gray-400"
                            }`}
                          />
                        ) : (
                          <User
                            className={`h-5 w-5 ${
                              user.isActive ? "text-teal-600" : "text-gray-400"
                            }`}
                          />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-gray-900">
                            {user.displayName}
                          </p>
                          {user.isAdmin && (
                            <Badge variant="secondary">Admin</Badge>
                          )}
                          {!user.isActive && (
                            <Badge variant="outline" className="text-red-600">
                              Deaktiviert
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-gray-500">{user.email}</p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {user.roles.map((role) => (
                            <Badge key={role} variant="outline" className="text-xs">
                              {ROLE_LABELS[role] || role}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditingUser(user)}
                        data-testid={`button-edit-user-${user.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setResetPasswordUser(user)}
                        data-testid={`button-reset-password-${user.id}`}
                      >
                        <Key className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          toggleActiveMutation.mutate({
                            id: user.id,
                            activate: !user.isActive,
                          })
                        }
                        data-testid={`button-toggle-active-${user.id}`}
                      >
                        {user.isActive ? (
                          <UserX className="h-4 w-4 text-red-600" />
                        ) : (
                          <UserCheck className="h-4 w-4 text-green-600" />
                        )}
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            data-testid={`button-delete-user-${user.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-red-600" />
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
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!editingUser} onOpenChange={() => setEditingUser(null)}>
        <DialogContent>
          {editingUser && (
            <EditUserForm
              user={editingUser}
              onSubmit={(data) => updateMutation.mutate({ id: editingUser.id, ...data })}
              isLoading={updateMutation.isPending}
            />
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

function CreateUserForm({
  onSubmit,
  isLoading,
}: {
  onSubmit: (data: {
    email: string;
    password: string;
    displayName: string;
    isAdmin: boolean;
    roles: string[];
  }) => void;
  isLoading: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ email, password, displayName, isAdmin, roles });
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Neuen Benutzer erstellen</DialogTitle>
        <DialogDescription>
          Erstellen Sie ein neues Benutzerkonto für einen Mitarbeiter.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-4">
        <div className="space-y-2">
          <Label htmlFor="displayName">Name</Label>
          <Input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            data-testid="input-new-user-name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">E-Mail</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            data-testid="input-new-user-email"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Passwort</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            data-testid="input-new-user-password"
          />
        </div>
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
          <Label>Berechtigungen</Label>
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
      <DialogFooter>
        <Button type="submit" disabled={isLoading} data-testid="button-submit-create-user">
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Erstellen...
            </>
          ) : (
            "Erstellen"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditUserForm({
  user,
  onSubmit,
  isLoading,
}: {
  user: UserData;
  onSubmit: (data: {
    displayName?: string;
    email?: string;
    isAdmin?: boolean;
    roles?: string[];
  }) => void;
  isLoading: boolean;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [roles, setRoles] = useState<string[]>(user.roles);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ displayName, email, isAdmin, roles });
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Benutzer bearbeiten</DialogTitle>
        <DialogDescription>
          Bearbeiten Sie die Daten von {user.displayName}.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-4">
        <div className="space-y-2">
          <Label htmlFor="edit-displayName">Name</Label>
          <Input
            id="edit-displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            data-testid="input-edit-user-name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-email">E-Mail</Label>
          <Input
            id="edit-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            data-testid="input-edit-user-email"
          />
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox
            id="edit-isAdmin"
            checked={isAdmin}
            onCheckedChange={(checked) => setIsAdmin(!!checked)}
            data-testid="checkbox-edit-is-admin"
          />
          <Label htmlFor="edit-isAdmin">Administrator-Rechte</Label>
        </div>
        <div className="space-y-2">
          <Label>Berechtigungen</Label>
          <div className="grid grid-cols-2 gap-2">
            {AVAILABLE_ROLES.map((role) => (
              <div key={role} className="flex items-center space-x-2">
                <Checkbox
                  id={`edit-role-${role}`}
                  checked={roles.includes(role)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setRoles([...roles, role]);
                    } else {
                      setRoles(roles.filter((r) => r !== role));
                    }
                  }}
                  data-testid={`checkbox-edit-role-${role}`}
                />
                <Label htmlFor={`edit-role-${role}`}>{ROLE_LABELS[role]}</Label>
              </div>
            ))}
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button type="submit" disabled={isLoading} data-testid="button-submit-edit-user">
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Speichern...
            </>
          ) : (
            "Speichern"
          )}
        </Button>
      </DialogFooter>
    </form>
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
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
