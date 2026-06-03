import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock } from "lucide-react";
import { iconSize } from "@/design-system";
import { addMinutesToTime } from "@shared/utils/datetime";
import { DURATION_OPTIONS, formatDuration } from "@shared/types";
import type { EditAppointmentSummary } from "./edit-appointment-services-section";

interface EditAppointmentDurationSectionProps {
  isErstberatung: boolean;
  duration: number;
  setDuration: (value: number) => void;
  time: string;
  setEndTime: (value: string) => void;
  ebFullyLocked: boolean;
  summary: EditAppointmentSummary | null;
  errors: Record<string, string>;
}

export function EditAppointmentDurationSection({
  isErstberatung,
  duration,
  setDuration,
  time,
  setEndTime,
  ebFullyLocked,
  summary,
  errors,
}: EditAppointmentDurationSectionProps) {
  return (
    <div className="space-y-4">
      {isErstberatung ? (
        <>
          <div className="space-y-4">
            <Label>Service</Label>
            <div className="flex items-center justify-between p-4 rounded-lg border bg-purple-50 border-purple-200">
              <div className="flex-1">
                <span className="font-medium text-purple-800">Erstberatung</span>
              </div>
              <Select
                value={duration.toString()}
                onValueChange={(val) => {
                  const dur = parseInt(val);
                  setDuration(dur);
                  if (time) {
                    setEndTime(addMinutesToTime(time, dur));
                  }
                }}
                disabled={ebFullyLocked}
              >
                <SelectTrigger className="w-auto min-w-[120px]" data-testid="select-duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map((d) => (
                    <SelectItem key={d} value={d.toString()}>
                      {formatDuration(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {summary && (
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-3" data-testid="eb-summary-panel">
              <div className="flex items-center gap-2 text-purple-700 font-semibold">
                <Clock className={iconSize.sm} />
                <span>Terminübersicht</span>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-purple-600">Von</span>
                  <p className="font-medium text-lg text-purple-800">{summary.startTime} Uhr</p>
                </div>
                <div>
                  <span className="text-purple-600">Bis</span>
                  <p className="font-medium text-lg text-purple-800">{summary.endTime} Uhr</p>
                </div>
              </div>

              <div className="border-t border-purple-200 pt-3">
                <div className="flex justify-between text-sm">
                  <span className="text-purple-700">Erstberatung</span>
                  <span className="font-medium text-purple-800">{formatDuration(duration)}</span>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <Label>
            <Clock className={`${iconSize.sm} inline mr-1`} /> Dauer
          </Label>
          <Select
            value={duration.toString()}
            onValueChange={(val) => {
              const dur = parseInt(val);
              setDuration(dur);
              if (time) {
                setEndTime(addMinutesToTime(time, dur));
              }
            }}
          >
            <SelectTrigger data-testid="select-duration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATION_OPTIONS.map((d) => (
                <SelectItem key={d} value={d.toString()}>
                  {formatDuration(d)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {time && (
            <p className="text-xs text-muted-foreground">
              {time} – {addMinutesToTime(time, duration)}
            </p>
          )}
        </div>
      )}
      {errors.time && <p className="text-destructive text-sm">{errors.time}</p>}
    </div>
  );
}
