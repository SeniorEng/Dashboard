import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";
import { Loader2, Save, Shield } from "lucide-react";
import { ADMIN_PERMISSION_KEYS, ADMIN_PERMISSION_LABELS } from "@shared/schema";

export function AdminPermissionsSection({ userId }: { userId: number }) {
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

  useEffect(() => {
    if (permissionsData && !hasLoaded) {
      setSelectedPermissions(permissionsData.permissions);
      setHasLoaded(true);
    }
  }, [permissionsData, hasLoaded]);

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
