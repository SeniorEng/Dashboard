import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus } from "lucide-react";
import { iconSize } from "@/design-system";
import {
  type DocumentTypeData,
  type DocTypeFormData,
  type TriggerData,
  emptyForm,
  toFormData,
  toPayload,
  createEmptyTrigger,
  useDocumentTypes,
  useDocumentTypeTriggers,
  useDocumentTypeMutations,
  DocumentTypeForm,
  DocumentTypeList,
} from "@/features/documents";

export function DocumentTypesContent() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingType, setEditingType] = useState<DocumentTypeData | null>(null);
  const [formData, setFormData] = useState<DocTypeFormData>(emptyForm);
  const [filterTarget, setFilterTarget] = useState<string>("all");
  const [triggers, setTriggers] = useState<TriggerData[]>([]);
  const [triggersLoaded, setTriggersLoaded] = useState(false);

  const { data: docTypes, isLoading } = useDocumentTypes();
  const { data: editTriggers } = useDocumentTypeTriggers(editingType);

  useEffect(() => {
    if (editTriggers && !triggersLoaded) {
      setTriggers(editTriggers);
      setTriggersLoaded(true);
    }
  }, [editTriggers, triggersLoaded]);

  const { createMutation, updateMutation } = useDocumentTypeMutations({
    triggers,
    onCreateSuccess: () => {
      setIsCreateOpen(false);
      setFormData(emptyForm);
      setTriggers([]);
    },
    onUpdateSuccess: () => {
      setEditingType(null);
      setFormData(emptyForm);
      setTriggers([]);
      setTriggersLoaded(false);
    },
  });

  const handleOpenCreate = () => {
    setFormData(emptyForm);
    setTriggers([]);
    setTriggersLoaded(false);
    setIsCreateOpen(true);
  };

  const handleOpenEdit = (dt: DocumentTypeData) => {
    setFormData(toFormData(dt));
    setTriggers([]);
    setTriggersLoaded(false);
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

  const handleCloseEdit = () => {
    setEditingType(null);
    setFormData(emptyForm);
    setTriggers([]);
    setTriggersLoaded(false);
  };

  const handleCloseCreate = (open: boolean) => {
    if (!open) {
      setTriggers([]);
      setTriggersLoaded(false);
    }
    setIsCreateOpen(open);
  };

  const handleTriggerChange = useCallback((index: number, updated: TriggerData) => {
    setTriggers((prev) => prev.map((t, i) => (i === index ? updated : t)));
  }, []);

  const handleTriggerRemove = useCallback((index: number) => {
    setTriggers((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAddTrigger = () => {
    setTriggers((prev) => [...prev, createEmptyTrigger(formData.targetType)]);
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const filteredDocTypes = docTypes?.filter(dt =>
    filterTarget === "all" || dt.targetType === filterTarget
  );

  const formContent = (
    <DocumentTypeForm
      formData={formData}
      setFormData={setFormData}
      triggers={triggers}
      editingType={editingType}
      isPending={isPending}
      onAddTrigger={handleAddTrigger}
      onTriggerChange={handleTriggerChange}
      onTriggerRemove={handleTriggerRemove}
      onSubmit={handleSubmit}
    />
  );

  return (
    <>
          <div className="flex items-center justify-between gap-2 mb-4">
            <Dialog open={isCreateOpen} onOpenChange={handleCloseCreate}>
              <DialogTrigger asChild>
                <Button className="bg-teal-600 hover:bg-teal-700 shrink-0 ml-auto" onClick={handleOpenCreate} data-testid="button-create-doctype">
                  <Plus className={`${iconSize.sm} sm:mr-2`} />
                  <span className="hidden sm:inline">Neuer Typ</span>
                  <span className="sm:hidden">Neu</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
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

          <DocumentTypeList
            isLoading={isLoading}
            filterTarget={filterTarget}
            filteredDocTypes={filteredDocTypes}
            onEdit={handleOpenEdit}
          />

      <Dialog open={!!editingType} onOpenChange={() => handleCloseEdit()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Dokumententyp bearbeiten</DialogTitle>
          </DialogHeader>
          {formContent}
        </DialogContent>
      </Dialog>
    </>
  );
}
