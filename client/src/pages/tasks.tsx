import { useState } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Loader2, AlertCircle, Coffee, FileSignature, CalendarCheck } from "lucide-react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import { useTasks, useCreateTask, useToggleTaskStatus, type TaskWithRelations, TaskCard, TaskDetailSheet } from "@/features/tasks";
import { DatePicker } from "@/components/ui/date-picker";
import { formatDateForDisplay } from "@shared/utils/datetime";

type TaskFilter = "open" | "completed";

export default function TasksPage() {
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskWithRelations | null>(null);
  
  const includeCompleted = filter === "completed";
  const { data: tasks, isLoading } = useTasks({ includeCompleted });
  const createTask = useCreateTask();
  const toggleTaskStatus = useToggleTaskStatus();

  const { data: undocumentedAppointments } = useQuery({
    queryKey: ["appointments", "undocumented"],
    queryFn: async () => {
      const result = await api.get("/appointments/undocumented");
      return unwrapResult(result);
    },
    staleTime: 60000,
  });
  const undocumentedCount = undocumentedAppointments?.length || 0;

  const { data: openTimeTasks } = useQuery({
    queryKey: ["time-entries", "open-tasks"],
    queryFn: async () => {
      const result = await api.get<{
        daysWithMissingBreaks: Array<{
          date: string;
          totalWorkMinutes: number;
          requiredBreakMinutes: number;
          documentedBreakMinutes: number;
        }>;
      }>("/time-entries/open-tasks");
      return unwrapResult(result);
    },
    staleTime: 60000,
  });
  const missingBreaksCount = openTimeTasks?.daysWithMissingBreaks?.length || 0;

  const { data: pendingServiceRecords } = useQuery({
    queryKey: ["/api/service-records/pending"],
    queryFn: async () => {
      const result = await api.get("/service-records/pending");
      return unwrapResult(result);
    },
    staleTime: 60000,
  });
  const pendingServiceRecordsCount = pendingServiceRecords?.length || 0;

  const { data: monthClosingReminder } = useQuery({
    queryKey: ["/api/tasks/month-closing-reminder"],
    queryFn: async () => {
      const result = await api.get<{
        needed: boolean;
        month?: number;
        year?: number;
        monthName?: string;
        taskId?: number;
      }>("/tasks/month-closing-reminder");
      return unwrapResult(result);
    },
    staleTime: 60000,
  });
  const monthClosingNeeded = monthClosingReminder?.needed || false;

  const totalSystemHints = undocumentedCount + missingBreaksCount + pendingServiceRecordsCount + (monthClosingNeeded ? 1 : 0);

  const [newTask, setNewTask] = useState({
    title: "",
    description: "",
    dueDate: "",
    priority: "medium" as "low" | "medium" | "high",
  });

  const handleCreateTask = async () => {
    if (!newTask.title.trim()) return;
    
    await createTask.mutateAsync({
      title: newTask.title,
      description: newTask.description || undefined,
      dueDate: newTask.dueDate || undefined,
      priority: newTask.priority,
    });
    
    setNewTask({ title: "", description: "", dueDate: "", priority: "medium" });
    setIsCreateDialogOpen(false);
  };

  const handleToggleStatus = async (id: number, currentStatus: string) => {
    await toggleTaskStatus.mutateAsync({ id, currentStatus });
  };

  const filteredTasks = tasks?.filter(task => {
    if (filter === "open") return task.status !== "completed";
    return task.status === "completed";
  }) || [];


  return (
    <Layout>
      <div className="animate-in slide-in-from-top-4 duration-500">
        <div className={componentStyles.pageHeader}>
          <div className={componentStyles.pageHeaderTop}>
            <h1 className={componentStyles.pageTitle} data-testid="text-tasks-title">Aufgaben</h1>
          </div>
          <div className={componentStyles.pageHeaderActions}>
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className={componentStyles.pageHeaderActionBtn} data-testid="button-new-task">
                  <Plus className={`${iconSize.sm} mr-1`} />
                  Neue Aufgabe
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Neue Aufgabe</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div>
                    <Label htmlFor="new-task-title">Titel</Label>
                    <Input
                      id="new-task-title"
                      value={newTask.title}
                      onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                      placeholder="Was ist zu tun?"
                      data-testid="input-new-task-title"
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-task-description">Beschreibung (optional)</Label>
                    <Textarea
                      id="new-task-description"
                      value={newTask.description}
                      onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                      placeholder="Details zur Aufgabe..."
                      rows={3}
                      data-testid="input-new-task-description"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Fällig am</Label>
                      <DatePicker
                        value={newTask.dueDate || null}
                        onChange={(date) => setNewTask({ ...newTask, dueDate: date || "" })}
                        placeholder="Datum wählen"
                        data-testid="input-new-task-due-date"
                      />
                    </div>
                    <div>
                      <Label htmlFor="new-task-priority">Priorität</Label>
                      <Select
                        value={newTask.priority}
                        onValueChange={(v) => setNewTask({ ...newTask, priority: v as "low" | "medium" | "high" })}
                      >
                        <SelectTrigger id="new-task-priority" data-testid="select-new-task-priority">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">Niedrig</SelectItem>
                          <SelectItem value="medium">Mittel</SelectItem>
                          <SelectItem value="high">Hoch</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button 
                    onClick={handleCreateTask} 
                    disabled={!newTask.title.trim() || createTask.isPending}
                    className="w-full"
                    data-testid="button-create-task"
                  >
                    {createTask.isPending ? (
                      <Loader2 className={`${iconSize.sm} animate-spin mr-2`} />
                    ) : null}
                    Aufgabe erstellen
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {totalSystemHints > 0 && (
          <div className="mb-4 space-y-2" data-testid="system-hints-section">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              System-Hinweise
            </h2>

            {undocumentedCount > 0 && (
              <Link href="/undocumented">
                <div
                  className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 hover:bg-amber-100 transition-colors cursor-pointer"
                  data-testid="banner-undocumented"
                >
                  <AlertCircle className={`${iconSize.sm} shrink-0`} />
                  <span className="text-sm font-medium">
                    {undocumentedCount} {undocumentedCount === 1 ? "offene Dokumentation" : "offene Dokumentationen"}
                  </span>
                </div>
              </Link>
            )}

            {missingBreaksCount > 0 && (
              <Link href="/my-times#missing-breaks">
                <div
                  className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 hover:bg-blue-100 transition-colors cursor-pointer"
                  data-testid="banner-missing-breaks"
                >
                  <Coffee className={`${iconSize.sm} shrink-0`} />
                  <div className="text-sm">
                    <span className="font-medium">Fehlende Pausendokumentation: </span>
                    <span>
                      {openTimeTasks?.daysWithMissingBreaks
                        ?.slice(0, 5)
                        .map(d => formatDateForDisplay(d.date, { day: "numeric", month: "numeric" }))
                        .join(", ")}
                      {missingBreaksCount > 5 && ` (+${missingBreaksCount - 5} weitere)`}
                    </span>
                  </div>
                </div>
              </Link>
            )}

            {pendingServiceRecordsCount > 0 && (
              <Link href="/service-records">
                <div
                  className="flex items-center gap-2 px-3 py-2 bg-purple-50 border border-purple-200 rounded-lg text-purple-800 hover:bg-purple-100 transition-colors cursor-pointer"
                  data-testid="banner-pending-service-records"
                >
                  <FileSignature className={`${iconSize.sm} shrink-0`} />
                  <span className="text-sm font-medium">
                    {pendingServiceRecordsCount} {pendingServiceRecordsCount === 1 ? "Leistungsnachweis" : "Leistungsnachweise"} zum Unterschreiben
                  </span>
                </div>
              </Link>
            )}

            {monthClosingNeeded && monthClosingReminder && (
              <Link href={`/my-times?year=${monthClosingReminder.year}&month=${monthClosingReminder.month}`}>
                <div
                  className="flex items-start gap-2 px-3 py-2 bg-teal-50 border border-teal-200 rounded-lg text-teal-800 hover:bg-teal-100 transition-colors cursor-pointer"
                  data-testid="banner-month-closing"
                >
                  <CalendarCheck className={`${iconSize.sm} shrink-0 mt-0.5`} />
                  <div className="text-sm">
                    <span className="font-medium">Monatsabschluss {monthClosingReminder.monthName} {monthClosingReminder.year}: </span>
                    <span>Prüfe deine Zeiteinträge und schließe den Monat ab.</span>
                  </div>
                </div>
              </Link>
            )}
          </div>
        )}

        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Eigene Aufgaben
        </h2>

        <Tabs value={filter} onValueChange={(v) => setFilter(v as TaskFilter)} className="mb-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="open" data-testid="tab-open">Offen</TabsTrigger>
            <TabsTrigger value="completed" data-testid="tab-completed">Erledigt</TabsTrigger>
          </TabsList>
        </Tabs>

        {isLoading ? (
          <Card>
            <CardContent className="py-8">
              <div className="flex items-center justify-center">
                <Loader2 className={`${iconSize.lg} animate-spin text-muted-foreground`} />
              </div>
            </CardContent>
          </Card>
        ) : filteredTasks.length === 0 ? (
          <Card>
            <CardContent className="py-8">
              <p className="text-center text-muted-foreground" data-testid="no-tasks-message">
                {filter === "open" ? "Keine offenen Aufgaben" : "Keine erledigten Aufgaben"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-2">
              <div className="divide-y divide-border">
                {filteredTasks.map((task) => (
                  <div key={task.id} className="py-1">
                    <TaskCard
                      task={task}
                      onToggleStatus={handleToggleStatus}
                      onClick={() => setSelectedTask(task)}
                    />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {selectedTask && (
        <TaskDetailSheet
          task={selectedTask}
          open={!!selectedTask}
          onOpenChange={(open) => !open && setSelectedTask(null)}
          onToggleStatus={handleToggleStatus}
        />
      )}
    </Layout>
  );
}
