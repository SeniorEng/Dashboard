import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Calendar, Clock } from "lucide-react";
import { iconSize } from "@/design-system";
import { EmployeeAvailability } from "./employee-availability";

interface EditAppointmentDateTimeFieldsProps {
  date: string;
  setDate: (value: string) => void;
  time: string;
  setTime: (value: string) => void;
  isErstberatung: boolean;
  isAdmin: boolean;
  ebFullyLocked: boolean;
  ebAssignedEmployeeId: string;
  setEbAssignedEmployeeId: (value: string) => void;
}

export function EditAppointmentDateTimeFields({
  date,
  setDate,
  time,
  setTime,
  isErstberatung,
  isAdmin,
  ebFullyLocked,
  ebAssignedEmployeeId,
  setEbAssignedEmployeeId,
}: EditAppointmentDateTimeFieldsProps) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>
            <Calendar className={`${iconSize.sm} inline mr-1`} /> Datum {isErstberatung ? "*" : ""}
          </Label>
          <DatePicker
            value={date || null}
            onChange={(val) => setDate(val || "")}
            disableWeekends
            disabled={ebFullyLocked}
            data-testid="input-date"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="time">
            <Clock className={`${iconSize.sm} inline mr-1`} />{" "}
            {isErstberatung ? "Startzeit *" : "Startzeit / Abholzeit"}
          </Label>
          <Input
            id="time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="text-base"
            disabled={ebFullyLocked}
            data-testid="input-time"
          />
        </div>
      </div>

      {/* Verfügbarkeits-Widget bleibt admin-only, da es den admin-only
          Endpoint /admin/employees/availability nutzt. Teamleitungen
          wählen den/die Erstberater/in über das Dropdown oben. */}
      {isAdmin && isErstberatung && date && (
        <EmployeeAvailability
          date={date}
          selectedEmployeeId={ebAssignedEmployeeId}
          onSelectEmployee={setEbAssignedEmployeeId}
        />
      )}
    </>
  );
}
