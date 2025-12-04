import { useState, useMemo } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useTimeOverview, useVacationSummary, useCreateTimeEntry, useDeleteTimeEntry } from "@/features/time-tracking";
import {
  Calendar,
  Plus,
  Palmtree,
  Thermometer,
  Coffee,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Loader2,
  FileText,
  Car,
  Home,
  Users,
} from "lucide-react";
import type { TimeEntryType, CreateTimeEntryRequest, AppointmentWithCustomerName } from "@/lib/api/types";

const TIME_ENTRY_TYPE_CONFIG: Record<TimeEntryType, { label: string; icon: React.ElementType; color: string; bgColor: string }> = {
  urlaub: { label: "Urlaub", icon: Palmtree, color: "text-green-700", bgColor: "bg-green-100" },
  krankheit: { label: "Krankheit", icon: Thermometer, color: "text-red-700", bgColor: "bg-red-100" },
  pause: { label: "Pause", icon: Coffee, color: "text-amber-700", bgColor: "bg-amber-100" },
  bueroarbeit: { label: "Büroarbeit", icon: Briefcase, color: "text-blue-700", bgColor: "bg-blue-100" },
  vertrieb: { label: "Vertrieb", icon: Briefcase, color: "text-purple-700", bgColor: "bg-purple-100" },
  schulung: { label: "Schulung", icon: FileText, color: "text-indigo-700", bgColor: "bg-indigo-100" },
  besprechung: { label: "Besprechung", icon: FileText, color: "text-teal-700", bgColor: "bg-teal-100" },
  sonstiges: { label: "Sonstiges", icon: FileText, color: "text-gray-700", bgColor: "bg-gray-100" },
};

const formatDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const WEEKDAY_NAMES = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];

