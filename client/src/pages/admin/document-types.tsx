import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Plus,
  Loader2,
  Pencil,
  FileCheck2,
  CalendarClock,
  Bell,
  Users,
  User,
} from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";

interface DocumentTypeData {
  id: number;
  name: string;
  description: string | null;
  targetType: string;
  reviewIntervalMonths: number | null;
  reminderLeadTimeDays: number | null;
  isActive: boolean;
}

interface DocTypeFormData {
  name: string;
  description: string;
  targetType: string;
  reviewIntervalMonths: string;
  reminderLeadTimeDays: string;
  isActive: boolean;
}

const emptyForm: DocTypeFormData = {
  name: "",
  description: "",
  targetType: "employee",
  reviewIntervalMonths: "",
  reminderLeadTimeDays: "14",
  isActive: true,
};

function toFormData(dt: DocumentTypeData): DocTypeFormData {
  return {
    name: dt.name,
    description: dt.description || "",
    targetType: dt.targetType || "employee",
    reviewIntervalMonths: dt.reviewIntervalMonths?.toString() || "",
    reminderLeadTimeDays: dt.reminderLeadTimeDays?.toString() || "14",
    isActive: dt.isActive,
  };
}

function toPayload(form: DocTypeFormData) {
  return {
    name: form.name,
    description: form.description || null,
    targetType: form.targetType,
    reviewIntervalMonths: form.reviewIntervalMonths ? parseInt(form.reviewIntervalMonths) : null,
    reminderLeadTimeDays: form.reminderLeadTimeDays ? parseInt(form.reminderLeadTimeDays) : 14,
    isActive: form.isActive,
  };
}

