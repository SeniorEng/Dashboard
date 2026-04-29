import { Button } from "@/components/ui/button";
import { iconSize, componentStyles } from "@/design-system";
import { Pencil, Save, X, Loader2 } from "lucide-react";

interface EditButtonProps {
  section: string;
  editingSection: string | null;
  startEditing: (section: string) => void;
}

export function EditButton({ section, editingSection, startEditing }: EditButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => startEditing(section)}
      disabled={editingSection !== null && editingSection !== section}
      data-testid={`button-edit-${section}`}
    >
      <Pencil className={iconSize.sm} />
    </Button>
  );
}

interface SaveCancelProps {
  onSave: () => void;
  testIdPrefix: string;
  saving: boolean;
  isPending?: boolean;
  onCancel: () => void;
  hasChanges?: boolean;
}

export function SaveCancelButtons({ onSave, testIdPrefix, saving, isPending = false, onCancel, hasChanges = true }: SaveCancelProps) {
  const isLoading = saving || isPending;
  const noChanges = !isLoading && !hasChanges;
  return (
    <div className="flex items-center gap-2 pt-3">
      <Button
        className={componentStyles.btnPrimary}
        onClick={onSave}
        disabled={isLoading || !hasChanges}
        title={noChanges ? "Keine Änderungen zu speichern" : undefined}
        data-testid={`button-save-${testIdPrefix}`}
      >
        {isLoading ? (
          <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
        ) : (
          <Save className={`${iconSize.sm} mr-2`} />
        )}
        Speichern
      </Button>
      <Button
        variant="outline"
        onClick={onCancel}
        disabled={isLoading}
        data-testid={`button-cancel-${testIdPrefix}`}
      >
        <X className={`${iconSize.sm} mr-2`} />
        Abbrechen
      </Button>
    </div>
  );
}
