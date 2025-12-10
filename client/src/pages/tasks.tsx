import { useState } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckSquare, Plus, Loader2, ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { iconSize, componentStyles } from "@/design-system";
import { useTasks, useCreateTask, useToggleTaskStatus, type TaskWithRelations, TaskCard, TaskDetailSheet } from "@/features/tasks";
import { DatePicker } from "@/components/ui/date-picker";

type TaskFilter = "open" | "completed" | "all";

export default function TasksPage() {
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskWithRelations | null>(null);
  
  const includeCompleted = filter === "completed" || filter === "all";
  const { data: tasks, isLoading } = useTasks({ includeCompleted });
  const createTask = useCreateTask();
  const toggleTaskStatus = useToggleTaskStatus();

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
    if (filter === "completed") return task.status === "completed";
    return true;
  }) || [];

  const openCount = tasks?.filter(t => t.status !== "completed").length || 0;
  const completedCount = tasks?.filter(t => t.status === "completed").length || 0;

  return (
    <Layout>
      <div className="animate-in slide-in-from-top-4 duration-500">
<div className={componentStyles.pageHeader}>
          <div className={componentStyles.pageHeaderTop}>
            <Link href="/">
              <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-back">
                <ArrowLeft className={iconSize.sm} />
              </Button>
            </Link>
            <CheckSquare className={`${iconSize.md} text-primary`} />
            <div className={componentStyles.pageHeaderTitleWrap}>
              <h1 className={componentStyles.pageTitle}>Aufgaben</h1>
            </div>
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

        <Tabs value={filter} onValueChange={(v) => setFilter(v as TaskFilter)} className="mb-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="open" data-testid="tab-open">
              Offen
              {openCount > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  {openCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="completed" data-testid="tab-completed">
              Erledigt
              {completedCount > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  {completedCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="all" data-testid="tab-all">
              Alle
            </TabsTrigger>
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
                {filter === "open" && "Keine offenen Aufgaben"}
                {filter === "completed" && "Keine erledigten Aufgaben"}
                {filter === "all" && "Keine Aufgaben vorhanden"}
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
