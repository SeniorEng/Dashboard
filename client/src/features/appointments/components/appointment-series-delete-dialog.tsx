import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { iconSize } from "@/design-system";
import { Loader2, Repeat, Users } from "lucide-react";

type Mode = "single" | "this_and_future" | "all_future";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isCompleted: boolean;
  isPending: boolean;
  onChoose: (mode: Mode) => void;
  /**
   * Task #1619 — true, wenn der Termin Teil eines Zwei-Kräfte-Einsatzes ist.
   * Dann wird gewarnt, dass die Absage auch die zweite Kraft betrifft (das
   * Backend kaskadiert die Absage auf den Partner-Leg).
   */
  isCoVisit?: boolean;
  /** Namen der Partner-Mitarbeiter (andere Legs) für die Warnung. */
  coVisitPartnerNames?: string[];
}

export function AppointmentSeriesDeleteDialog({
  open,
  onOpenChange,
  isCompleted,
  isPending,
  onChoose,
  isCoVisit = false,
  coVisitPartnerNames = [],
}: Props) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Repeat className={`${iconSize.md} text-destructive`} />
            Serientermin absagen
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground">
              Dieser Termin gehört zu einer Serie. Welche Termine möchten Sie absagen?
              {isCompleted && (
                <span className="block mt-2 text-amber-600 font-medium">
                  Dieser Termin ist bereits dokumentiert und kann nicht einzeln abgesagt werden. Sie können aber alle zukünftigen Termine der Serie absagen.
                </span>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {isCoVisit && (
          <div
            className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
            data-testid="warning-co-visit-series-cancel"
          >
            <Users className={`${iconSize.sm} text-amber-600 shrink-0 mt-0.5`} />
            <p className="text-sm text-amber-800">
              Dieser Termin ist Teil eines Zwei-Kräfte-Einsatzes — die Absage betrifft auch die zweite Kraft
              {coVisitPartnerNames.length > 0 ? (
                <> (<strong>{coVisitPartnerNames.join(", ")}</strong>)</>
              ) : null}
              . Der Partner-Termin wird ebenfalls abgesagt.
            </p>
          </div>
        )}
        <div className="space-y-3 py-2">
          <button
            onClick={() => onChoose("single")}
            disabled={isPending || isCompleted}
            className="w-full p-4 rounded-lg border-2 text-left hover:border-destructive/50 hover:bg-destructive/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-series-delete-single"
          >
            <span className="font-semibold text-sm">Nur diesen Termin absagen</span>
            <span className="block text-xs text-muted-foreground mt-1">
              Alle anderen Serientermine bleiben bestehen
            </span>
          </button>
          <button
            onClick={() => onChoose("this_and_future")}
            disabled={isPending}
            className="w-full p-4 rounded-lg border-2 text-left hover:border-destructive/50 hover:bg-destructive/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-series-delete-this-and-future"
          >
            <span className="font-semibold text-sm">Diesen und alle folgenden absagen</span>
            <span className="block text-xs text-muted-foreground mt-1">
              Ab diesem Termin werden alle zukünftigen Termine abgesagt
            </span>
          </button>
          <button
            onClick={() => onChoose("all_future")}
            disabled={isPending}
            className="w-full p-4 rounded-lg border-2 text-left hover:border-destructive/50 hover:bg-destructive/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-series-delete-all-future"
          >
            <span className="font-semibold text-sm">Alle zukünftigen Termine absagen</span>
            <span className="block text-xs text-muted-foreground mt-1">
              Die gesamte Serie wird ab heute beendet
            </span>
          </button>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Abbrechen</AlertDialogCancel>
        </AlertDialogFooter>
        {isPending && (
          <div className="flex items-center justify-center py-2">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
