import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  Plus,
  Loader2,
  Pencil,
  Trash2,
  GraduationCap,
  FileCheck2,
} from "lucide-react";
import { Link } from "wouter";
import { Textarea } from "@/components/ui/textarea";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";

interface Qualification {
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface QualificationDetail extends Qualification {
  requiredDocuments: {
    id: number;
    qualificationId: number;
    documentTypeId: number;
    isRequired: boolean;
    sortOrder: number;
    documentType: { id: number; name: string };
  }[];
}

interface DocumentType {
  id: number;
  name: string;
  targetType: string;
  isActive: boolean;
}

interface QualFormData {
  name: string;
  description: string;
  isActive: boolean;
  documentTypeIds: number[];
}

const emptyForm: QualFormData = { name: "", description: "", isActive: true, documentTypeIds: [] };

export default function AdminQualificationsPage() {
  return (
    <Layout variant="admin">
      <QualificationsContent />
    </Layout>
  );
}

function QualificationsContent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingQual, setEditingQual] = useState<QualificationDetail | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [formData, setFormData] = useState<QualFormData>(emptyForm);

  const { data: quals, isLoading } = useQuery<Qualification[]>({
    queryKey: ["admin", "qualifications"],
    queryFn: async () => unwrapResult(await api.get<Qualification[]>("/admin/qualifications?activeOnly=false")),
  });

  const { data: pendingReviewCount } = useQuery<{ count: number }>({
    queryKey: ["admin", "pending-proof-count"],
    queryFn: async () => {
      const proofs = unwrapResult(await api.get<any[]>("/admin/qualifications/proofs/pending-review"));
      return { count: proofs.length };
    },
  });

  const { data: docTypes } = useQuery<DocumentType[]>({
    queryKey: ["admin", "document-types-for-quals"],
    queryFn: async () => unwrapResult(await api.get<DocumentType[]>("/admin/document-types?includeInactive=false")),
  });

  const employeeDocTypes = docTypes?.filter((dt) => dt.targetType === "employee" && dt.isActive) || [];

  const createMutation = useMutation({
    mutationFn: async (data: QualFormData) => unwrapResult(await api.post<Qualification>("/admin/qualifications", data)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "qualifications"] });
      toast({ title: "Qualifikation erstellt" });
      setIsCreateOpen(false);
      setFormData(emptyForm);
    },
    onError: () => toast({ title: "Fehler", description: "Qualifikation konnte nicht erstellt werden", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: QualFormData }) => unwrapResult(await api.patch<Qualification>(`/admin/qualifications/${id}`, data)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "qualifications"] });
      toast({ title: "Qualifikation aktualisiert" });
      setEditingQual(null);
      setFormData(emptyForm);
    },
    onError: () => toast({ title: "Fehler", description: "Qualifikation konnte nicht aktualisiert werden", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => unwrapResult(await api.delete(`/admin/qualifications/${id}`)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "qualifications"] });
      toast({ title: "Qualifikation gelöscht" });
      setDeleteId(null);
    },
    onError: () => toast({ title: "Fehler", description: "Qualifikation konnte nicht gelöscht werden", variant: "destructive" }),
  });

  const openEdit = async (qual: Qualification) => {
    try {
      const detail = unwrapResult(await api.get<QualificationDetail>(`/admin/qualifications/${qual.id}`));
      setEditingQual(detail);
      setFormData({
        name: detail.name,
        description: detail.description || "",
        isActive: detail.isActive,
        documentTypeIds: detail.requiredDocuments.map((d) => d.documentTypeId),
      });
    } catch {
      toast({ title: "Fehler", description: "Qualifikation konnte nicht geladen werden", variant: "destructive" });
    }
  };

  const toggleDocType = (id: number) => {
    setFormData((prev) => ({
      ...prev,
      documentTypeIds: prev.documentTypeIds.includes(id)
        ? prev.documentTypeIds.filter((d) => d !== id)
        : [...prev.documentTypeIds, id],
    }));
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/admin/settings">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold" data-testid="text-page-title">Qualifikationen</h1>
          <p className="text-sm text-muted-foreground">Qualifikationen und Nachweis-Anforderungen verwalten</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {(pendingReviewCount?.count ?? 0) > 0 && (
            <Link href="/admin/proof-review">
              <Button variant="outline" size="sm" data-testid="button-proof-review">
                <FileCheck2 className={iconSize.sm} />
                Prüfung
                <Badge variant="destructive" className="ml-1 text-xs px-1.5 py-0">{pendingReviewCount?.count}</Badge>
              </Button>
            </Link>
          )}
          <Button
            onClick={() => { setFormData(emptyForm); setIsCreateOpen(true); }}
            size="sm"
            data-testid="button-create-qualification"
          >
            <Plus className={iconSize.sm} />
            Neu
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !quals?.length ? (
        <Card>
          <CardContent className="py-12 text-center">
            <GraduationCap className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground">Noch keine Qualifikationen angelegt.</p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => { setFormData(emptyForm); setIsCreateOpen(true); }}
              data-testid="button-create-first"
            >
              <Plus className={iconSize.sm} />
              Erste Qualifikation erstellen
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {quals.map((qual) => (
            <Card key={qual.id} className="hover:shadow-md transition-shadow" data-testid={`card-qualification-${qual.id}`}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center gap-3">
                  <GraduationCap className="h-5 w-5 text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate" data-testid={`text-qual-name-${qual.id}`}>{qual.name}</span>
                      {!qual.isActive && (
                        <Badge variant="secondary" className="text-xs">Inaktiv</Badge>
                      )}
                    </div>
                    {qual.description && (
                      <p className="text-xs text-muted-foreground truncate">{qual.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Qualifikation bearbeiten"
                      onClick={() => openEdit(qual)}
                      data-testid={`button-edit-qual-${qual.id}`}
                    >
                      <Pencil className={iconSize.sm} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Qualifikation löschen"
                      onClick={() => setDeleteId(qual.id)}
                      data-testid={`button-delete-qual-${qual.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={isCreateOpen} onOpenChange={(open) => { setIsCreateOpen(open); if (!open) setFormData(emptyForm); }}>
        <DialogContent className="fixed inset-0 flex items-center justify-center">
          <DialogHeader>
            <DialogTitle>Neue Qualifikation</DialogTitle>
          </DialogHeader>
          <QualificationForm
            formData={formData}
            setFormData={setFormData}
            employeeDocTypes={employeeDocTypes}
            toggleDocType={toggleDocType}
            onSubmit={() => createMutation.mutate(formData)}
            isSubmitting={createMutation.isPending}
            submitLabel="Erstellen"
          />
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingQual} onOpenChange={(open) => { if (!open) { setEditingQual(null); setFormData(emptyForm); } }}>
        <DialogContent className="fixed inset-0 flex items-center justify-center">
          <DialogHeader>
            <DialogTitle>Qualifikation bearbeiten</DialogTitle>
          </DialogHeader>
          <QualificationForm
            formData={formData}
            setFormData={setFormData}
            employeeDocTypes={employeeDocTypes}
            toggleDocType={toggleDocType}
            onSubmit={() => editingQual && updateMutation.mutate({ id: editingQual.id, data: formData })}
            isSubmitting={updateMutation.isPending}
            submitLabel="Speichern"
          />
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent className="fixed inset-0 flex items-center justify-center">
          <AlertDialogHeader>
            <AlertDialogTitle>Qualifikation löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              Die Qualifikation und alle zugehörigen Zuweisungen werden unwiderruflich gelöscht.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Löschen"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function QualificationForm({
  formData,
  setFormData,
  employeeDocTypes,
  toggleDocType,
  onSubmit,
  isSubmitting,
  submitLabel,
}: {
  formData: QualFormData;
  setFormData: React.Dispatch<React.SetStateAction<QualFormData>>;
  employeeDocTypes: DocumentType[];
  toggleDocType: (id: number) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  submitLabel: string;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="qual-name">Name *</Label>
        <Input
          id="qual-name"
          value={formData.name}
          onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
          placeholder="z.B. Pflegehelfer/in"
          data-testid="input-qual-name"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="qual-desc">Beschreibung</Label>
        <Textarea
          id="qual-desc"
          value={formData.description}
          onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
          placeholder="Optionale Beschreibung"
          rows={2}
          data-testid="input-qual-description"
        />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="qual-active"
          checked={formData.isActive}
          onCheckedChange={(checked) => setFormData((prev) => ({ ...prev, isActive: checked }))}
          data-testid="switch-qual-active"
        />
        <Label htmlFor="qual-active">Aktiv</Label>
      </div>

      {employeeDocTypes.length > 0 && (
        <div className="space-y-2">
          <Label>Erforderliche Nachweisdokumente</Label>
          <div className="border rounded-lg divide-y max-h-48 overflow-y-auto">
            {employeeDocTypes.map((dt) => (
              <label
                key={dt.id}
                className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                data-testid={`checkbox-doctype-${dt.id}`}
              >
                <input
                  type="checkbox"
                  checked={formData.documentTypeIds.includes(dt.id)}
                  onChange={() => toggleDocType(dt.id)}
                  className="rounded border-gray-300"
                />
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <FileCheck2 className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm truncate">{dt.name}</span>
                </div>
              </label>
            ))}
          </div>
          {formData.documentTypeIds.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {formData.documentTypeIds.length} Dokument{formData.documentTypeIds.length !== 1 ? "e" : ""} ausgewählt
            </p>
          )}
        </div>
      )}

      <Button
        onClick={onSubmit}
        disabled={!formData.name.trim() || isSubmitting}
        className="w-full"
        data-testid="button-submit-qualification"
      >
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : submitLabel}
      </Button>
    </div>
  );
}
