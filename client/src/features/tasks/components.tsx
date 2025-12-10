import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckSquare, Plus, Calendar, User, Flag, Loader2 } from "lucide-react";
import { format, parseISO, isToday, isTomorrow, isPast, isValid } from "date-fns";
import { de } from "date-fns/locale";
import { iconSize, semanticColors } from "@/design-system";
import { useTasks, useCreateTask, useCompleteTask, type TaskWithRelations } from "./use-tasks";

const priorityConfig = {
  low: { label: "Niedrig", color: "bg-gray-100 text-gray-700" },
  medium: { label: "Mittel", color: "bg-blue-100 text-blue-700" },
  high: { label: "Hoch", color: "bg-red-100 text-red-700" },
};

function formatDueDate(dateString: string | null): string | null {
  if (!dateString) return null;
  try {
    const date = parseISO(dateString);
    if (!isValid(date)) return null;
    if (isToday(date)) return "Heute";
    if (isTomorrow(date)) return "Morgen";
    return format(date, "d. MMM", { locale: de });
  } catch {
    return null;
  }
}

function isDueDateOverdue(dateString: string | null): boolean {
  if (!dateString) return false;
  try {
    const date = parseISO(dateString);
    return isValid(date) && isPast(date) && !isToday(date);
  } catch {
    return false;
  }
}

export function TaskCard({ 
  task, 
  onComplete 
}: { 
  task: TaskWithRelations;
  onComplete?: (id: number) => void;
}) {
  const priority = priorityConfig[task.priority as keyof typeof priorityConfig] || priorityConfig.medium;
  const dueDateDisplay = formatDueDate(task.dueDate);
  const isOverdue = isDueDateOverdue(task.dueDate);

  return (
    <div 
      className="flex items-start gap-3 py-2 border-b border-border last:border-b-0"
      data-testid={`task-item-${task.id}`}
    >
      <Checkbox
        checked={task.status === "completed"}
        onCheckedChange={() => onComplete?.(task.id)}
        className="mt-0.5"
        data-testid={`task-checkbox-${task.id}`}
      />
      <div className="flex-1 min-w-0">
        <p 
          className={`text-sm font-medium truncate ${task.status === "completed" ? "line-through text-muted-foreground" : ""}`}
          data-testid={`task-title-${task.id}`}
        >
          {task.title}
        </p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {dueDateDisplay && (
            <span 
              className={`text-xs flex items-center gap-1 ${isOverdue ? "text-red-600 font-medium" : "text-muted-foreground"}`}
              data-testid={`task-due-${task.id}`}
            >
              <Calendar className={iconSize.xs} />
              {dueDateDisplay}
            </span>
          )}
          {task.priority === "high" && (
            <Badge variant="secondary" className={priority.color} data-testid={`task-priority-${task.id}`}>
              <Flag className={`${iconSize.xs} mr-1`} />
              {priority.label}
            </Badge>
          )}
          {task.customer && (
            <span className="text-xs text-muted-foreground truncate max-w-[120px]" data-testid={`task-customer-${task.id}`}>
              {task.customer.name}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function TaskListSection() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { data: tasks, isLoading } = useTasks();
  const createTask = useCreateTask();
  const completeTask = useCompleteTask();

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
    setIsDialogOpen(false);
  };

  const handleCompleteTask = async (id: number) => {
    await completeTask.mutateAsync(id);
  };

  const openTasks = tasks?.filter(t => t.status !== "completed") || [];

  if (isLoading) {
    return (
      <Card className="mt-4" data-testid="tasks-section">
        <CardContent className="py-4">
          <div className="flex items-center justify-center py-4">
            <Loader2 className={`${iconSize.md} animate-spin text-muted-foreground`} />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-4" data-testid="tasks-section">
      <CardContent className="py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <CheckSquare className={`${iconSize.sm} text-primary`} />
            <h3 className="font-semibold text-sm">Meine Aufgaben</h3>
            {openTasks.length > 0 && (
              <Badge variant="secondary" className="text-xs" data-testid="task-count">
                {openTasks.length}
              </Badge>
            )}
          </div>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 text-xs" data-testid="button-add-task">
                <Plus className={iconSize.xs} />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Neue Aufgabe</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div>
                  <Label htmlFor="task-title">Titel</Label>
                  <Input
                    id="task-title"
                    value={newTask.title}
                    onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                    placeholder="Was ist zu tun?"
                    data-testid="input-task-title"
                  />
                </div>
                <div>
                  <Label htmlFor="task-description">Beschreibung (optional)</Label>
                  <Textarea
                    id="task-description"
                    value={newTask.description}
                    onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                    placeholder="Details zur Aufgabe..."
                    rows={2}
                    data-testid="input-task-description"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="task-due-date">Fällig am</Label>
                    <Input
                      id="task-due-date"
                      type="date"
                      value={newTask.dueDate}
                      onChange={(e) => setNewTask({ ...newTask, dueDate: e.target.value })}
                      data-testid="input-task-due-date"
                    />
                  </div>
                  <div>
                    <Label htmlFor="task-priority">Priorität</Label>
                    <Select
                      value={newTask.priority}
                      onValueChange={(v) => setNewTask({ ...newTask, priority: v as "low" | "medium" | "high" })}
                    >
                      <SelectTrigger id="task-priority" data-testid="select-task-priority">
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
                  data-testid="button-save-task"
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

        {openTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4" data-testid="no-tasks-message">
            Keine offenen Aufgaben
          </p>
        ) : (
          <div className="space-y-0">
            {openTasks.slice(0, 5).map((task) => (
              <TaskCard 
                key={task.id} 
                task={task} 
                onComplete={handleCompleteTask}
              />
            ))}
            {openTasks.length > 5 && (
              <Link href="/tasks">
                <Button variant="ghost" size="sm" className="w-full mt-2 text-xs" data-testid="link-all-tasks">
                  Alle {openTasks.length} Aufgaben anzeigen
                </Button>
              </Link>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
