import { useState, useMemo, useCallback, useRef } from "react";
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
  ChevronDown,
  FormInput,
  User,
  Building2,
  Shield,
  FileSignature,
  Calendar,
  Phone,
  Image,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: templates, isLoading } = useQuery<TemplateData[]>({
    queryKey: ["admin", "document-templates"],
    queryFn: async () => {
      const result = await api.get<TemplateData[]>("/admin/document-templates?includeInactive=true");
      return unwrapResult(result);
    },
  });

  const { data: allBillingTypes, isLoading: isBillingLoading } = useQuery<BillingTypeAssignment[]>({
    queryKey: ["admin", "document-templates-billing-types"],
    queryFn: async () => {
      const result = await api.get<BillingTypeAssignment[]>("/admin/document-templates-billing-types/all");
      return unwrapResult(result);
    },
  });

  const { data: placeholders } = useQuery<PlaceholderInfo[]>({
    queryKey: ["admin", "placeholders-catalog"],
    queryFn: async () => {
      const result = await api.get<PlaceholderInfo[]>("/admin/document-templates/placeholders/catalog");
      return unwrapResult(result);
    },
  });

  const { data: documentTypes } = useQuery<DocumentType[]>({
    queryKey: ["admin", "document-types"],
    queryFn: async () => {
      const result = await api.get<DocumentType[]>("/admin/document-types");
      return unwrapResult(result);
    },
  });

  const { data: companySettings } = useQuery<{ pdfLogoUrl?: string | null }>({
    queryKey: ["company-settings"],
    queryFn: async () => {
      const result = await api.get<{ pdfLogoUrl?: string | null }>("/company-settings");
      return unwrapResult(result);
    },
  });

  const insertAtCursor = useCallback((text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setFormData(p => ({ ...p, htmlContent: p.htmlContent + text }));
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = formData.htmlContent.substring(0, start);
    const after = formData.htmlContent.substring(end);
    const newContent = before + text + after;
    setFormData(p => ({ ...p, htmlContent: newContent }));
    requestAnimationFrame(() => {
      textarea.focus();
      const newPos = start + text.length;
      textarea.setSelectionRange(newPos, newPos);
    });
  }, [formData.htmlContent]);

  const groupedPlaceholders = useMemo(() => {
    if (!placeholders) return {};
    const groups: Record<string, PlaceholderInfo[]> = {};
    for (const p of placeholders) {
      const source = p.source;
      if (!groups[source]) groups[source] = [];
      groups[source].push(p);
    }
    return groups;
  }, [placeholders]);

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
        <DialogContent className="max-w-[95vw] w-[1200px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isCreateMode ? "Neue Vorlage erstellen" : `Vorlage bearbeiten: ${editingTemplate?.name}`}</DialogTitle>
          </DialogHeader>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-2">
            <TabsList className="bg-white h-auto p-1 gap-1">
              <TabsTrigger value="editor" className="text-sm gap-1.5" data-testid="tab-editor">
                <Code className="h-3.5 w-3.5" />
                Editor
              </TabsTrigger>
              <TabsTrigger value="settings" className="text-sm gap-1.5" data-testid="tab-settings">
                <Tag className="h-3.5 w-3.5" />
                Einstellungen
              </TabsTrigger>
              <TabsTrigger value="preview" className="text-sm gap-1.5" data-testid="tab-preview">
                <Eye className="h-3.5 w-3.5" />
                Vorschau
              </TabsTrigger>
            </TabsList>

            <TabsContent value="editor" className="mt-4 space-y-2">
              <div className="flex flex-wrap gap-1.5 p-2 bg-gray-50 border rounded-t-lg" data-testid="placeholder-toolbar">
                {Object.entries(groupedPlaceholders).map(([source, items]) => {
                  const sourceLabels: Record<string, { label: string; icon: typeof User }> = {
                    customer: { label: "Kunde", icon: User },
                    insurance: { label: "Versicherung", icon: Shield },
                    company: { label: "Firma", icon: Building2 },
                    contract: { label: "Vertrag", icon: FileText },
                    contact: { label: "Kontakt", icon: Phone },
                    system: { label: "System", icon: Calendar },
                    signature: { label: "Unterschrift", icon: FileSignature },
                  };
                  const config = sourceLabels[source] || { label: source, icon: Tag };
                  const Icon = config.icon;
                  return (
                    <DropdownMenu key={source}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs gap-1 px-2"
                          data-testid={`dropdown-placeholder-${source}`}
                        >
                          <Icon className="h-3 w-3" />
                          {config.label}
                          <ChevronDown className="h-3 w-3 opacity-50" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
                        <DropdownMenuLabel className="text-xs">{config.label}-Felder</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {items.map((p) => (
                          <DropdownMenuItem
                            key={p.key}
                            onClick={() => insertAtCursor(p.key)}
                            className="text-xs gap-2 cursor-pointer"
                            data-testid={`insert-${p.key}`}
                          >
                            <code className="font-mono text-teal-700 bg-teal-50 px-1 rounded text-[10px]">{p.key}</code>
                            <span className="text-gray-600 truncate">{p.label}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  );
                })}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1 px-2 border-amber-300 text-amber-700 hover:bg-amber-50"
                      data-testid="dropdown-input-field"
                    >
                      <FormInput className="h-3 w-3" />
                      Eingabefeld
                      <ChevronDown className="h-3 w-3 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuLabel className="text-xs">Eingabefeld einfügen</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {["Bemerkung", "Anzahl Schlüssel", "Sonstiges", "Datum", "Betrag"].map((label) => (
                      <DropdownMenuItem
                        key={label}
                        onClick={() => insertAtCursor(`{{input:${label}}}`)}
                        className="text-xs gap-2 cursor-pointer"
                        data-testid={`insert-input-${label}`}
                      >
                        <code className="font-mono text-amber-700 bg-amber-50 px-1 rounded text-[10px]">{`{{input:${label}}}`}</code>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        const label = prompt("Bezeichnung des Eingabefelds:");
                        if (label?.trim()) insertAtCursor(`{{input:${label.trim()}}}`);
                      }}
                      className="text-xs gap-2 cursor-pointer font-medium"
                      data-testid="insert-input-custom"
                    >
                      <Plus className="h-3 w-3" />
                      Eigenes Feld...
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {companySettings?.pdfLogoUrl && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1 px-2 border-blue-300 text-blue-700 hover:bg-blue-50"
                    onClick={() => insertAtCursor(`<img src="/api/public/logo/pdf" alt="Logo" style="max-height: 80px;" />`)}
                    data-testid="insert-pdf-logo"
                  >
                    <Image className="h-3 w-3" />
                    PDF-Logo
                  </Button>
                )}
              </div>
              <Textarea
                ref={textareaRef}
                value={formData.htmlContent}
                onChange={(e) => setFormData(p => ({ ...p, htmlContent: e.target.value }))}
                placeholder="<h1>Vertragsvorlage</h1>&#10;<p>Zwischen {{company_name}} und {{customer_name}}...</p>"
                className="font-mono text-sm min-h-[60vh] leading-relaxed rounded-t-none border-t-0 resize-y"
                data-testid="textarea-html-content"
              />
            </TabsContent>

            <TabsContent value="settings" className="mt-4">
              <div className="max-w-lg space-y-4">
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
                    data-testid="input-template-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Beschreibung</Label>
                  <Input
                    value={formData.description}
                    onChange={(e) => setFormData(p => ({ ...p, description: e.target.value }))}
                    placeholder="Kurze Beschreibung der Vorlage"
                    data-testid="input-template-description"
                  />
                </div>
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
                <div className="grid grid-cols-2 gap-4">
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
                </div>
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between">
                    <Label>Aktiv</Label>
                    <Switch
                      checked={formData.isActive}
                      onCheckedChange={(v) => setFormData(p => ({ ...p, isActive: v }))}
                      data-testid="switch-template-active"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-muted-foreground">Kundenunterschrift erforderlich</Label>
                    <Switch
                      checked={formData.requiresCustomerSignature}
                      onCheckedChange={(v) => setFormData(p => ({ ...p, requiresCustomerSignature: v }))}
                      data-testid="switch-requires-customer-signature"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-muted-foreground">Mitarbeiterunterschrift erforderlich</Label>
                    <Switch
                      checked={formData.requiresEmployeeSignature}
                      onCheckedChange={(v) => setFormData(p => ({ ...p, requiresEmployeeSignature: v }))}
                      data-testid="switch-requires-employee-signature"
                    />
                  </div>
                </div>
                {formData.targetType === "customer" && (
                  <>
                    <hr className="my-4" />
                    <div className="space-y-3">
                      <Label className="text-sm font-semibold">Zuordnung zu Abrechnungsarten</Label>
                      <p className="text-xs text-muted-foreground">
                        Für welche Abrechnungsarten wird diese Vorlage im Kundenanlage-Flow angezeigt?
                      </p>
                      {BILLING_TYPES.map((bt) => {
                        const assignment = billingAssignments[bt] || { enabled: false, requirement: "pflicht", sortOrder: 0 };
                        return (
                          <Card key={bt} className={assignment.enabled ? "border-teal-200 bg-teal-50/30" : ""}>
                            <CardContent className="p-3">
                              <div className="flex items-center gap-3">
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
                                <div className="flex-1">
                                  <span className="text-sm font-medium">{BILLING_TYPE_LABELS[bt]}</span>
                                </div>
                              </div>
                              {assignment.enabled && (
                                <div className="flex items-center gap-3 mt-2 ml-11">
                                  <Select
                                    value={assignment.requirement}
                                    onValueChange={(v) => {
                                      setBillingAssignments(prev => ({
                                        ...prev,
                                        [bt]: { ...prev[bt], requirement: v },
                                      }));
                                    }}
                                  >
                                    <SelectTrigger className="w-28 h-8 text-xs" data-testid={`select-requirement-${bt}`}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="pflicht">Pflicht</SelectItem>
                                      <SelectItem value="optional">Optional</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <div className="flex items-center gap-1.5">
                                    <Label className="text-xs text-muted-foreground">Pos.</Label>
                                    <Input
                                      type="number"
                                      min="1"
                                      className="w-14 h-8 text-center text-xs"
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
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  </>
                )}
                {editingTemplate && (
                  <p className="text-xs text-muted-foreground pt-4">
                    Version {editingTemplate.version} · Zuletzt aktualisiert: {formatDateForDisplay(editingTemplate.updatedAt.split("T")[0])}
                    {editingTemplate.isSystem && " · System-Vorlage"}
                  </p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="preview" className="mt-4">
              {previewHtml ? (
                (previewHtml.trimStart().startsWith("<!DOCTYPE") || previewHtml.trimStart().startsWith("<html")) ? (
                  <div className="border rounded-lg bg-white overflow-hidden" style={{ height: "70vh" }}>
                    <iframe
                      srcDoc={previewHtml}
                      className="w-full h-full border-0"
                      sandbox="allow-same-origin"
                      title="Dokumentenvorschau"
                      data-testid="preview-content"
                    />
                  </div>
                ) : (
                  <div className="border rounded-lg p-6 bg-white">
                    <div
                      className="prose prose-sm max-w-none"
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml, { ALLOWED_TAGS: ['html','head','body','style','h1','h2','h3','h4','h5','h6','p','br','strong','em','ul','ol','li','table','tr','td','th','thead','tbody','tfoot','caption','colgroup','col','img','div','span','hr','b','i','u','a','header','footer','section','nav','main','article','aside','figure','figcaption','blockquote','pre','code','dl','dt','dd','meta','title','label','input'], ALLOWED_ATTR: ['class','style','src','alt','width','height','colspan','rowspan','href','id','lang','charset','name','content','type','for','value','placeholder','readonly'] }) }}
                      data-testid="preview-content"
                    />
                  </div>
                )
              ) : (
                <div className="text-center py-12 text-gray-500">
                  <Eye className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p>Klicken Sie auf "Vorschau" im Editor-Tab, um eine Vorschau mit Beispieldaten zu generieren.</p>
                </div>
              )}
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
