import { useState, useMemo, useCallback } from "react";
import DOMPurify from "dompurify";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { todayISO, formatDateForDisplay } from "@shared/utils/datetime";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Plus,
  Loader2,
  Pencil,
  FileText,
  Eye,
  Code,
  Tag,
  CheckCircle2,
  Circle,
  Info,
  Copy,
} from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";

interface TemplateData {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  htmlContent: string;
  version: number;
  isSystem: boolean;
  isActive: boolean;
  documentTypeId: number | null;
  context: string;
  targetType: string;
  requiresCustomerSignature: boolean;
  requiresEmployeeSignature: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DocumentType {
  id: number;
  name: string;
  targetType: string;
}

interface BillingTypeAssignment {
  id: number;
  templateId: number;
  billingType: string;
  requirement: string;
  sortOrder: number;
}

interface PlaceholderInfo {
  key: string;
  label: string;
  source: string;
}

interface TemplateFormData {
  slug: string;
  name: string;
  description: string;
  htmlContent: string;
  isActive: boolean;
  documentTypeId: number | null;
  context: string;
  targetType: string;
  requiresCustomerSignature: boolean;
  requiresEmployeeSignature: boolean;
}

const emptyForm: TemplateFormData = {
  slug: "",
  name: "",
  description: "",
  htmlContent: "",
  isActive: true,
  documentTypeId: null,
  context: "beide",
  targetType: "customer",
  requiresCustomerSignature: true,
  requiresEmployeeSignature: true,
};

const BILLING_TYPE_LABELS: Record<string, string> = {
  pflegekasse_gesetzlich: "Pflegekasse (gesetzlich)",
  pflegekasse_privat: "Pflegekasse (privat)",
  selbstzahler: "Selbstzahler",
};

const BILLING_TYPES = ["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"] as const;

function toFormData(t: TemplateData): TemplateFormData {
  return {
    slug: t.slug,
    name: t.name,
    description: t.description || "",
    htmlContent: t.htmlContent,
    isActive: t.isActive,
    documentTypeId: t.documentTypeId,
    context: t.context || "beide",
    targetType: t.targetType || "customer",
    requiresCustomerSignature: t.requiresCustomerSignature ?? true,
    requiresEmployeeSignature: t.requiresEmployeeSignature ?? true,
  };
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function DocumentTemplatesContent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingTemplate, setEditingTemplate] = useState<TemplateData | null>(null);
  const [isCreateMode, setIsCreateMode] = useState(false);
  const [formData, setFormData] = useState<TemplateFormData>(emptyForm);
  const [activeTab, setActiveTab] = useState("editor");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [billingAssignments, setBillingAssignments] = useState<Record<string, { enabled: boolean; requirement: string; sortOrder: number }>>({});

  const { data: templates, isLoading } = useQuery<TemplateData[]>({
    queryKey: ["admin", "document-templates"],
    queryFn: async () => {
      const res = await fetch("/api/admin/document-templates?includeInactive=true", { credentials: "include" });
      if (!res.ok) throw new Error("Vorlagen konnten nicht geladen werden");
      return res.json();
    },
  });

  const { data: allBillingTypes, isLoading: isBillingLoading } = useQuery<BillingTypeAssignment[]>({
    queryKey: ["admin", "document-templates-billing-types"],
    queryFn: async () => {
      const res = await fetch("/api/admin/document-templates-billing-types/all", { credentials: "include" });
      if (!res.ok) throw new Error("Zuordnungen konnten nicht geladen werden");
      return res.json();
    },
  });

  const { data: placeholders } = useQuery<PlaceholderInfo[]>({
    queryKey: ["admin", "placeholders-catalog"],
    queryFn: async () => {
      const res = await fetch("/api/admin/document-templates/placeholders/catalog", { credentials: "include" });
      if (!res.ok) throw new Error("Platzhalter konnten nicht geladen werden");
      return res.json();
    },
  });

  const { data: documentTypes } = useQuery<DocumentType[]>({
    queryKey: ["admin", "document-types"],
    queryFn: async () => {
      const res = await fetch("/api/admin/document-types", { credentials: "include" });
      if (!res.ok) throw new Error("Dokumententypen konnten nicht geladen werden");
      return res.json();
    },
  });

