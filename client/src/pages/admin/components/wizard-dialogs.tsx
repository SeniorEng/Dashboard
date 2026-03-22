import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { FileText, Trash2, AlertTriangle } from "lucide-react";
import { iconSize } from "@/design-system";

interface DraftDialogProps {
  draftDialog: { timestamp: string } | null;
  onRestore: () => void;
  onDiscard: () => void;
}

export function DraftDialog({ draftDialog, onRestore, onDiscard }: DraftDialogProps) {
  return (
    <AlertDialog open={!!draftDialog} onOpenChange={() => {}}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <FileText className={iconSize.md} />
            Entwurf vorhanden
          </AlertDialogTitle>
          <AlertDialogDescription>
            {draftDialog && (
              <>
                Du hast einen Entwurf vom{" "}
                <strong>
                  {new Date(draftDialog.timestamp).toLocaleDateString("de-DE", {
                    day: "2-digit", month: "2-digit", year: "numeric",
                    hour: "2-digit", minute: "2-digit",
                  })}
                </strong>
                . Möchtest du ihn fortsetzen?
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onDiscard} data-testid="button-discard-draft">
            <Trash2 className="w-4 h-4 mr-1" />
            Verwerfen
          </AlertDialogCancel>
          <AlertDialogAction onClick={onRestore} data-testid="button-restore-draft">
            <FileText className="w-4 h-4 mr-1" />
            Entwurf laden
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface DuplicateDialogProps {
  duplicateWarning: { duplicates: Array<{ id: number; vorname: string; nachname: string; geburtsdatum: string | null; stadt: string | null; strasse: string | null; nr: string | null; status: string | null }> } | null;
  onContinue: () => void;
  onCancel: () => void;
}

export function DuplicateDialog({ duplicateWarning, onContinue, onCancel }: DuplicateDialogProps) {
  return (
    <AlertDialog open={!!duplicateWarning} onOpenChange={() => onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-amber-600">
            <AlertTriangle className={iconSize.md} />
            Mögliches Duplikat erkannt
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <p className="mb-3">
                Es gibt bereits {duplicateWarning?.duplicates.length === 1 ? "einen Kunden" : `${duplicateWarning?.duplicates.length} Kunden`} mit gleichem Namen{duplicateWarning?.duplicates[0]?.geburtsdatum ? " und Geburtsdatum" : ""}:
              </p>
              <div className="space-y-2 mb-3">
                {duplicateWarning?.duplicates.map((d) => (
                  <div key={d.id} className="p-2 bg-muted rounded-md text-sm">
                    <span className="font-medium">{d.nachname}, {d.vorname}</span>
                    {d.geburtsdatum && <span className="ml-2 text-muted-foreground">geb. {d.geburtsdatum}</span>}
                    {d.stadt && <span className="ml-2 text-muted-foreground">{d.strasse} {d.nr}, {d.stadt}</span>}
                    {d.status && <span className="ml-2 text-muted-foreground">({d.status})</span>}
                  </div>
                ))}
              </div>
              <p>Möchtest du den Kunden trotzdem anlegen?</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} data-testid="button-cancel-duplicate">
            Abbrechen
          </AlertDialogCancel>
          <AlertDialogAction onClick={onContinue} data-testid="button-confirm-duplicate">
            Trotzdem fortfahren
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