export function DocumentTypesContent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingType, setEditingType] = useState<DocumentTypeData | null>(null);
  const [formData, setFormData] = useState<DocTypeFormData>(emptyForm);
  const [filterTarget, setFilterTarget] = useState<string>("all");

  const { data: docTypes, isLoading } = useQuery<DocumentTypeData[]>({
    queryKey: ["admin", "document-types"],
    queryFn: async () => {
      const result = await api.get<DocumentTypeData[]>("/admin/document-types?includeInactive=true");
      return unwrapResult(result);
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: ReturnType<typeof toPayload>) => {
      const result = await api.post("/admin/document-types", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "document-types"] });
      setIsCreateOpen(false);
      setFormData(emptyForm);
      toast({ title: "Dokumententyp erstellt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: ReturnType<typeof toPayload> & { id: number }) => {
      const result = await api.patch(`/admin/document-types/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "document-types"] });
      setEditingType(null);
      setFormData(emptyForm);
      toast({ title: "Dokumententyp aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleOpenCreate = () => {
    setFormData(emptyForm);
    setIsCreateOpen(true);
  };

  const handleOpenEdit = (dt: DocumentTypeData) => {
    setFormData(toFormData(dt));
    setEditingType(dt);
  };

  const handleSubmit = () => {
    const payload = toPayload(formData);
    if (editingType) {
      updateMutation.mutate({ ...payload, id: editingType.id });
    } else {
      createMutation.mutate(payload);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const filteredDocTypes = docTypes?.filter(dt => 
    filterTarget === "all" || dt.targetType === filterTarget
  );

  const formContent = (
    <div className="space-y-4 pt-2">
      <div className="space-y-2">
        <Label>Name *</Label>
        <Input
          value={formData.name}
          onChange={(e) => setFormData(p => ({ ...p, name: e.target.value }))}
          placeholder="z.B. Führerschein"
          className="text-base"
          data-testid="input-doctype-name"
        />
      </div>
      <div className="space-y-2">
        <Label>Beschreibung</Label>
        <Input
          value={formData.description}
          onChange={(e) => setFormData(p => ({ ...p, description: e.target.value }))}
          placeholder="Optionale Beschreibung"
          className="text-base"
          data-testid="input-doctype-description"
        />
      </div>
      <div className="space-y-2">
        <Label>Zielgruppe *</Label>
        <Select value={formData.targetType} onValueChange={(v) => setFormData(p => ({ ...p, targetType: v }))}>
          <SelectTrigger data-testid="select-doctype-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="employee">Mitarbeiter</SelectItem>
            <SelectItem value="customer">Kunde</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="flex items-center gap-1">
            <CalendarClock className="h-3.5 w-3.5" />
            Prüffrist (Monate)
          </Label>
          <Input
            type="number"
            min="1"
            value={formData.reviewIntervalMonths}
            onChange={(e) => setFormData(p => ({ ...p, reviewIntervalMonths: e.target.value }))}
            placeholder="Leer = keine Prüfung"
            className="text-base"
            data-testid="input-doctype-interval"
          />
          <p className="text-[11px] text-gray-400">Leer lassen wenn keine regelmäßige Prüfung nötig</p>
        </div>
        <div className="space-y-2">
          <Label className="flex items-center gap-1">
            <Bell className="h-3.5 w-3.5" />
            Vorlaufzeit (Tage)
          </Label>
          <Input
            type="number"
            min="1"
            max="365"
            value={formData.reminderLeadTimeDays}
            onChange={(e) => setFormData(p => ({ ...p, reminderLeadTimeDays: e.target.value }))}
            placeholder="14"
            className="text-base"
            data-testid="input-doctype-leadtime"
          />
          <p className="text-[11px] text-gray-400">Tage vorher erinnern</p>
        </div>
      </div>
      <div className="flex items-center gap-3 pt-2">
        <Switch
          checked={formData.isActive}
          onCheckedChange={(v) => setFormData(p => ({ ...p, isActive: v }))}
          data-testid="switch-doctype-active"
        />
        <Label>Aktiv</Label>
      </div>
      <Button
        className={`w-full mt-2 ${componentStyles.btnPrimary}`}
        onClick={handleSubmit}
        disabled={isPending || !formData.name.trim()}
        data-testid="button-save-doctype"
      >
        {isPending && <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />}
        {editingType ? "Aktualisieren" : "Erstellen"}
      </Button>
    </div>
  );

  return (
    <>
          <div className="flex items-center justify-between gap-2 mb-4">
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button className="bg-teal-600 hover:bg-teal-700 shrink-0 ml-auto" onClick={handleOpenCreate} data-testid="button-create-doctype">
                  <Plus className={`${iconSize.sm} sm:mr-2`} />
                  <span className="hidden sm:inline">Neuer Typ</span>
                  <span className="sm:hidden">Neu</span>
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Neuer Dokumententyp</DialogTitle>
                </DialogHeader>
                {formContent}
              </DialogContent>
            </Dialog>
          </div>

          <div className="flex gap-2 mb-4">
            {["all", "employee", "customer"].map((t) => (
              <Button
                key={t}
                variant={filterTarget === t ? "default" : "outline"}
                size="sm"
                className={filterTarget === t ? "bg-teal-600 hover:bg-teal-700" : "bg-white"}
                onClick={() => setFilterTarget(t)}
                data-testid={`filter-target-${t}`}
              >
                {t === "all" ? "Alle" : t === "employee" ? "Mitarbeiter" : "Kunden"}
              </Button>
            ))}
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredDocTypes?.length === 0 && (
                <Card>
                  <CardContent className="p-6 text-center text-gray-500">
                    {filterTarget === "all" 
                      ? "Noch keine Dokumententypen definiert. Erstellen Sie den ersten Typ."
                      : `Keine Dokumententypen für ${filterTarget === "employee" ? "Mitarbeiter" : "Kunden"} gefunden.`
                    }
                  </CardContent>
                </Card>
              )}
              {filteredDocTypes?.map((dt) => (
                <Card key={dt.id} className={!dt.isActive ? "opacity-60" : ""} data-testid={`card-doctype-${dt.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <FileCheck2 className={`${iconSize.sm} text-amber-600 shrink-0`} />
                          <span className="font-semibold text-gray-900">{dt.name}</span>
                          <span className={`text-xs px-2 py-0.5 rounded inline-flex items-center gap-1 ${
                            dt.targetType === "customer" 
                              ? "bg-blue-100 text-blue-700" 
                              : "bg-purple-100 text-purple-700"
                          }`}>
                            {dt.targetType === "customer" ? (
                              <><User className="h-3 w-3" /> Kunde</>
                            ) : (
                              <><Users className="h-3 w-3" /> Mitarbeiter</>
                            )}
                          </span>
                          {!dt.isActive && (
                            <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-600">Inaktiv</span>
                          )}
                        </div>
                        {dt.description && (
                          <p className="text-sm text-gray-500 mb-2 ml-6">{dt.description}</p>
                        )}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 ml-6">
                          {dt.reviewIntervalMonths ? (
                            <span className="text-xs text-gray-500 flex items-center gap-1">
                              <CalendarClock className="h-3 w-3" />
                              Prüfung alle {dt.reviewIntervalMonths} Monate
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400">Keine Prüffrist</span>
                          )}
                          {dt.reviewIntervalMonths && dt.reminderLeadTimeDays && (
                            <span className="text-xs text-gray-500 flex items-center gap-1">
                              <Bell className="h-3 w-3" />
                              {dt.reminderLeadTimeDays} {dt.reminderLeadTimeDays === 1 ? 'Tag' : 'Tage'} Vorlauf
                            </span>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 shrink-0"
                        onClick={() => handleOpenEdit(dt)}
                        data-testid={`button-edit-doctype-${dt.id}`}
                      >
                        <Pencil className={`${iconSize.sm} text-gray-600`} />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

      <Dialog open={!!editingType} onOpenChange={() => { setEditingType(null); setFormData(emptyForm); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dokumententyp bearbeiten</DialogTitle>
          </DialogHeader>
          {formContent}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function AdminDocumentTypes() {
  return (
    <Layout variant="admin">
      <DocumentTypesContent />
    </Layout>
  );
}