  const billingTypesByTemplate = useMemo(() => {
    const map: Record<number, BillingTypeAssignment[]> = {};
    allBillingTypes?.forEach(bt => {
      if (!map[bt.templateId]) map[bt.templateId] = [];
      map[bt.templateId].push(bt);
    });
    return map;
  }, [allBillingTypes]);

  const createMutation = useMutation({
    mutationFn: async (data: { slug: string; name: string; description: string | null; htmlContent: string; isActive: boolean; documentTypeId: number | null; context: string; targetType: string; requiresCustomerSignature: boolean; requiresEmployeeSignature: boolean }) => {
      const result = await api.post("/admin/document-templates", data);
      return unwrapResult(result) as TemplateData;
    },
    onSuccess: (newTemplate: TemplateData) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "document-templates"] });
      saveBillingAssignments(newTemplate.id);
      handleClose();
      toast({ title: "Vorlage erstellt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number; name?: string; description?: string | null; htmlContent?: string; isActive?: boolean; documentTypeId?: number | null; context?: string; targetType?: string; requiresCustomerSignature?: boolean; requiresEmployeeSignature?: boolean }) => {
      const result = await api.patch(`/admin/document-templates/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "document-templates"] });
      if (editingTemplate) {
        saveBillingAssignments(editingTemplate.id);
      }
      handleClose();
      toast({ title: "Vorlage aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const billingMutation = useMutation({
    mutationFn: async ({ templateId, assignments }: { templateId: number; assignments: { billingType: string; requirement: string; sortOrder: number }[] }) => {
      const result = await api.put(`/admin/document-templates/${templateId}/billing-types`, { assignments });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "document-templates-billing-types"] });
    },
    onError: (error: Error) => {
      toast({ title: "Zuordnungsfehler", description: error.message, variant: "destructive" });
    },
  });

  const saveBillingAssignments = useCallback((templateId: number) => {
    const assignments = BILLING_TYPES
      .filter(bt => billingAssignments[bt]?.enabled)
      .map(bt => ({
        billingType: bt,
        requirement: billingAssignments[bt].requirement,
        sortOrder: billingAssignments[bt].sortOrder,
      }));
    billingMutation.mutate({ templateId, assignments });
  }, [billingAssignments, billingMutation]);

  const loadBillingAssignments = useCallback((templateId: number) => {
    const existing = billingTypesByTemplate[templateId] || [];
    const state: Record<string, { enabled: boolean; requirement: string; sortOrder: number }> = {};
    BILLING_TYPES.forEach((bt, idx) => {
      const found = existing.find(e => e.billingType === bt);
      state[bt] = found
        ? { enabled: true, requirement: found.requirement, sortOrder: found.sortOrder }
        : { enabled: false, requirement: "pflicht", sortOrder: idx + 1 };
    });
    setBillingAssignments(state);
  }, [billingTypesByTemplate]);

  const handleOpenCreate = () => {
    setFormData(emptyForm);
    setIsCreateMode(true);
    setEditingTemplate(null);
    setActiveTab("editor");
    setPreviewHtml(null);
    setBillingAssignments(
      Object.fromEntries(BILLING_TYPES.map((bt, idx) => [bt, { enabled: false, requirement: "pflicht", sortOrder: idx + 1 }]))
    );
  };

  const handleOpenEdit = (t: TemplateData) => {
    setFormData(toFormData(t));
    setEditingTemplate(t);
    setIsCreateMode(false);
    setActiveTab("editor");
    setPreviewHtml(null);
    loadBillingAssignments(t.id);
  };

  const handleClose = () => {
    setEditingTemplate(null);
    setIsCreateMode(false);
    setFormData(emptyForm);
    setPreviewHtml(null);
  };

  const handleSubmit = () => {
    if (isCreateMode) {
      createMutation.mutate({
        slug: formData.slug,
        name: formData.name,
        description: formData.description || null,
        htmlContent: formData.htmlContent,
        isActive: formData.isActive,
        documentTypeId: formData.documentTypeId,
        context: formData.context,
        targetType: formData.targetType,
        requiresCustomerSignature: formData.requiresCustomerSignature,
        requiresEmployeeSignature: formData.requiresEmployeeSignature,
      });
    } else if (editingTemplate) {
      updateMutation.mutate({
        id: editingTemplate.id,
        name: formData.name,
        description: formData.description || null,
        htmlContent: formData.htmlContent,
        isActive: formData.isActive,
        documentTypeId: formData.documentTypeId,
        context: formData.context,
        targetType: formData.targetType,
        requiresCustomerSignature: formData.requiresCustomerSignature,
        requiresEmployeeSignature: formData.requiresEmployeeSignature,
      });
    }
  };

  const handlePreview = async () => {
    setIsPreviewLoading(true);
    try {
      const result = await api.post("/admin/document-templates/render", {
        templateSlug: editingTemplate?.slug || formData.slug,
        customerId: 0,
        overrides: {
          customer_name: "Max Mustermann",
          customer_address: "Musterstraße 123, 12345 Berlin",
          customer_birthdate: "01.01.1940",
          customer_phone: "+49 30 1234567",
          customer_email: "max@example.de",
          pflegegrad: "Pflegegrad 3",
          versichertennummer: "A123456789",
          insurance_name: "AOK Bayern",
          ik_nummer: "IK109034270",
          vertragsbeginn: todayISO(),
          mandatsreferenz: "SE-42-2025",
          current_date: todayISO(),
          company_name: "SeniorenEngel GmbH",
        },
      });
      const data = unwrapResult(result) as { html: string };
      setPreviewHtml(data.html);
      setActiveTab("preview");
    } catch {
      const rawHtml = formData.htmlContent
        .replace(/\{\{customer_name\}\}/g, "Max Mustermann")
        .replace(/\{\{customer_address\}\}/g, "Musterstraße 123, 12345 Berlin")
        .replace(/\{\{pflegegrad\}\}/g, "Pflegegrad 3")
        .replace(/\{\{current_date\}\}/g, todayISO())
        .replace(/\{\{company_name\}\}/g, "SeniorenEngel GmbH")
        .replace(/\{\{[a-z_]+\}\}/g, "[...]");
      setPreviewHtml(rawHtml);
      setActiveTab("preview");
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleCopyPlaceholder = (key: string) => {
    const wrapped = `{{${key}}}`;
    navigator.clipboard.writeText(wrapped).then(() => {
      toast({ title: "Kopiert", description: `${wrapped} in die Zwischenablage kopiert` });
    }).catch(() => {
      toast({ title: "Kopieren fehlgeschlagen", variant: "destructive" });
    });
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const isDialogOpen = isCreateMode || !!editingTemplate;

  return (
    <>
          <div className="flex items-center justify-end gap-2 mb-4">
            <Button
              className="bg-teal-600 hover:bg-teal-700 shrink-0"
              onClick={handleOpenCreate}
              data-testid="button-create-template"
            >
              <Plus className={`${iconSize.sm} sm:mr-2`} />
              <span className="hidden sm:inline">Neue Vorlage</span>
              <span className="sm:hidden">Neu</span>
            </Button>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
            </div>
          ) : templates?.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-gray-500">
                Noch keine Vertragsvorlagen vorhanden. Erstellen Sie die erste Vorlage.
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {templates?.map((t) => {
                const assignments = billingTypesByTemplate[t.id] || [];
                return (
                  <Card
                    key={t.id}
                    className={`cursor-pointer hover:shadow-lg transition-shadow ${!t.isActive ? "opacity-60" : ""}`}
                    onClick={() => handleOpenEdit(t)}
                    data-testid={`card-template-${t.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <FileText className={`${iconSize.sm} text-teal-600 shrink-0`} />
                            <span className="font-semibold text-gray-900">{t.name}</span>
                            <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500 font-mono">{t.slug}</span>
                            <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">v{t.version}</span>
                            {t.isSystem && (
                              <span className="text-xs px-2 py-0.5 rounded bg-purple-50 text-purple-600">System</span>
                            )}
                            {!t.isActive && (
                              <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-600">Inaktiv</span>
                            )}
                            {t.context === "vertragsabschluss" && (
                              <span className="text-xs px-2 py-0.5 rounded bg-green-50 text-green-700">Nur bei Vertragsabschluss</span>
                            )}
                            {t.context === "bestandskunde" && (
                              <span className="text-xs px-2 py-0.5 rounded bg-orange-50 text-orange-700">Nur bei Bestandskunden</span>
                            )}
                            {t.targetType === "employee" && (
                              <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-700">Mitarbeiter</span>
                            )}
                            {t.targetType === "beide" && (
                              <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-700">Beide</span>
                            )}
                            {t.documentTypeId && documentTypes?.find(dt => dt.id === t.documentTypeId) && (
                              <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                                {documentTypes.find(dt => dt.id === t.documentTypeId)!.name}
                              </span>
                            )}
                          </div>
                          {t.description && (
                            <p className="text-sm text-gray-500 mb-2 ml-6">{t.description}</p>
                          )}
                          {assignments.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 ml-6 mt-1">
                              {assignments.map(a => (
                                <span
                                  key={a.billingType}
                                  className={`text-xs px-2 py-0.5 rounded inline-flex items-center gap-1 ${
                                    a.requirement === "pflicht"
                                      ? "bg-amber-50 text-amber-700"
                                      : "bg-gray-100 text-gray-600"
                                  }`}
                                >
                                  <Tag className="h-3 w-3" />
                                  {BILLING_TYPE_LABELS[a.billingType]}
                                  <span className="text-[10px]">({a.requirement === "pflicht" ? "Pflicht" : "Optional"})</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-11 w-11 p-0 shrink-0"
                          onClick={(e) => { e.stopPropagation(); handleOpenEdit(t); }}
                          data-testid={`button-edit-template-${t.id}`}
                          aria-label={`${t.name} bearbeiten`}
                        >
                          <Pencil className={`${iconSize.sm} text-gray-600`} />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

      <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isCreateMode ? "Neue Vorlage erstellen" : `Vorlage bearbeiten: ${editingTemplate?.name}`}</DialogTitle>
          </DialogHeader>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-2">
            <TabsList className="bg-white h-auto p-1 flex-wrap gap-1">
              <TabsTrigger value="editor" className="text-sm gap-1.5" data-testid="tab-editor">
                <Code className="h-3.5 w-3.5" />
                Editor
              </TabsTrigger>
              <TabsTrigger value="preview" className="text-sm gap-1.5" data-testid="tab-preview">
                <Eye className="h-3.5 w-3.5" />
                Vorschau
              </TabsTrigger>
              <TabsTrigger value="placeholders" className="text-sm gap-1.5" data-testid="tab-placeholders">
                <Info className="h-3.5 w-3.5" />
                Platzhalter
              </TabsTrigger>
              <TabsTrigger value="billing" className="text-sm gap-1.5" data-testid="tab-billing">
                <Tag className="h-3.5 w-3.5" />
                Zuordnung
              </TabsTrigger>
            </TabsList>

            <TabsContent value="editor" className="space-y-4 mt-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Name *</Label>
                  <Input
                    value={formData.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      setFormData(p => ({
                        ...p,
                        name,
                        ...(isCreateMode ? { slug: generateSlug(name) } : {}),
                      }));
                    }}
                    placeholder="z.B. Betreuungsvertrag Pflegekasse"
                    className="text-base"
                    data-testid="input-template-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Slug {isCreateMode && "(wird automatisch generiert)"}</Label>
                  <Input
                    value={formData.slug}
                    onChange={(e) => setFormData(p => ({ ...p, slug: e.target.value }))}
                    placeholder="betreuungsvertrag_pflegekasse"
                    className="text-base font-mono"
                    disabled={!isCreateMode}
                    data-testid="input-template-slug"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Beschreibung</Label>
                <Input
                  value={formData.description}
                  onChange={(e) => setFormData(p => ({ ...p, description: e.target.value }))}
                  placeholder="Kurze Beschreibung der Vorlage"
                  className="text-base"
                  data-testid="input-template-description"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Dokumentenkategorie</Label>
                  <Select
                    value={formData.documentTypeId?.toString() || "none"}
                    onValueChange={(v) => setFormData(p => ({ ...p, documentTypeId: v === "none" ? null : parseInt(v) }))}
                  >
                    <SelectTrigger data-testid="select-document-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Keine Zuordnung</SelectItem>
                      {documentTypes?.map((dt) => (
                        <SelectItem key={dt.id} value={dt.id.toString()}>{dt.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Kontext</Label>
                  <Select
                    value={formData.context}
                    onValueChange={(v) => setFormData(p => ({ ...p, context: v }))}
                  >
                    <SelectTrigger data-testid="select-context">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="beide">Immer verfügbar</SelectItem>
                      <SelectItem value="vertragsabschluss">Nur bei Vertragsabschluss</SelectItem>
                      <SelectItem value="bestandskunde">Nur bei Bestandskunden</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Zielgruppe</Label>
                  <Select
                    value={formData.targetType}
                    onValueChange={(v) => setFormData(p => ({ ...p, targetType: v }))}
                  >
                    <SelectTrigger data-testid="select-target-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="customer">Kunden</SelectItem>
                      <SelectItem value="employee">Mitarbeiter</SelectItem>
                      <SelectItem value="beide">Beide</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-3 pt-6">
                  <Switch
                    checked={formData.requiresCustomerSignature}
                    onCheckedChange={(v) => setFormData(p => ({ ...p, requiresCustomerSignature: v }))}
                    data-testid="switch-requires-customer-signature"
                  />
                  <Label>Kundenunterschrift erforderlich</Label>
                </div>
                <div className="flex items-center gap-3 pt-6">
                  <Switch
                    checked={formData.requiresEmployeeSignature}
                    onCheckedChange={(v) => setFormData(p => ({ ...p, requiresEmployeeSignature: v }))}
                    data-testid="switch-requires-employee-signature"
                  />
                  <Label>Mitarbeiterunterschrift erforderlich</Label>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>HTML-Inhalt *</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    onClick={handlePreview}
                    disabled={!formData.htmlContent || isPreviewLoading}
                    data-testid="button-preview"
                  >
                    {isPreviewLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                    Vorschau
                  </Button>
                </div>
                <Textarea
                  value={formData.htmlContent}
                  onChange={(e) => setFormData(p => ({ ...p, htmlContent: e.target.value }))}
                  placeholder="<h1>Vertragsvorlage</h1>&#10;<p>Zwischen {{company_name}} und {{customer_name}}...</p>"
                  className="font-mono text-sm min-h-[300px] leading-relaxed"
                  data-testid="textarea-html-content"
                />
                <p className="text-xs text-gray-400">
                  Verwenden Sie {"{{platzhalter}}"} für dynamische Werte. Siehe Tab "Platzhalter" für alle verfügbaren Variablen.
                </p>
              </div>
              <div className="flex items-center gap-3 pt-2">
                <Switch
                  checked={formData.isActive}
                  onCheckedChange={(v) => setFormData(p => ({ ...p, isActive: v }))}
                  data-testid="switch-template-active"
                />
                <Label>Aktiv</Label>
              </div>
              {editingTemplate && (
                <p className="text-xs text-gray-400">
                  Version {editingTemplate.version} · Zuletzt aktualisiert: {formatDateForDisplay(editingTemplate.updatedAt.split("T")[0])}
                  {editingTemplate.isSystem && " · System-Vorlage (Slug nicht änderbar)"}
                </p>
              )}
            </TabsContent>

            <TabsContent value="preview" className="mt-4">
              {previewHtml ? (
                <div className="border rounded-lg p-6 bg-white">
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml, { ALLOWED_TAGS: ['h1','h2','h3','h4','p','br','strong','em','ul','ol','li','table','tr','td','th','thead','tbody','img','div','span','hr','b','i','u','a'], ALLOWED_ATTR: ['class','style','src','alt','width','height','colspan','rowspan','href'] }) }}
                    data-testid="preview-content"
                  />
                </div>
              ) : (
                <div className="text-center py-12 text-gray-400">
                  <Eye className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p>Klicken Sie auf "Vorschau" im Editor-Tab, um eine Vorschau mit Beispieldaten zu generieren.</p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="placeholders" className="mt-4">
              <div className="space-y-1">
                <p className="text-sm text-gray-600 mb-3">
                  Diese Platzhalter können im HTML-Inhalt verwendet werden. Sie werden beim Generieren automatisch mit den Kundendaten ersetzt.
                </p>
                <div className="grid gap-2">
                  {placeholders?.map((p) => (
                    <div
                      key={p.key}
                      className="flex items-center justify-between p-3 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors"
                      data-testid={`placeholder-${p.key}`}
                    >
                      <div className="flex items-center gap-3">
                        <code className="text-sm font-mono bg-white px-2 py-1 rounded border text-teal-700">{p.key}</code>
                        <span className="text-sm text-gray-700">{p.label}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">{p.source}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 w-9 p-0"
                        onClick={() => handleCopyPlaceholder(p.key)}
                        aria-label={`${p.key} kopieren`}
                        data-testid={`button-copy-${p.key}`}
                      >
                        <Copy className="h-3.5 w-3.5 text-gray-400" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="billing" className="mt-4">
              <p className="text-sm text-gray-600 mb-4">
                Legen Sie fest, für welche Abrechnungsarten diese Vorlage im Kundenanlage-Flow angezeigt wird und ob sie verpflichtend oder optional ist.
              </p>
              <div className="space-y-3">
                {BILLING_TYPES.map((bt) => {
                  const assignment = billingAssignments[bt] || { enabled: false, requirement: "pflicht", sortOrder: 0 };
                  return (
                    <Card key={bt} className={assignment.enabled ? "border-teal-200 bg-teal-50/30" : ""}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 flex-1">
                            <Switch
                              checked={assignment.enabled}
                              onCheckedChange={(enabled) => {
                                setBillingAssignments(prev => ({
                                  ...prev,
                                  [bt]: { ...prev[bt], enabled },
                                }));
                              }}
                              data-testid={`switch-billing-${bt}`}
                            />
                            <div>
                              <span className="font-medium text-gray-900">{BILLING_TYPE_LABELS[bt]}</span>
                              {assignment.enabled && (
                                <div className="flex items-center gap-1 mt-0.5">
                                  {assignment.requirement === "pflicht" ? (
                                    <CheckCircle2 className="h-3.5 w-3.5 text-amber-600" />
                                  ) : (
                                    <Circle className="h-3.5 w-3.5 text-gray-400" />
                                  )}
                                  <span className="text-xs text-gray-500">
                                    {assignment.requirement === "pflicht" ? "Pflichtdokument" : "Optionales Dokument"}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                          {assignment.enabled && (
                            <div className="flex items-center gap-3">
                              <Select
                                value={assignment.requirement}
                                onValueChange={(v) => {
                                  setBillingAssignments(prev => ({
                                    ...prev,
                                    [bt]: { ...prev[bt], requirement: v },
                                  }));
                                }}
                              >
                                <SelectTrigger className="w-32 h-9" data-testid={`select-requirement-${bt}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="pflicht">Pflicht</SelectItem>
                                  <SelectItem value="optional">Optional</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="flex items-center gap-1.5">
                                <Label className="text-xs text-gray-500 whitespace-nowrap">Pos.</Label>
                                <Input
                                  type="number"
                                  min="1"
                                  className="w-16 h-9 text-center text-sm"
                                  value={assignment.sortOrder}
                                  onChange={(e) => {
                                    setBillingAssignments(prev => ({
                                      ...prev,
                                      [bt]: { ...prev[bt], sortOrder: parseInt(e.target.value) || 0 },
                                    }));
                                  }}
                                  data-testid={`input-sort-${bt}`}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </TabsContent>
          </Tabs>

          <div className="flex gap-3 pt-4 border-t mt-4">
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleClose}
              data-testid="button-cancel"
            >
              Abbrechen
            </Button>
            <Button
              className={`flex-1 ${componentStyles.btnPrimary}`}
              onClick={handleSubmit}
              disabled={isPending || isBillingLoading || !formData.name.trim() || !formData.htmlContent.trim() || (isCreateMode && !formData.slug.trim())}
              data-testid="button-save-template"
            >
              {isPending && <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />}
              {isCreateMode ? "Erstellen" : "Speichern"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function AdminDocumentTemplates() {
  return (
    <Layout variant="admin">
      <DocumentTemplatesContent />
    </Layout>
  );
}
