import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter, DrawerDescription } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CheckSquare, Plus, Calendar, Flag, Loader2, Trash2, Pencil } from "lucide-react";
import { format, parseISO, isToday, isTomorrow, isPast, isValid } from "date-fns";
import { de } from "date-fns/locale";
import { iconSize } from "@/design-system";
import { useTasks, useCreateTask, useToggleTaskStatus, useUpdateTask, useDeleteTask, type TaskWithRelations } from "./use-tasks";
import { useIsMobile } from "@/hooks/use-mobile";

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

interface TaskFormData {
  title: string;
  description: string;
  dueDate: string;
  priority: "low" | "medium" | "high";
}

function TaskForm({ 
  data, 
  onChange, 
  onSubmit, 
  isSubmitting, 
  submitLabel,
  isEdit = false,
  onDelete,
  isDeleting = false
}: {
  data: TaskFormData;
  onChange: (data: TaskFormData) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  submitLabel: string;
  isEdit?: boolean;
  onDelete?: () => void;
  isDeleting?: boolean;
}) {
  return (
    <div className="space-y-4 py-4">
      <div>
        <Label htmlFor="task-form-title">Titel</Label>
        <Input
          id="task-form-title"
          value={data.title}
          onChange={(e) => onChange({ ...data, title: e.target.value })}
          placeholder="Was ist zu tun?"
          data-testid="input-task-title"
        />
      </div>
      <div>
        <Label htmlFor="task-form-description">Beschreibung (optional)</Label>
        <Textarea
          id="task-form-description"
          value={data.description}
          onChange={(e) => onChange({ ...data, description: e.target.value })}
          placeholder="Details zur Aufgabe..."
          rows={3}
          data-testid="input-task-description"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="task-form-due-date">Fällig am</Label>
          <Input
            id="task-form-due-date"
            type="date"
            value={data.dueDate}
            onChange={(e) => onChange({ ...data, dueDate: e.target.value })}
            data-testid="input-task-due-date"
          />
        </div>
        <div>
          <Label htmlFor="task-form-priority">Priorität</Label>
          <Select
            value={data.priority}
            onValueChange={(v) => onChange({ ...data, priority: v as "low" | "medium" | "high" })}
          >
            <SelectTrigger id="task-form-priority" data-testid="select-task-priority">
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
      <div className={`flex ${isEdit ? "justify-between" : ""} gap-2 pt-2`}>
        {isEdit && onDelete && (
          <Button 
            variant="destructive"
            onClick={onDelete}
            disabled={isDeleting}
            data-testid="button-delete-task"
          >
            {isDeleting ? (
              <Loader2 className={`${iconSize.sm} animate-spin mr-2`} />
            ) : (
              <Trash2 className={`${iconSize.sm} mr-2`} />
            )}
            Löschen
          </Button>
        )}
        <Button 
          onClick={onSubmit} 
          disabled={!data.title.trim() || isSubmitting}
          className={isEdit ? "" : "w-full"}
          data-testid="button-save-task"
        >
          {isSubmitting ? (
            <Loader2 className={`${iconSize.sm} animate-spin mr-2`} />
          ) : null}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function TaskDetailSheet({
  task,
  open,
  onOpenChange,
  onToggleStatus,
}: {
  task: TaskWithRelations;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggleStatus?: (id: number, currentStatus: string) => void;
}) {
  const isMobile = useIsMobile();
  const isDesktop = !isMobile;
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  
  const [formData, setFormData] = useState<TaskFormData>({
    title: task.title,
    description: task.description || "",
    dueDate: task.dueDate || "",
    priority: (task.priority as "low" | "medium" | "high") || "medium",
  });

  useEffect(() => {
    if (open) {
      setFormData({
        title: task.title,
        description: task.description || "",
        dueDate: task.dueDate || "",
        priority: (task.priority as "low" | "medium" | "high") || "medium",
      });
    }
  }, [open, task]);

  const handleSave = async () => {
    await updateTask.mutateAsync({
      id: task.id,
      title: formData.title,
      description: formData.description || undefined,
      dueDate: formData.dueDate || undefined,
      priority: formData.priority,
    });
    onOpenChange(false);
  };

  const handleDelete = async () => {
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    await deleteTask.mutateAsync(task.id);
    setShowDeleteConfirm(false);
    onOpenChange(false);
  };

  const handleToggleStatus = () => {
    onToggleStatus?.(task.id, task.status);
    onOpenChange(false);
  };

  const content = (
    <>
      <div className="flex items-center gap-3 mb-4">
        <Checkbox
          checked={task.status === "completed"}
          onCheckedChange={handleToggleStatus}
          className="h-5 w-5"
          data-testid="task-detail-checkbox"
        />
        <span className="text-sm text-muted-foreground">
          {task.status === "completed" ? "Wieder öffnen" : "Als erledigt markieren"}
        </span>
      </div>
      <TaskForm
        data={formData}
        onChange={setFormData}
        onSubmit={handleSave}
        isSubmitting={updateTask.isPending}
        submitLabel="Speichern"
        isEdit={true}
        onDelete={handleDelete}
        isDeleting={deleteTask.isPending}
      />
    </>
  );

  if (isDesktop) {
    return (
      <>
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="sm:max-w-md" data-testid="task-detail-dialog">
            <DialogHeader>
              <DialogTitle>Aufgabe bearbeiten</DialogTitle>
              <DialogDescription>
                Ändern Sie die Details dieser Aufgabe
              </DialogDescription>
            </DialogHeader>
            {content}
          </DialogContent>
        </Dialog>
        <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Aufgabe löschen?</AlertDialogTitle>
              <AlertDialogDescription>
                Möchten Sie diese Aufgabe wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete">Abbrechen</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDelete} data-testid="button-confirm-delete">
                Löschen
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent data-testid="task-detail-drawer">
          <DrawerHeader>
            <DrawerTitle>Aufgabe bearbeiten</DrawerTitle>
            <DrawerDescription>
              Ändern Sie die Details dieser Aufgabe
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4 pb-4">
            {content}
          </div>
        </DrawerContent>
      </Drawer>
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Aufgabe löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              Möchten Sie diese Aufgabe wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} data-testid="button-confirm-delete">
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function TaskCard({ 
  task, 
  onToggleStatus,
  onClick
}: { 
  task: TaskWithRelations;
  onToggleStatus?: (id: number, currentStatus: string) => void;
  onClick?: () => void;
}) {
  const priority = priorityConfig[task.priority as keyof typeof priorityConfig] || priorityConfig.medium;
  const dueDateDisplay = formatDueDate(task.dueDate);
  const isOverdue = isDueDateOverdue(task.dueDate);

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div 
      className="flex items-start gap-3 py-2 border-b border-border last:border-b-0 cursor-pointer hover:bg-muted/50 -mx-2 px-2 rounded transition-colors"
      onClick={onClick}
      data-testid={`task-item-${task.id}`}
    >
      <div onClick={handleCheckboxClick}>
        <Checkbox
          checked={task.status === "completed"}
          onCheckedChange={() => onToggleStatus?.(task.id, task.status)}
          className="mt-0.5"
          data-testid={`task-checkbox-${task.id}`}
        />
      </div>
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
      <Pencil className={`${iconSize.xs} text-muted-foreground shrink-0 mt-1`} />
    </div>
  );
}

export function TaskListSection() {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskWithRelations | null>(null);
  const { data: tasks, isLoading } = useTasks();
  const createTask = useCreateTask();
  const toggleTaskStatus = useToggleTaskStatus();

  const [newTask, setNewTask] = useState<TaskFormData>({
    title: "",
    description: "",
    dueDate: "",
    priority: "medium",
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
    <>
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
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 text-xs" data-testid="button-add-task">
                  <Plus className={iconSize.xs} />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Neue Aufgabe</DialogTitle>
                </DialogHeader>
                <TaskForm
                  data={newTask}
                  onChange={setNewTask}
                  onSubmit={handleCreateTask}
                  isSubmitting={createTask.isPending}
                  submitLabel="Aufgabe erstellen"
                />
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
                  onToggleStatus={handleToggleStatus}
                  onClick={() => setSelectedTask(task)}
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

      {selectedTask && (
        <TaskDetailSheet
          task={selectedTask}
          open={!!selectedTask}
          onOpenChange={(open) => !open && setSelectedTask(null)}
          onToggleStatus={handleToggleStatus}
        />
      )}
    </>
  );
}

