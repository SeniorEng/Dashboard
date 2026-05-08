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

export interface DuplicateDialogEntry {
  id: number;
  vorname: string | null;
  nachname: string | null;
  geburtsdatum?: string | null;
  stadt?: string | null;
  strasse?: string | null;
  nr?: string | null;
  status?: string | null;
  createdAt?: string | null;
  ageMs?: number | null;
}

interface DuplicateDialogProps {
  duplicateWarning: { duplicates: DuplicateDialogEntry[] } | null;
  onOpenExisting: (id: number) => void;
  onContinue: () => void;
  onCancel: () => void;
}

function formatAge(input: { createdAt?: string | null; ageMs?: number | null }): string | null {
  let ms: number | null = null;
  if (typeof input.ageMs === "number" && input.ageMs >= 0) ms = input.ageMs;
  else if (input.createdAt) {
    const t = new Date(input.createdAt).getTime();
    if (!Number.isNaN(t)) ms = Date.now() - t;
  }
  if (ms === null) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "vor wenigen Sekunden angelegt";
  if (minutes < 60) return `vor ${minutes} Min angelegt`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std angelegt`;
  const days = Math.floor(hours / 24);
  return `vor ${days} Tagen angelegt`;
}

export function DuplicateDialog({ duplicateWarning, onOpenExisting, onContinue, onCancel }: DuplicateDialogProps) {
  const first = duplicateWarning?.duplicates[0];
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
                Es gibt bereits {duplicateWarning?.duplicates.length === 1 ? "einen Kunden" : `${duplicateWarning?.duplicates.length} Kunden`} mit gleichem Namen{first?.geburtsdatum ? " und Geburtsdatum" : ""}:
              </p>
              <div className="space-y-2 mb-3">
                {duplicateWarning?.duplicates.map((d) => {
                  const age = formatAge(d);
                  return (
                    <div key={d.id} className="p-2 bg-muted rounded-md text-sm" data-testid={`duplicate-entry-${d.id}`}>
                      <div>
                        <span className="font-medium">{d.nachname}, {d.vorname}</span>
                        {d.geburtsdatum && <span className="ml-2 text-muted-foreground">geb. {d.geburtsdatum}</span>}
                        {d.stadt && <span className="ml-2 text-muted-foreground">{d.strasse} {d.nr}, {d.stadt}</span>}
                        {d.status && <span className="ml-2 text-muted-foreground">({d.status})</span>}
                      </div>
                      {age && <div className="text-xs text-muted-foreground mt-1" data-testid={`duplicate-age-${d.id}`}>{age}</div>}
                    </div>
                  );
                })}
              </div>
              <p className="text-sm text-muted-foreground">
                Wir empfehlen den bestehenden Kunden zu öffnen statt einen weiteren anzulegen.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col-reverse sm:flex-row sm:justify-between gap-2">
          <AlertDialogCancel onClick={onCancel} data-testid="button-cancel-duplicate">
            Abbrechen
          </AlertDialogCancel>
          <div className="flex flex-col-reverse sm:flex-row gap-2">
            <AlertDialogAction
              onClick={onContinue}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-duplicate"
            >
              Trotzdem neu anlegen
            </AlertDialogAction>
            {first && (
              <AlertDialogAction
                onClick={() => onOpenExisting(first.id)}
                data-testid="button-open-existing-duplicate"
              >
                Bestehenden Kunden öffnen
              </AlertDialogAction>
            )}
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