export default function MyTimes() {
  const { toast } = useToast();
  const today = new Date();
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showNewEntryDialog, setShowNewEntryDialog] = useState(false);
  const [newEntry, setNewEntry] = useState<CreateTimeEntryRequest>({
    entryType: "urlaub",
    entryDate: formatDateString(today),
    isFullDay: true,
  });

  const { data: timeOverview, isLoading } = useTimeOverview(selectedYear, selectedMonth);
  const { data: vacationSummary } = useVacationSummary(selectedYear);
  const createMutation = useCreateTimeEntry();
  const deleteMutation = useDeleteTimeEntry();

  const entries = timeOverview?.otherEntries;
  const appointments = timeOverview?.appointments;

  const formatMinutesToHours = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours === 0) return `${mins} min`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}min`;
  };

  const calendarDays = useMemo(() => {
    const firstDay = new Date(selectedYear, selectedMonth - 1, 1);
    const lastDay = new Date(selectedYear, selectedMonth, 0);
    const daysInMonth = lastDay.getDate();
    const startDayOfWeek = firstDay.getDay();
    
    const days: { date: string; day: number; isCurrentMonth: boolean; isToday: boolean; isWeekend: boolean }[] = [];
    
    // Add days from previous month
    const prevMonthLastDay = new Date(selectedYear, selectedMonth - 1, 0).getDate();
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const day = prevMonthLastDay - i;
      const date = new Date(selectedYear, selectedMonth - 2, day);
      days.push({
        date: formatDateString(date),
        day,
        isCurrentMonth: false,
        isToday: false,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
      });
    }
    
    const todayStr = formatDateString(today);
    
    // Add days from current month
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(selectedYear, selectedMonth - 1, day);
      const dateStr = formatDateString(date);
      days.push({
        date: dateStr,
        day,
        isCurrentMonth: true,
        isToday: dateStr === todayStr,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
      });
    }
    
    // Add days from next month to complete the grid
    const remainingDays = 42 - days.length; // 6 rows x 7 days
    for (let day = 1; day <= remainingDays; day++) {
      const date = new Date(selectedYear, selectedMonth, day);
      days.push({
        date: formatDateString(date),
        day,
        isCurrentMonth: false,
        isToday: false,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
      });
    }
    
    return days;
  }, [selectedYear, selectedMonth]);

  const entriesByDate = useMemo(() => {
    if (!entries) return {};
    return entries.reduce((acc, entry) => {
      if (!acc[entry.entryDate]) acc[entry.entryDate] = [];
      acc[entry.entryDate].push(entry);
      return acc;
    }, {} as Record<string, typeof entries>);
  }, [entries]);

  const appointmentsByDate = useMemo(() => {
    if (!appointments) return {};
    return appointments.reduce((acc, appt) => {
      if (!acc[appt.date]) acc[appt.date] = [];
      acc[appt.date].push(appt);
      return acc;
    }, {} as Record<string, AppointmentWithCustomerName[]>);
  }, [appointments]);

  const handlePrevMonth = () => {
    if (selectedMonth === 1) {
      setSelectedMonth(12);
      setSelectedYear(selectedYear - 1);
    } else {
      setSelectedMonth(selectedMonth - 1);
    }
  };

  const handleNextMonth = () => {
    if (selectedMonth === 12) {
      setSelectedMonth(1);
      setSelectedYear(selectedYear + 1);
    } else {
      setSelectedMonth(selectedMonth + 1);
    }
  };

  const handleDayClick = (date: string) => {
    setSelectedDate(date);
    setNewEntry(prev => ({ ...prev, entryDate: date }));
  };

  const handleCreateEntry = () => {
    createMutation.mutate(newEntry, {
      onSuccess: () => {
        toast({ title: "Eintrag erstellt" });
        setShowNewEntryDialog(false);
        setNewEntry({
          entryType: "urlaub",
          entryDate: formatDateString(today),
          isFullDay: true,
        });
      },
      onError: (error: Error) => {
        toast({ title: "Fehler", description: error.message, variant: "destructive" });
      },
    });
  };

  const handleDeleteEntry = (id: number) => {
    deleteMutation.mutate(id, {
      onSuccess: () => {
        toast({ title: "Eintrag gelöscht" });
      },
      onError: (error: Error) => {
        toast({ title: "Fehler", description: error.message, variant: "destructive" });
      },
    });
  };

  const selectedDayEntries = selectedDate ? entriesByDate[selectedDate] || [] : [];
  const selectedDayAppointments = selectedDate ? appointmentsByDate[selectedDate] || [] : [];
  const hasDayItems = selectedDayEntries.length > 0 || selectedDayAppointments.length > 0;

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-6xl">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900" data-testid="text-page-title">Meine Zeiten</h1>
              <p className="text-gray-600">Kundentermine, Urlaub und Abwesenheiten</p>
            </div>
            <Dialog open={showNewEntryDialog} onOpenChange={setShowNewEntryDialog}>
              <DialogTrigger asChild>
                <Button className="bg-teal-600 hover:bg-teal-700" data-testid="button-new-entry">
                  <Plus className="h-4 w-4 mr-2" />
                  Neuer Eintrag
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Neuen Zeiteintrag erstellen</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-4">
                  <div className="space-y-2">
                    <Label htmlFor="entryType">Art</Label>
                    <Select
                      value={newEntry.entryType}
                      onValueChange={(value) => setNewEntry(prev => ({ ...prev, entryType: value as TimeEntryType }))}
                    >
                      <SelectTrigger data-testid="select-entry-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(TIME_ENTRY_TYPE_CONFIG).map(([type, config]) => (
                          <SelectItem key={type} value={type}>
                            <div className="flex items-center gap-2">
                              <config.icon className={`h-4 w-4 ${config.color}`} />
                              {config.label}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="entryDate">Datum</Label>
                    <Input
                      id="entryDate"
                      type="date"
                      value={newEntry.entryDate}
                      onChange={(e) => setNewEntry(prev => ({ ...prev, entryDate: e.target.value }))}
                      data-testid="input-entry-date"
                    />
                  </div>

                  {(newEntry.entryType === "pause" || newEntry.entryType === "bueroarbeit" || 
                    newEntry.entryType === "besprechung" || newEntry.entryType === "schulung") && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="startTime">Startzeit</Label>
                        <Input
                          id="startTime"
                          type="time"
                          value={newEntry.startTime || ""}
                          onChange={(e) => setNewEntry(prev => ({ 
                            ...prev, 
                            startTime: e.target.value,
                            isFullDay: false,
                          }))}
                          data-testid="input-start-time"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="endTime">Endzeit</Label>
                        <Input
                          id="endTime"
                          type="time"
                          value={newEntry.endTime || ""}
                          onChange={(e) => setNewEntry(prev => ({ ...prev, endTime: e.target.value }))}
                          data-testid="input-end-time"
                        />
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="notes">Notizen (optional)</Label>
                    <Textarea
                      id="notes"
                      value={newEntry.notes || ""}
                      onChange={(e) => setNewEntry(prev => ({ ...prev, notes: e.target.value }))}
                      placeholder="Optionale Bemerkungen..."
                      data-testid="input-notes"
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-4">
                    <Button 
                      variant="outline" 
                      onClick={() => setShowNewEntryDialog(false)}
                      data-testid="button-cancel"
                    >
                      Abbrechen
                    </Button>
                    <Button
                      className="bg-teal-600 hover:bg-teal-700"
                      onClick={handleCreateEntry}
                      disabled={createMutation.isPending}
                      data-testid="button-save-entry"
                    >
                      {createMutation.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Speichern...
                        </>
                      ) : (
                        "Speichern"
                      )}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {/* Time Overview Summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {/* Customer Hours Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Kundenstunden {MONTH_NAMES[selectedMonth - 1]}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Hauswirtschaft</span>
                    <span className="font-semibold text-teal-700" data-testid="text-hauswirtschaft-hours">
                      {formatMinutesToHours(timeOverview?.serviceHours?.hauswirtschaftMinutes || 0)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Alltagsbegleitung</span>
                    <span className="font-semibold text-blue-700" data-testid="text-alltagsbegleitung-hours">
                      {formatMinutesToHours(timeOverview?.serviceHours?.alltagsbegleitungMinutes || 0)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Erstberatung</span>
                    <span className="font-semibold text-purple-700" data-testid="text-erstberatung-hours">
                      {formatMinutesToHours(timeOverview?.serviceHours?.erstberatungMinutes || 0)}
                    </span>
                  </div>
                  <div className="border-t pt-2 mt-2 flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-700">Gesamt</span>
                    <span className="font-bold text-gray-900" data-testid="text-total-service-hours">
                      {formatMinutesToHours(
                        (timeOverview?.serviceHours?.hauswirtschaftMinutes || 0) +
                        (timeOverview?.serviceHours?.alltagsbegleitungMinutes || 0) +
                        (timeOverview?.serviceHours?.erstberatungMinutes || 0)
                      )}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Travel Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
                  <Car className="h-4 w-4" />
                  Anfahrt {MONTH_NAMES[selectedMonth - 1]}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-3">
                  <div className="text-center p-3 rounded-lg bg-amber-50">
                    <div className="text-2xl font-bold text-amber-700" data-testid="text-total-km">
                      {timeOverview?.travel?.totalKilometers || 0} km
                    </div>
                    <div className="text-xs text-gray-500">Kilometer gesamt</div>
                  </div>
                  <div className="text-center p-3 rounded-lg bg-orange-50">
                    <div className="text-2xl font-bold text-orange-700" data-testid="text-total-travel-time">
                      {formatMinutesToHours(timeOverview?.travel?.totalMinutes || 0)}
                    </div>
                    <div className="text-xs text-gray-500">Fahrzeit gesamt</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Vacation & Absence Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
                  <Palmtree className="h-4 w-4" />
                  Urlaub {selectedYear}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {vacationSummary ? (
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Verfügbar</span>
                      <span className="font-bold text-teal-700" data-testid="text-remaining-days">
                        {vacationSummary.remainingDays} Tage
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Genommen</span>
                      <span className="font-semibold text-green-700" data-testid="text-used-days">
                        {vacationSummary.usedDays} Tage
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Geplant</span>
                      <span className="font-semibold text-blue-700" data-testid="text-planned-days">
                        {vacationSummary.plannedDays} Tage
                      </span>
                    </div>
                    <div className="border-t pt-2 mt-2 flex justify-between items-center">
                      <span className="text-sm text-gray-600">Krankheit</span>
                      <span className="font-semibold text-red-700" data-testid="text-sick-days">
                        {vacationSummary.sickDays} Tage
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-4 text-gray-400 text-sm">Laden...</div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Calendar */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <Button variant="ghost" size="icon" onClick={handlePrevMonth} data-testid="button-prev-month">
                    <ChevronLeft className="h-5 w-5" />
                  </Button>
                  <CardTitle className="text-lg">
                    {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
                  </CardTitle>
                  <Button variant="ghost" size="icon" onClick={handleNextMonth} data-testid="button-next-month">
                    <ChevronRight className="h-5 w-5" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-7 gap-1 mb-2">
                      {WEEKDAY_NAMES.map((day) => (
                        <div key={day} className="text-center text-xs font-medium text-gray-500 py-2">
                          {day}
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                      {calendarDays.map(({ date, day, isCurrentMonth, isToday, isWeekend }) => {
                        const dayEntries = entriesByDate[date] || [];
                        const dayAppointments = appointmentsByDate[date] || [];
                        const hasAppointments = dayAppointments.length > 0;
                        const hasOtherEntries = dayEntries.length > 0;
                        const isSelected = date === selectedDate;
                        
                        return (
                          <button
                            key={date}
                            onClick={() => handleDayClick(date)}
                            className={`
                              relative p-2 min-h-[60px] rounded-lg text-sm transition-colors
                              ${isCurrentMonth ? "bg-white" : "bg-gray-50 text-gray-400"}
                              ${isWeekend && isCurrentMonth ? "bg-gray-100" : ""}
                              ${isToday ? "ring-2 ring-teal-500" : ""}
                              ${isSelected ? "ring-2 ring-teal-600" : "hover:bg-gray-100"}
                            `}
                            data-testid={`calendar-day-${date}`}
                          >
                            <span className={`font-medium ${isToday ? "text-teal-700" : ""}`}>{day}</span>
                            {(hasAppointments || hasOtherEntries) && (
                              <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-0.5">
                                {hasAppointments && (
                                  <div className="w-1.5 h-1.5 rounded-full bg-teal-500" title="Kundentermine" />
                                )}
                                {hasOtherEntries && (
                                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Andere Einträge" />
                                )}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Selected Day Details */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Calendar className="h-5 w-5" />
                  {selectedDate 
                    ? (() => {
                        const [year, month, day] = selectedDate.split("-").map(Number);
                        const date = new Date(year, month - 1, day);
                        return date.toLocaleDateString("de-DE", { 
                          weekday: "long", 
                          day: "numeric", 
                          month: "long" 
                        });
                      })()
                    : "Tag auswählen"
                  }
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!selectedDate ? (
                  <p className="text-gray-500 text-sm text-center py-8">
                    Klicken Sie auf einen Tag im Kalender, um Details anzuzeigen.
                  </p>
                ) : !hasDayItems ? (
                  <div className="text-center py-8">
                    <p className="text-gray-500 text-sm mb-4">Keine Einträge an diesem Tag.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setNewEntry(prev => ({ ...prev, entryDate: selectedDate }));
                        setShowNewEntryDialog(true);
                      }}
                      data-testid="button-add-entry-for-day"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Eintrag hinzufügen
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {/* Appointments */}
                    {selectedDayAppointments.map((appt) => {
                      const getServiceInfo = () => {
                        const services = [];
                        if (appt.hauswirtschaftDauer || appt.hauswirtschaftActualDauer) {
                          services.push({ name: "HW", minutes: appt.hauswirtschaftActualDauer || appt.hauswirtschaftDauer || 0 });
                        }
                        if (appt.alltagsbegleitungDauer || appt.alltagsbegleitungActualDauer) {
                          services.push({ name: "AB", minutes: appt.alltagsbegleitungActualDauer || appt.alltagsbegleitungDauer || 0 });
                        }
                        if (appt.erstberatungDauer || appt.erstberatungActualDauer) {
                          services.push({ name: "EB", minutes: appt.erstberatungActualDauer || appt.erstberatungDauer || 0 });
                        }
                        return services;
                      };
                      const services = getServiceInfo();
                      
                      return (
                        <div
                          key={`appt-${appt.id}`}
                          className="p-3 rounded-lg bg-teal-50 border border-teal-200"
                          data-testid={`appointment-${appt.id}`}
                        >
                          <div className="flex items-start gap-3">
                            <Users className="h-5 w-5 mt-0.5 text-teal-700" />
                            <div className="flex-1">
                              <div className="font-medium text-teal-800">{appt.customerName}</div>
                              <div className="text-sm text-gray-600">
                                {appt.scheduledStart.slice(0, 5)} Uhr
                              </div>
                              <div className="flex flex-wrap gap-2 mt-1">
                                {services.map((s, i) => (
                                  <span key={i} className="text-xs px-2 py-0.5 bg-teal-100 rounded text-teal-700">
                                    {s.name}: {formatMinutesToHours(s.minutes)}
                                  </span>
                                ))}
                              </div>
                              {(appt.travelKilometers || appt.travelMinutes) && (
                                <div className="flex items-center gap-2 mt-1 text-xs text-amber-700">
                                  <Car className="h-3 w-3" />
                                  <span>
                                    {appt.travelKilometers ? `${appt.travelKilometers} km` : ""}
                                    {appt.travelKilometers && appt.travelMinutes ? " • " : ""}
                                    {appt.travelMinutes ? `${appt.travelMinutes} min` : ""}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    
                    {/* Time Entries */}
                    {selectedDayEntries.map((entry) => {
                      const config = TIME_ENTRY_TYPE_CONFIG[entry.entryType as TimeEntryType];
                      const Icon = config.icon;
                      return (
                        <div
                          key={entry.id}
                          className={`p-3 rounded-lg ${config.bgColor} flex items-start justify-between`}
                          data-testid={`time-entry-${entry.id}`}
                        >
                          <div className="flex items-start gap-3">
                            <Icon className={`h-5 w-5 mt-0.5 ${config.color}`} />
                            <div>
                              <div className={`font-medium ${config.color}`}>{config.label}</div>
                              {entry.startTime && entry.endTime && (
                                <div className="text-sm text-gray-600">
                                  {entry.startTime.slice(0, 5)} - {entry.endTime.slice(0, 5)}
                                </div>
                              )}
                              {entry.isFullDay && (
                                <div className="text-sm text-gray-600">Ganztägig</div>
                              )}
                              {entry.notes && (
                                <div className="text-sm text-gray-600 mt-1">{entry.notes}</div>
                              )}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-gray-400 hover:text-red-600"
                            onClick={() => handleDeleteEntry(entry.id)}
                            disabled={deleteMutation.isPending}
                            data-testid={`button-delete-entry-${entry.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      );
                    })}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full mt-2"
                      onClick={() => {
                        setNewEntry(prev => ({ ...prev, entryDate: selectedDate }));
                        setShowNewEntryDialog(true);
                      }}
                      data-testid="button-add-another-entry"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Weiteren Eintrag hinzufügen
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

        </div>
      </div>
    </Layout>
  );
}
