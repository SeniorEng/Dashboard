import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Repeat } from "lucide-react";
import { iconSize } from "@/design-system";

interface EditAppointmentSeriesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointmentStatus: string | null | undefined;
  isPending: boolean;
  onSelect: (mode: "single" | "this_and_future" | "all_future") => void;
}

export function EditAppointmentSeriesDialog({
  open,
  onOpenChange,
  appointmentStatus,
  isPending,
  onSelect,
}: EditAppointmentSeriesDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Repeat className={`${iconSize.md} text-primary`} />
            Serientermin ändern
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground space-y-1">
              <span className="block">Dieser Termin gehört zu einer Serie. Welche Termine möchten Sie ändern?</span>
              <span className="block text-xs">Bei Einzeländerung werden alle Felder inkl. Leistungen gespeichert. Bei Mehrfachänderung werden nur Datum, Uhrzeit, Mitarbeiter und Notizen für die Serie angepasst.</span>
              {appointmentStatus === "completed" && (
                <span className="block mt-2 text-amber-600 font-medium">
                  Dieser Termin ist bereits dokumentiert und kann nicht einzeln geändert werden. Sie können aber alle zukünftigen Termine anpassen.
                </span>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 py-2">
          <button
            onClick={() => onSelect("single")}
            disabled={isPending || appointmentStatus === "completed"}
            className="w-full p-4 rounded-lg border-2 text-left hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-series-edit-single"
          >
            <span className="font-semibold text-sm">Nur diesen Termin ändern</span>
            <span className="block text-xs text-muted-foreground mt-1">
              Alle anderen Serientermine bleiben unverändert
            </span>
          </button>
          <button
            onClick={() => onSelect("this_and_future")}
            disabled={isPending}
            className="w-full p-4 rounded-lg border-2 text-left hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-series-edit-this-and-future"
          >
            <span className="font-semibold text-sm">Diesen und alle folgenden ändern</span>
            <span className="block text-xs text-muted-foreground mt-1">
              Ab diesem Termin werden alle zukünftigen Termine geändert
            </span>
          </button>
          <button
            onClick={() => onSelect("all_future")}
            disabled={isPending}
            className="w-full p-4 rounded-lg border-2 text-left hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-series-edit-all-future"
          >
            <span className="font-semibold text-sm">Alle zukünftigen Termine ändern</span>
            <span className="block text-xs text-muted-foreground mt-1">
              Alle zukünftigen Termine der Serie werden angepasst
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
